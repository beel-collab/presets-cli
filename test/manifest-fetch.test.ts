import { describe, expect, it, vi } from 'vitest';
import { ContentClient, RAW_BASE } from '../src/fetch.js';
import { listStacks, loadManifest, parseManifest, selectStacks } from '../src/manifest.js';
import { parseTools } from '../src/types.js';
import { fixtureManifest, fixtureStack } from './fixtures/manifest.js';

describe('manifest and HTTP boundary', () => {
  it('parses the dynamic manifest and lists complete stacks with skill names', () => {
    const manifest = parseManifest(fixtureManifest());
    expect(listStacks(manifest)).toEqual([
      { id: 'nextjs', skills: ['nextjs-code-review'] }, { id: 'react', skills: ['react-code-review'] },
    ]);
    manifest.stacks[1].entries = manifest.stacks[1].entries.filter((entry) => entry.tool !== 'cursor');
    expect(listStacks(manifest, 'cursor')).toHaveLength(1);
    expect(() => selectStacks(manifest, ['nextj'])).toThrow(/Did you mean nextjs.*presets-dev list/);
    expect(() => selectStacks(manifest, ['zzz'])).toThrow(/^Unknown stack "zzz"\. Run presets-dev list\.$/);
    expect(() => selectStacks(manifest, ['unfinished'])).toThrow('not complete');
    expect(selectStacks(manifest, ['nextjs', 'nextjs'])).toHaveLength(1);
  });
  it('uses the configured manifest path and pinned ref', async () => {
    vi.stubEnv('PRESETS_MANIFEST', 'release/future/stacks.json');
    try {
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixtureManifest())));
      await loadManifest(new ContentClient('v1.0', request));
      expect(request).toHaveBeenCalledWith(`${RAW_BASE}v1.0/release/future/stacks.json`, expect.objectContaining({ redirect: 'error' }));
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(['../main', '/main', 'https://evil.test', 'main?query', '', 'a//b', 'main/', '.hidden', 'a.lock', 'a@{b', 'a..b', 'a.', '@', 'bad ref', 'bad\nref', 'a\\b', 'a~b', 'a^b', 'a:b', 'a*b', 'a[b'])('rejects unsafe refs: %s', (ref) => {
    expect(() => new ContentClient(ref)).toThrow();
  });
  it.each([
    ['v1.0.0+build.1', 'v1.0.0%2Bbuild.1'],
    ['release/#stable', 'release/%23stable'],
    ['v1%release', 'v1%25release'],
    ['release]1', 'release%5D1'],
    ['版本1', '%E7%89%88%E6%9C%AC1'],
  ])('accepts and URL-encodes valid Git ref %s', async (ref, encoded) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('export'));
    await new ContentClient(ref, request).download('file.md');
    expect(request).toHaveBeenCalledWith(`${RAW_BASE}${encoded}/file.md`, expect.anything());
  });
  it('permits branch refs containing slashes and preserves bytes', async () => {
    const bytes = new Uint8Array([0, 255, 13, 10]);
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes));
    expect(await new ContentClient('release/v1', request).download('file.md')).toEqual(Buffer.from(bytes));
    expect(request.mock.calls[0][0]).toBe(`${RAW_BASE}release/v1/file.md`);
  });
  it.each([new Response('', { status: 404 }), new Response('', { status: 302, headers: { location: 'https://evil.test' } })])('reports HTTP failures with URL and exit 2', async (response) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(new ContentClient('main', request).download('file.md')).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining(`${RAW_BASE}main/file.md`) });
  });
  it('falls back to the default manifest when PRESETS_MANIFEST is empty', async () => {
    vi.stubEnv('PRESETS_MANIFEST', '');
    try {
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixtureManifest())));
      await loadManifest(new ContentClient('main', request));
      expect(request.mock.calls[0][0]).toMatch(/stacks\.json$/);
    } finally { vi.unstubAllEnvs(); }
  });
  it('releases the body of a failed response', async () => {
    const response = new Response('Not found', { status: 404 });
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(new ContentClient('main', request).download('file.md')).rejects.toMatchObject({ exitCode: 2 });
    expect(response.bodyUsed || response.body?.locked).toBeTruthy();
  });
  it('reports network failures with exit 2', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    await expect(new ContentClient('main', request).download('file.md')).rejects.toMatchObject({ exitCode: 2 });
  });
  it.each([null, {}, { stacks: {} }, []])('rejects malformed manifests', (input) => {
    expect(() => parseManifest(input)).toThrow('Invalid presets manifest');
  });
  it('skips stacks without a usable id and keeps the rest installable', () => {
    const manifest = fixtureManifest();
    const input = { ...manifest, stacks: [{}, { id: '../bad', status: 'complete', entries: [] }, { id: 'next_js' }, ...manifest.stacks, { ...fixtureStack(), status: 'draft' }] };
    expect(parseManifest(input)).toEqual(manifest);
  });
  it('rejects invalid JSON and ignores out-of-scope agent entries', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{broken'));
    await expect(loadManifest(new ContentClient('main', request))).rejects.toThrow('Invalid JSON');
    const manifest = fixtureManifest();
    const input = { ...manifest, stacks: [{ ...manifest.stacks[0], entries: [{ role: 'agent' }] }] };
    expect(parseManifest(input).stacks[0].entries).toEqual([]);
  });
  it('validates tool ids with a helpful error', () => {
    expect(parseTools('cursor, codex,cursor')).toEqual(['cursor', 'codex']);
    expect(() => parseTools('unknown')).toThrow('Valid tools: cursor, copilot, claude, windsurf, cline, codex, antigravity');
  });

  it('ignores future tools while retaining known-tool entries and installable stacks', () => {
    const original = fixtureManifest();
    const manifest = {
      ...original,
      stacks: original.stacks.map((stack) => ({ ...stack, entries: [...stack.entries, { tool: 'zed', role: 'standards', exports: ['future/export.md'] }] })),
    };
    const parsed = parseManifest(manifest);
    expect(parsed).toEqual(original);
    expect(listStacks(parsed, 'cursor')).toHaveLength(2);
    expect(selectStacks(parsed, ['nextjs'])).toHaveLength(1);
  });

  it.each<[string, (entry: Record<string, unknown>) => unknown]>([
    ['missing tool', (entry) => ({ ...entry, tool: undefined })],
    ['numeric tool', (entry) => ({ ...entry, tool: 123 })],
    ['unsafe export', (entry) => ({ ...entry, exports: ['../escape.md'] })],
    ['non-object entry', () => null],
  ])('disables only the stack with a malformed entry: %s', (_, mutate) => {
    const manifest = fixtureManifest();
    const [first, ...rest] = manifest.stacks;
    const input = { ...manifest, stacks: [{ ...first, entries: [mutate({ ...first.entries[0] }), ...first.entries.slice(1)] }, ...rest] };
    const parsed = parseManifest(input);
    expect(listStacks(parsed).map((stack) => stack.id)).toEqual(['react']);
    expect(() => selectStacks(parsed, ['nextjs'])).toThrow('invalid manifest data');
    expect(selectStacks(parsed, ['react'])).toHaveLength(1);
  });

  it('keeps stacks with unusually named or empty exports installable', () => {
    const manifest = fixtureManifest();
    const [first, ...rest] = manifest.stacks;
    const odd = 'release/nextjs/native/claude/.claude/skills/nextjs-code-review/references/api+v2 caf\u00e9.md';
    const folder = 'release/nextjs/native/claude/.claude/skills/nextjs-code-review/assets/';
    const input = { stacks: [{ ...first, entries: [{ ...first.entries[0], exports: [] }, ...first.entries.slice(1).map((entry, index) => index === 0 ? { ...entry, exports: [...entry.exports, odd, folder] } : entry)] }, ...rest] };
    const parsed = parseManifest(input);
    expect(selectStacks(parsed, ['nextjs'])).toHaveLength(1);
    expect(parsed.stacks[0].entries[0].exports).toEqual([]);
  });

  it('disables a stack whose export would control the terminal, and keeps others', () => {
    const manifest = fixtureManifest();
    manifest.stacks[0].entries[0].exports.push('release/nextjs/native/cursor/.cursor/rules/a.mdc\ncreated .cursor/rules/evil.mdc');
    const parsed = parseManifest(manifest);
    expect(() => selectStacks(parsed, ['nextjs'])).toThrow('invalid manifest data');
    expect(selectStacks(parsed, ['react'])).toHaveLength(1);
  });

  it('lists only what add would install', () => {
    const manifest = fixtureManifest();
    const cursorSkill = manifest.stacks[0].entries.find((entry) => entry.tool === 'cursor' && entry.role === 'skill')!;
    cursorSkill.exports.push(
      'release/nextjs/native/cursor/.cursor/skills/odd skill/SKILL.md',
      'release/nextjs/native/cursor-next/.cursor/skills/later/SKILL.md',
      'release/nextjs/native/cursor/.cursor/skills/nextjs-code-review/references/SKILL.md',
    );
    for (const entry of manifest.stacks[1].entries) if (entry.tool === 'cursor') entry.exports = [];
    const parsed = parseManifest(manifest);
    expect(listStacks(parsed, 'cursor')).toEqual([{ id: 'nextjs', skills: ['nextjs-code-review'] }]);
    expect(listStacks(parsed).map((stack) => stack.id)).toEqual(['nextjs', 'react']);
  });

  it('ignores fields the CLI does not read', () => {
    const manifest = fixtureManifest();
    const input = { release: 42, stacks: manifest.stacks.map((stack) => ({ ...stack, entries: stack.entries.map((entry) => ({ ...entry, catalog: null })) })) };
    expect(parseManifest(input)).toEqual(manifest);
  });

  it('lists skill names only from SKILL.md exports', () => {
    const manifest = fixtureManifest();
    const skill = manifest.stacks[0].entries.find((entry) => entry.tool === 'cursor' && entry.role === 'skill')!;
    skill.exports.push(skill.exports[0].replace('SKILL.md', 'references/checklist.md'));
    expect(listStacks(parseManifest(manifest), 'cursor')[0].skills).toEqual(['nextjs-code-review']);
  });
});
