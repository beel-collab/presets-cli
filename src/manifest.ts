import { ContentClient, MANIFEST_PATH } from './fetch.js';
import { classifyPath } from './paths.js';
import { createPlan } from './plan.js';
import { PresetsError, TOOLS, type Manifest, type Stack, type Tool, type Entry } from './types.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const INVALID_STATUS = 'invalid';

// Dangerous paths disable the stack. Merely unusual names are reported as
// unsupported by the plan, so one odd supporting file cannot block a stack.
function validExport(file: unknown): file is string {
  return typeof file === 'string' && classifyPath(file) !== 'dangerous';
}

// Returns undefined when any in-scope entry is malformed.
function parseEntries(raw: unknown): Entry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const entries: Entry[] = [];
  for (const entry of raw) {
    if (!record(entry)) return undefined;
    // Agent presets are deliberately outside v1's scope.
    if (entry.role !== 'standards' && entry.role !== 'skill') continue;
    if (typeof entry.tool !== 'string') return undefined;
    // A live manifest can add tools before installed CLIs support them.
    if (!TOOLS.includes(entry.tool as Tool)) continue;
    // Only fields the CLI reads are validated, so unrelated content changes
    // (catalog paths, release labels) cannot disable a stack.
    if (!Array.isArray(entry.exports) || !entry.exports.every(validExport)) return undefined;
    entries.push({ tool: entry.tool as Tool, role: entry.role, exports: entry.exports });
  }
  return entries;
}

// The manifest is read live from the content repo by every published CLI, so a
// single bad stack only disables that stack; it must not break the others.
export function parseManifest(input: unknown): Manifest {
  if (!record(input) || !Array.isArray(input.stacks)) {
    throw new PresetsError('Invalid presets manifest. Expected stacks with native exports.');
  }
  const seen = new Set<string>();
  const stacks: Stack[] = [];
  for (const stack of input.stacks) {
    if (!record(stack) || typeof stack.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stack.id) || seen.has(stack.id)) continue;
    seen.add(stack.id);
    const entries = parseEntries(stack.entries);
    if (typeof stack.status !== 'string' || !entries) stacks.push({ id: stack.id, status: INVALID_STATUS, entries: [] });
    else stacks.push({ id: stack.id, status: stack.status, entries });
  }
  return { stacks };
}

export async function loadManifest(client: ContentClient): Promise<Manifest> {
  const file = process.env.PRESETS_MANIFEST || MANIFEST_PATH;
  const bytes = await client.download(file);
  let input: unknown;
  try { input = JSON.parse(bytes.toString('utf8')); }
  catch { throw new PresetsError(`Invalid JSON manifest: ${client.url(file)}`); }
  return parseManifest(input);
}

// Built from the same plan `add` uses, so list never offers what add skips.
export function listStacks(manifest: Manifest, tool?: Tool): { id: string; skills: string[] }[] {
  const tools = tool ? [tool] : [...TOOLS];
  return manifest.stacks.filter((stack) => stack.status === 'complete')
    .map((stack) => ({ id: stack.id, files: createPlan([stack], tools).files }))
    .filter(({ files }) => files.length > 0)
    .map(({ id, files }) => ({
      id,
      skills: [...new Set(files.flatMap((file) => file.skill && file.target.endsWith(`/${file.skill}/SKILL.md`) ? [file.skill] : []))],
    }));
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])));
    row = next;
  }
  return row[b.length];
}

export function selectStacks(manifest: Manifest, ids: string[]): Stack[] {
  return [...new Set(ids)].map((id) => {
    const stack = manifest.stacks.find((item) => item.id === id);
    if (!stack) {
      // Only near misses are worth suggesting; 'zzz' should not offer vue, go and mcp.
      const cutoff = Math.max(2, Math.ceil(id.length / 3));
      const suggestions = manifest.stacks.filter((item) => item.status === 'complete')
        .map((item) => ({ id: item.id, distance: distance(id, item.id) }))
        .filter((item) => item.distance <= cutoff)
        .sort((a, b) => a.distance - b.distance).slice(0, 3).map((item) => item.id);
      throw new PresetsError(`Unknown stack "${id}".${suggestions.length ? ` Did you mean ${suggestions.join(', ')}?` : ''} Run presets-dev list.`);
    }
    if (stack.status === INVALID_STATUS) throw new PresetsError(`Stack "${id}" has invalid manifest data and cannot be installed. Try again later.`);
    if (stack.status !== 'complete') throw new PresetsError(`Stack "${id}" is not complete and cannot be installed.`);
    return stack;
  });
}
