import { access, lstat, stat, mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { constants, lstatSync, rmdirSync, unlinkSync, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { safeRelative, isMissing, isPermissionError, sharedSkillPresent } from './paths.js';
import { updateSection } from './markers.js';
import { PresetsError, SkipFileError } from './types.js';
import { appendExisting, leftoverTemps, liveExclusiveFiles, liveTemps, readExisting, sameFile, writeAtomic } from './write-file.js';
import type { WriteRequest, WriteResponse } from './writer-client.js';

import type { InstallResult } from './install.js';

type Identity = Pick<Stats, 'dev' | 'ino'>;

async function enterDirectory(name: string): Promise<void> {
  let before;
  try { before = await lstat(name); }
  catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(name).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    before = await lstat(name);
  }
  if (before.isSymbolicLink()) throw new PresetsError(`Refusing symlink: ${name}`);
  if (!before.isDirectory()) throw new SkipFileError('skipped (parent folder is a file)');
  process.chdir(name);
  if (!sameFile(before, await stat('.'))) throw new PresetsError(`Directory changed while opening: ${name}`);
}

async function pinParent(request: WriteRequest, target: string): Promise<() => Promise<void>> {
  safeRelative(target);
  const root = await lstat(request.root);
  if (root.isSymbolicLink() || !root.isDirectory() || !sameFile(root, request.identity)) throw new PresetsError('Project directory changed during installation.');
  process.chdir(request.root);
  if (!sameFile(await stat('.'), request.identity)) throw new PresetsError('Project directory changed during installation.');
  // chain[0] is the project root; chain[n] is the pinned working directory.
  const chain: Identity[] = [request.identity];
  for (const part of target.split('/').slice(0, -1)) {
    await enterDirectory(part);
    chain.push(await stat('.'));
  }
  const pinned = chain[chain.length - 1];
  return async () => {
    // Walk up with '..' from the pinned directory. '..' follows each directory's
    // real parent rather than a path name, so a parent moved out of the project
    // and replaced by a symlink is caught at any depth, not only the last one.
    for (let up = 0; up < chain.length; up++) {
      const current = await stat(up === 0 ? '.' : Array(up).fill('..').join('/'));
      if (!sameFile(current, chain[chain.length - 1 - up])) throw new PresetsError(`Project directory changed during installation: ${target}`);
    }
    const named = await lstat(path.dirname(path.join(request.root, target)));
    if (named.isSymbolicLink() || !sameFile(named, pinned)) throw new PresetsError(`Project directory changed during installation: ${target}`);
  };
}

// Cleanup stays relative to the pinned cwd, even if its original path moves.
let heldLock: string | undefined;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, () => {
    for (const [file, identity] of liveExclusiveFiles) {
      try { if (sameFile(lstatSync(file), identity)) unlinkSync(file); } catch { /* already gone or replaced */ }
    }
    // Without this, Ctrl-C skips the finally that releases the lock and every
    // later install of the same file fails as busy until it is removed by hand.
    if (heldLock) {
      try { unlinkSync(path.join(heldLock, LOCK_OWNER)); } catch { /* not written yet */ }
      try { rmdirSync(heldLock); } catch { /* already gone */ }
    }
    // A temp file may already be linked as the target; leaving it would give
    // the target a second link that every later append refuses.
    for (const temp of liveTemps) { try { unlinkSync(temp); } catch { /* already gone */ } }
    process.exit(128 + os.constants.signals[signal]);
  });
}

// A lock is a folder holding its owner's pid. A crash or SIGKILL skips every
// cleanup path, so a later run breaks a lock whose owner is gone, or one older
// than any real write (sections are written after all downloads finish).
const LOCK_OWNER = 'owner';
const STALE_LOCK_MS = 30_000;

function ownerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

// Undefined when the lock is gone or still held. Age is checked once per run,
// so a lock held by a live installer is never broken while we wait for it.
async function staleLock(lock: string, checkAge: boolean): Promise<Stats | undefined> {
  const info = await lstat(lock).catch((error: unknown) => { if (isMissing(error)) return undefined; throw error; });
  if (!info?.isDirectory()) return undefined;
  const owner = Number.parseInt(await readFile(path.join(lock, LOCK_OWNER), 'utf8').catch(() => ''), 10);
  if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && !ownerAlive(owner)) return info;
  return checkAge && Date.now() - info.mtimeMs > STALE_LOCK_MS ? info : undefined;
}

async function breakLock(lock: string, seen: Stats): Promise<void> {
  // Move it aside first, so two runs breaking the same lock can't both win,
  // and never move a lock that was replaced since it was judged stale.
  const current = await lstat(lock).catch(() => undefined);
  if (!current || !sameFile(current, seen)) return;
  const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
  try { await rename(lock, aside); }
  catch (error) { if (isMissing(error)) return; throw error; }
  await rm(aside, { recursive: true, force: true });
}

async function lockSection(file: string): Promise<() => Promise<void>> {
  const lock = `.presets-${file}.lock`;
  const deadline = Date.now() + 5_000;
  let checkAge = true;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stale = await staleLock(lock, checkAge);
      checkAge = false;
      if (stale) { await breakLock(lock, stale); continue; }
      if (Date.now() >= deadline) throw new PresetsError(`Installation is busy: ${file}. If no installer is running, remove the stale ${lock} directory and retry.`);
      await delay(25);
    }
  }
  heldLock = lock;
  await writeFile(path.join(lock, LOCK_OWNER), String(process.pid));
  return async () => {
    await unlink(path.join(lock, LOCK_OWNER)).catch((error: unknown) => { if (!isMissing(error)) throw error; });
    await rmdir(lock);
    heldLock = undefined;
  };
}

// Sections are spliced as latin1, which maps every byte to one code unit and
// back unchanged. Markers are ASCII, so user bytes that are not valid UTF-8
// survive a forced replacement exactly.
async function writeSection(name: string, content: Buffer, stack: string, force: boolean, onPublished: (action: InstallResult['action']) => void): Promise<InstallResult['action']> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readExisting(name);
    const section = updateSection(before?.bytes.toString('latin1') ?? '', content.toString('latin1'), stack, force);
    if (section.skipped) return 'skipped (exists)';
    if (before && section.append !== undefined) {
      if (await appendExisting(name, Buffer.from(section.append, 'latin1'), before, () => onPublished('appended'))) return 'appended';
      continue;
    }
    const action = before === undefined ? 'created' : 'replaced';
    if (await writeAtomic(name, Buffer.from(section.text, 'latin1'), before !== undefined, before?.mode, before, () => onPublished(action))) {
      return action;
    }
  }
  throw new PresetsError(`File kept changing during installation: ${name}. Retry when other editors have finished saving.`);
}

// A symlink is refused before anything else, so one planted while writing
// stops the install instead of passing as a permission skip.
async function inspectTarget(name: string): Promise<Stats | undefined> {
  const info = await lstat(name).catch((error: unknown) => { if (isMissing(error)) return undefined; throw error; });
  if (info?.isSymbolicLink()) throw new PresetsError(`Refusing symlink: ${name}`);
  return info;
}

// access() catches read-only files everywhere and read-only folders on POSIX.
// Windows reports every folder as writable, so a folder denied by its ACL is
// only caught if the write itself fails with a permission error.
async function writable(name: string, current: Stats | undefined): Promise<boolean> {
  const denied = (target: string) => access(target, constants.W_OK).then(() => false, (error: unknown) => !isMissing(error));
  return !(await denied('.') || (current !== undefined && await denied(name)));
}

// Results are pushed into the caller's array so a later failure can still
// report the files that were already written.
async function execute(request: WriteRequest, results: InstallResult[]): Promise<void> {
  if (!sameFile(await stat('.'), request.identity)) throw new PresetsError('Project directory changed during installation.');
  // Decided once per skill, so a shared copy appearing mid-run can't leave a
  // tool's own copy half-written. Shared copies are committed first, so the
  // decision already sees the ones this run wrote.
  const sharedSeen = new Map<string, boolean>();
  for (const { file, content } of request.files) {
    // Every outcome, skip or write, is recorded once in finally.
    let action: InstallResult['action'] | undefined;
    let published = false;
    let release = async () => {};
    try {
      // Before pinning, which creates folders the skipped copy doesn't need.
      if (file.sharedSkill) {
        if (!sharedSeen.has(file.sharedSkill)) sharedSeen.set(file.sharedSkill, await sharedSkillPresent(request.root, file.sharedSkill));
        if (sharedSeen.get(file.sharedSkill)) { action = 'skipped (shared skill already present)'; continue; }
      }
      const verifyParent = await pinParent(request, file.target);
      const name = path.posix.basename(file.target);
      await verifyParent();
      let current = await inspectTarget(name);
      // An earlier run killed mid-publish can leave our temp file linked to
      // the target; it is ours to remove, and would otherwise block the file.
      if (current?.isFile() && current.nlink > 1) {
        const temps = await leftoverTemps('.', current);
        for (const temp of temps) await unlink(temp).catch((error: unknown) => { if (!isMissing(error)) throw error; });
        if (temps.length) current = await inspectTarget(name);
      }
      if (current && !current.isFile()) { action = 'skipped (not a regular file)'; continue; }
      if (file.mode === 'file' && current && !request.force) { action = 'skipped (exists)'; continue; }
      // Checked before the section lock, whose folder needs write access too.
      if (!await writable(name, current)) { action = 'skipped (permission denied)'; continue; }
      const bytes = Buffer.from(content, 'base64');
      const onPublished = (done: InstallResult['action']) => { action = done; published = true; };
      if (file.mode === 'section') {
        // The section lock covers fresh reads, append/replacement, and retries.
        release = await lockSection(name);
        action = await writeSection(name, bytes, file.stack, request.force, onPublished);
      } else {
        const done = current ? 'replaced' : 'created';
        const written = await writeAtomic(name, bytes, current !== undefined, current && current.mode & 0o7777, undefined, () => onPublished(done));
        action = written ? done : 'skipped (exists)';
      }
      await verifyParent();
    } catch (error) {
      // A refusal about this file alone becomes a skip when nothing was
      // published; safety failures and later errors still stop the install.
      // A permission error before anything was published writes nothing, so
      // it is a skip wherever it happens. Swapped folders and symlinks are
      // caught by the identity checks, which still stop the install.
      if (!published && error instanceof SkipFileError) { action = error.action; continue; }
      if (!published && isPermissionError(error, { writing: true })) { action = 'skipped (permission denied)'; continue; }
      if (error instanceof SkipFileError) throw new PresetsError(`${file.target}: ${error.action} after a partial write`);
      if (error instanceof PresetsError) throw error;
      throw new PresetsError(`${file.target}: ${(error as Error).message}`);
    } finally {
      // Preserve completed writes even when cleanup or verification fails.
      if (action !== undefined) results.push({ path: file.target, action });
      await release();
    }
  }
}

const results: InstallResult[] = [];
let response: WriteResponse;
try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  await execute(JSON.parse(Buffer.concat(chunks).toString('utf8')) as WriteRequest, results);
  response = { results };
} catch (error) {
  response = { results, error: { message: (error as Error).message, exitCode: error instanceof PresetsError ? error.exitCode : 1 } };
  process.exitCode = 1;
}
console.log(JSON.stringify(response));
