import { chmod, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import prompts from 'prompts';
import { chooseTools, detectTools, NO_TOOL_MESSAGE, severalToolsMessage, SIGNALS } from '../src/detect.js';
import { TOOLS } from '../src/types.js';

vi.mock('prompts', () => ({ default: vi.fn() }));
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'presets-detect-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('tool detection', () => {
  it.each(Object.entries(SIGNALS).flatMap(([tool, signals]) => signals.map((signal) => [tool, signal])))('detects %s from %s', async (tool, signal) => {
    await mkdir(path.dirname(path.join(root, signal)), { recursive: true });
    await writeFile(path.join(root, signal), '');
    expect(await detectTools(root)).toEqual([tool]);
    expect(await chooseTools(root, false, false)).toEqual([tool]);
  });
  it('also detects the directory form of .clinerules', async () => {
    await mkdir(path.join(root, '.clinerules'));
    expect(await detectTools(root)).toEqual(['cline']);
  });
  it('keeps detecting other tools when .github is a regular file', async () => {
    await writeFile(path.join(root, '.github'), 'Not a directory');
    await mkdir(path.join(root, '.cursor'));
    expect(await detectTools(root)).toEqual(['cursor']);
    expect(await chooseTools(root, true, false)).toEqual(['cursor']);
  });
  // Root ignores search permission, and Windows folders have no search bit.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('counts a signal behind an unsearchable folder as detected', async () => {
    await mkdir(path.join(root, '.github/instructions'), { recursive: true });
    await mkdir(path.join(root, '.cursor'));
    await chmod(path.join(root, '.github'), 0o644);
    try { expect(await detectTools(root)).toEqual(['cursor', 'copilot']); }
    finally { await chmod(path.join(root, '.github'), 0o755); }
  });
  it('ignores a symlink loop where a signal folder should be', async () => {
    await symlink('.github', path.join(root, '.github'));
    await mkdir(path.join(root, '.cursor'));
    expect(await detectTools(root)).toEqual(['cursor']);
  });
  it('selects all detected tools with --yes, but asks for a choice in a non-TTY', async () => {
    await mkdir(path.join(root, '.cursor'));
    await writeFile(path.join(root, 'AGENTS.md'), '');
    expect(await chooseTools(root, true, true)).toEqual(['cursor', 'codex']);
    expect(await chooseTools(root, true, false)).toEqual(['cursor', 'codex']);
    await expect(chooseTools(root, false, false)).rejects.toThrow(severalToolsMessage(['cursor', 'codex']));
  });
  it('fails without detected tools for --yes or a non-TTY', async () => {
    await expect(chooseTools(root, true, true)).rejects.toThrow(NO_TOOL_MESSAGE);
    await expect(chooseTools(root, false, false)).rejects.toThrow(NO_TOOL_MESSAGE);
  });
  it('preselects detected tools in the interactive multi-select', async () => {
    await mkdir(path.join(root, '.cursor'));
    await mkdir(path.join(root, '.claude'));
    vi.mocked(prompts).mockResolvedValueOnce({ tools: ['claude', 'codex'] });
    expect(await chooseTools(root, false, true)).toEqual(['claude', 'codex']);
    expect(prompts).toHaveBeenCalledWith(expect.objectContaining({
      choices: TOOLS.map((tool) => ({ title: tool, value: tool, selected: ['cursor', 'claude'].includes(tool) })),
    }), expect.anything());
  });
  it('offers all seven tools when none is detected and handles cancellation', async () => {
    vi.mocked(prompts).mockResolvedValueOnce({ tools: ['codex'] });
    expect(await chooseTools(root, false, true)).toEqual(['codex']);
    expect(vi.mocked(prompts).mock.calls.at(-1)?.[0]).toMatchObject({ choices: expect.arrayContaining([{ title: 'codex', value: 'codex', selected: false }]) });
    vi.mocked(prompts).mockImplementationOnce(async (_questions, options) => {
      options?.onCancel?.({} as prompts.PromptObject, {});
      return {};
    });
    await expect(chooseTools(root, false, true)).rejects.toThrow('cancelled');
  });
});
