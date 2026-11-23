import { access, lstat, stat, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { blockerOnPath, destination, fileAt, isMissing, isPermissionError, isUnseen, sharedSkillPresent, type Blocker } from './paths.js';
import { containsMarkers, sectionMarkers, updateSection } from './markers.js';
import { isSkipped, PresetsError, SkipFileError, usesShared, type SkipAction } from './types.js';
import type { FileAction, Plan } from './plan.js';
import { commitFiles } from './writer-client.js';
import { leftoverTemps } from './write-file.js';

export interface InstallOptions { dryRun?: boolean; force?: boolean }
type WriteAction = 'created' | 'appended' | 'replaced';
type Action = WriteAction | SkipAction | 'would create' | 'would append' | 'would replace';
export interface InstallResult { path: string; action: Action }
type Download = (source: string) => Promise<Buffer>;

// Read-only probes may follow parent links, including shared dotfiles folders.
// The writer separately validates and pins every directory used for writes.
async function probe(root: string, target: string) {
  try { return await lstat(destination(root, target)); }
  catch (error) {
    // Left to the blocker walk, which reports such a target as its own skip.
    if (isUnseen(error)) return undefined;
    throw error;
  }
}

const writable = (file: string) => access(file, constants.W_OK).then(() => true, () => false);

// Mirrors the writer, which needs write access to the target's folder (or the
// nearest one that exists and will hold the new folders). Windows reports
// every folder as writable, so there only the writer can catch a denied one.
async function folderWritable(root: string, target: string): Promise<boolean> {
  let folder = path.dirname(destination(root, target));
  for (;;) {
    const info = await stat(folder).catch((error: unknown) => { if (isMissing(error)) return undefined; throw error; });
    if (info) return writable(folder);
    folder = path.dirname(folder);
  }
}

// bytes is only read for sections; readable is false when that read is denied.
interface Existing { bytes?: Buffer; readable: boolean; links: number; writable: boolean }

// Only called for targets without a blocker; the writer re-checks everything.
async function readExisting(root: string, file: FileAction): Promise<Existing | undefined> {
  const info = await probe(root, file.target);
  if (!info?.isFile()) return undefined;
  const name = destination(root, file.target);
  // The writer removes our own leftover temp links before writing.
  const links = info.nlink > 1 ? info.nlink - (await leftoverTemps(path.dirname(name), info)).length : info.nlink;
  const existing: Existing = { readable: true, links, writable: await writable(name) };
  if (file.mode === 'section') {
    try { existing.bytes = await readFile(name); }
    catch (error) { if (!isPermissionError(error)) throw error; existing.readable = false; }
  }
  return existing;
}

const blockerSkips: Record<Blocker, SkipAction> = {
  'not-a-folder': 'skipped (parent folder is a file)',
  'not-a-file': 'skipped (not a regular file)',
  denied: 'skipped (permission denied)',
  parent: 'skipped (folder is a symlink)',
  target: 'skipped (file is a symlink)',
};

function sectionAction(existing: Buffer | undefined, stack: string): WriteAction {
  if (existing === undefined) return 'created';
  return existing.toString('latin1').includes(sectionMarkers(stack).start) ? 'replaced' : 'appended';
}

function preview(action: Action): Action {
  switch (action) {
    case 'created': return 'would create';
    case 'appended': return 'would append';
    case 'replaced': return 'would replace';
    default: return action;
  }
}

async function downloadAll(sources: string[], download: Download): Promise<Map<string, Buffer>> {
  const unique = [...new Set(sources)];
  const downloads = new Map<string, Buffer>();
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(6, unique.length) }, async () => {
    while (!failure && next < unique.length) {
      const source = unique[next++];
      try { downloads.set(source, await download(source)); }
      catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw failure.error;
  return downloads;
}

// A tool's own skill copy is covered once this run's shared SKILL.md lands,
// judged from that file's own result so dry and real runs agree. This matches
// a shared skill that was already present, which outranks every other skip.
// Real runs relabel only skips, as the writer already skipped any copy whose
// shared skill had landed; dry runs also relabel predicted writes.
function coverSharedCopies(entries: { file: FileAction; result: InstallResult }[], dryRun: boolean): void {
  const landed = new Set(entries.filter(({ result }) => result.action === 'created' || result.action === 'replaced')
    .map(({ file }) => file.target));
  for (const { file, result } of entries) {
    if (!file.sharedSkill || !landed.has(`${file.sharedSkill}/SKILL.md`)) continue;
    if (dryRun || isSkipped(result.action)) result.action = usesShared(file.sharedSkill);
  }
}

export async function install({ files: plan, unsupported }: Plan, cwd: string, download: Download, options: InstallOptions = {}): Promise<InstallResult[]> {
  const root = await realpath(cwd);
  const identity = await lstat(root);
  if (!identity.isDirectory()) throw new PresetsError(`Not a project directory: ${cwd}`);
  // Writes through a symlink, under a file or onto a non-file are refused, so
  // such a target is skipped rather than failing the other tools' installs;
  // the writer still refuses at write time. Blockers are found once per
  // target, before any other skip decision.
  const blockers = new Map<string, Blocker | undefined>();
  await Promise.all([...new Set(plan.map((file) => file.target))].map(async (target) => {
    blockers.set(target, await blockerOnPath(root, target));
  }));
  // A skill already in .agents/skills skips the tool's own copy here. One this
  // run writes is handled by coverSharedCopies once its result is known.
  const shared = new Set<string>();
  const sharedProbes = [...new Set(plan.flatMap((file) => file.sharedSkill ? [file.sharedSkill] : []))];
  await Promise.all(sharedProbes.map(async (skill) => {
    if (await sharedSkillPresent(root, skill)) shared.add(skill);
  }));
  // Only a .clinerules that resolves to a regular file is a legacy rules file
  // (readable or not); anything else is left to the blocker walk's skips.
  const legacyCline = plan.some((file) => file.target.startsWith('.clinerules/')) && await fileAt(root, '.clinerules');
  const reads = new Map<string, Promise<Existing | undefined>>();
  const checked = await Promise.all(plan.map(async (file) => {
    const blocker = blockers.get(file.target);
    let skip: SkipAction | undefined;
    if (file.sharedSkill && shared.has(file.sharedSkill)) skip = usesShared(file.sharedSkill);
    else if (legacyCline && file.target.startsWith('.clinerules/')) skip = 'skipped (legacy .clinerules file)';
    // AGENTS.md -> CLAUDE.md and GEMINI.md -> AGENTS.md are common setups.
    else if (file.mode === 'section' && blocker === 'target') {
      skip = file.target === 'GEMINI.md' ? 'skipped (GEMINI.md is a symlink; use --agents-md)' : 'skipped (AGENTS.md is a symlink)';
    }
    // These make the exists check impossible or meaningless, so they rank first.
    else if (blocker === 'not-a-folder' || blocker === 'not-a-file' || blocker === 'denied') skip = blockerSkips[blocker];
    else if (file.mode === 'file' && !options.force && await probe(root, file.target)) skip = 'skipped (exists)';
    else if (blocker) skip = blockerSkips[blocker];
    if (skip) return { file, skip, existing: undefined, folderOk: true };
    if (!reads.has(file.target)) reads.set(file.target, readExisting(root, file));
    return { file, skip, existing: await reads.get(file.target), folderOk: await folderWritable(root, file.target) };
  }));
  const results: InstallResult[] = [];
  const entries: { file: FileAction; result: InstallResult }[] = [];
  const pending: typeof entries = [];
  const virtual = new Map<string, Buffer | undefined>();
  for (const { file, skip, existing, folderOk } of checked) {
    let action: WriteAction | SkipAction;
    let updated: string | undefined;
    if (skip) action = skip;
    else if (existing && !existing.readable) action = 'skipped (permission denied)';
    else if (file.mode === 'section') {
      const bytes = virtual.has(file.target) ? virtual.get(file.target) : existing?.bytes;
      try {
        // Decoded as latin1, exactly as the writer does.
        const section = updateSection(bytes?.toString('latin1') ?? '', '', file.stack, options.force);
        action = section.skipped ? 'skipped (exists)' : sectionAction(bytes, file.stack);
        updated = section.text;
      } catch (error) {
        if (!(error instanceof SkipFileError)) throw error;
        action = error.action;
      }
    } else action = existing === undefined ? 'created' : 'replaced';
    // The writer refuses to write without permission or to change a file
    // hard-linked elsewhere, so skip those here too and let dry runs show it.
    if (action === 'created' || action === 'appended' || action === 'replaced') {
      if (!folderOk || (existing && !existing.writable)) action = 'skipped (permission denied)';
      else if (existing && existing.links > 1) action = 'skipped (file is hard-linked)';
    }
    if (updated !== undefined && !isSkipped(action)) virtual.set(file.target, Buffer.from(updated, 'latin1'));
    const result: InstallResult = { path: file.target, action };
    results.push(result);
    entries.push({ file, result });
    if (!isSkipped(action)) pending.push({ file, result });
  }
  for (const { source } of unsupported) results.push({ path: source, action: 'skipped (needs a newer presets-dev)' });
  if (options.dryRun) {
    coverSharedCopies(entries, true);
    return results.map((result) => ({ ...result, action: preview(result.action) }));
  }
  // Bound network concurrency, cache sources, and finish all downloads before writes.
  const downloads = await downloadAll(pending.map(({ file }) => file.source), download);
  // A content-repo mistake must not leave markers that block every later run.
  // Dry runs do not download, so only real runs can report this skip.
  const commit: typeof pending = [];
  for (const entry of pending) {
    if (entry.file.mode === 'section' && containsMarkers(downloads.get(entry.file.source)!.toString('latin1'))) {
      entry.result.action = 'skipped (export contains presets.dev markers)';
    } else commit.push(entry);
  }
  // Shared .agents skills go first, so the writer knows whether they landed
  // before it decides on each tool's own copy.
  commit.sort((a, b) => Number(!a.file.target.startsWith('.agents/skills/')) - Number(!b.file.target.startsWith('.agents/skills/')));
  if (commit.length) {
    const committed = await commitFiles({
      root, identity: { dev: identity.dev, ino: identity.ino }, force: Boolean(options.force),
      files: commit.map(({ file }) => ({ file, content: downloads.get(file.source)!.toString('base64') })),
    });
    // The writer answers once per file, in order; anything else would put
    // labels on the wrong files.
    if (committed.length !== commit.length || committed.some((result, index) => result.path !== commit[index].file.target)) {
      throw new PresetsError(`Preset writer returned ${committed.length} results for ${commit.length} files.`);
    }
    for (const [index, result] of committed.entries()) commit[index].result.action = result.action;
  }
  coverSharedCopies(entries, false);
  return results;
}
