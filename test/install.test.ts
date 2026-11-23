import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, stat, chmod, rename, realpath, link, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlan } from '../src/plan.js';
import { install } from '../src/install.js';
import { PartialInstallError } from '../src/writer-client.js';
import { fixtureStack } from './fixtures/manifest.js';
import { addSkill, hookWriter } from './fixtures/helpers.js';
import { TOOLS } from '../src/types.js';
import { updateSection } from '../src/markers.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'presets-install-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const content = Buffer.from('Synthetic export\r\n\u00e9\n');


describe('installer', () => {
  it.each(TOOLS)('installs exports for %s and skips existing files', async (tool) => {
    const plan = createPlan([fixtureStack()], [tool]);
    const download = vi.fn(async () => content);
    const results = await install(plan, root, download);
    expect(results).toHaveLength(2);
    for (const file of plan.files) {
      const bytes = await readFile(path.join(root, file.target));
      if (file.mode === 'file') expect(bytes).toEqual(content);
      else expect(bytes.toString()).toContain('<!-- presets.dev:nextjs:start -->');
    }
    download.mockClear();
    const again = await install(plan, root, download);
    expect(again.every((file) => file.action === 'skipped (exists)')).toBe(true);
    expect(download).not.toHaveBeenCalled();
    if (tool === 'windsurf') expect(await readdir(root)).toEqual(['.devin']);
  });

  it('preserves original CRLF instructions and replaces only the section with force', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal instructions\r\n', { mode: 0o640 });
    const plan = createPlan([fixtureStack()], ['codex']);
    await install(plan, root, async () => content);
    const first = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(first.startsWith('Personal instructions\r\n\r\n')).toBe(true);
    expect(first.replaceAll('\r\n', '')).not.toContain('\n');
    await install(plan, root, async () => Buffer.from('Updated rules\n'), { force: true });
    const updated = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(updated.startsWith('Personal instructions\r\n\r\n')).toBe(true);
    expect(updated).toContain('Updated rules\r\n');
    if (process.platform !== 'win32') expect((await stat(path.join(root, 'AGENTS.md'))).mode & 0o777).toBe(0o640);
  });

  it('downloads a shared skill once and keeps both standard destinations', async () => {
    const plan = createPlan([fixtureStack()], ['codex', 'antigravity']);
    const download = vi.fn(async () => content);
    await install(plan, root, download);
    expect(download).toHaveBeenCalledTimes(3);
    expect(await readFile(path.join(root, 'GEMINI.md'), 'utf8')).toContain('nextjs:start');
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toContain('nextjs:start');
  });

  it('does not duplicate Codex sections for --agents-md and handles multiple stacks', async () => {
    const plan = createPlan([fixtureStack(), fixtureStack('react')], ['codex', 'antigravity'], { agentsMd: true });
    await install(plan, root, async () => content);
    const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(agents.match(/nextjs:start/g)).toHaveLength(1);
    expect(agents.match(/react:start/g)).toHaveLength(1);
    expect(await readdir(root)).not.toContain('GEMINI.md');
  });

  it.each(['cursor', 'copilot', 'windsurf'] as const)('skips %s skills when a shared directory already exists, even with force', async (tool) => {
    await addSkill(path.join(root, '.agents/skills/nextjs-code-review'));
    const plan = createPlan([fixtureStack()], [tool]);
    const result = await install(plan, root, async () => content, { force: true });
    expect(result[1].action).toBe('skipped (shared skill already present)');
    await expect(readFile(path.join(root, plan.files[1].target))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('avoids native skill duplicates when the shared skill is in the same plan', async () => {
    const plan = createPlan([fixtureStack()], ['cursor', 'copilot', 'windsurf', 'codex']);
    const result = await install(plan, root, async () => content);
    expect(result.filter((item) => item.action === 'skipped (shared skill already present)')).toHaveLength(3);
  });

  it('forces replacement of ordinary files without leaving temporary files', async () => {
    const plan = createPlan([fixtureStack()], ['claude']);
    await install(plan, root, async () => content);
    await install(plan, root, async () => Buffer.from('new'), { force: true });
    expect(await readFile(path.join(root, plan.files[0].target), 'utf8')).toBe('new');
    expect(await readdir(path.dirname(path.join(root, plan.files[0].target)))).toEqual(['nextjs-rules.md']);
  });

  it('dry run performs no downloads and writes nothing', async () => {
    const download = vi.fn(async () => content);
    const result = await install(createPlan([fixtureStack()], ['codex', 'cursor']), root, download, { dryRun: true });
    expect(result[0].action).toBe('would create');
    expect(download).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('finishes all downloads before writing; a later failure leaves no files', async () => {
    const download = vi.fn().mockResolvedValueOnce(content).mockRejectedValueOnce(new Error('HTTP failure'));
    await expect(install(createPlan([fixtureStack()], ['cursor']), root, download)).rejects.toThrow('HTTP failure');
    expect(await readdir(root)).toEqual([]);
  });

  it.each([false, true])('skips files under a symlinked tool folder and installs other tools (dryRun=%s)', async (dryRun) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-outside-'));
    try {
      await symlink(outside, path.join(root, '.claude'), 'dir');
      const download = vi.fn(async () => content);
      const results = await install(createPlan([fixtureStack()], ['cursor', 'claude'], { only: 'standards' }), root, download, { force: true, dryRun });
      expect(results).toEqual([
        { path: '.cursor/rules/nextjs-rules.mdc', action: dryRun ? 'would create' : 'created' },
        { path: '.claude/rules/nextjs-rules.md', action: 'skipped (folder is a symlink)' },
      ]);
      expect(download).toHaveBeenCalledTimes(dryRun ? 0 : 1);
      expect(await readdir(outside)).toEqual([]);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it.each([false, true])('installs native skills when a symlinked .agents folder blocks the shared copy (dryRun=%s)', async (dryRun) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-agents-link-'));
    try {
      await symlink(outside, path.join(root, '.agents'), 'dir');
      const results = await install(createPlan([fixtureStack()], ['cursor', 'codex'], { only: 'skill' }), root, async () => content, { dryRun });
      expect(results).toEqual([
        { path: '.cursor/skills/nextjs-code-review/SKILL.md', action: dryRun ? 'would create' : 'created' },
        { path: '.agents/skills/nextjs-code-review/SKILL.md', action: 'skipped (folder is a symlink)' },
      ]);
      expect(await readdir(outside)).toEqual([]);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('still treats a shared skill reached through a linked .agents folder as present', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-agents-link-'));
    try {
      await addSkill(path.join(outside, 'skills/nextjs-code-review'));
      await symlink(outside, path.join(root, '.agents'), 'dir');
      const results = await install(createPlan([fixtureStack()], ['cursor', 'codex'], { only: 'skill' }), root, async () => content);
      expect(results.map((result) => result.action)).toEqual(['skipped (shared skill already present)', 'skipped (exists)']);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('skips a symlinked rule file under --force and installs other tools', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-file-link-'));
    try {
      await writeFile(path.join(outside, 'rules.mdc'), 'Personal');
      await mkdir(path.join(root, '.cursor/rules'), { recursive: true });
      await symlink(path.join(outside, 'rules.mdc'), path.join(root, '.cursor/rules/nextjs-rules.mdc'));
      const results = await install(createPlan([fixtureStack()], ['cursor', 'claude'], { only: 'standards' }), root, async () => content, { force: true });
      expect(results).toEqual([
        { path: '.cursor/rules/nextjs-rules.mdc', action: 'skipped (file is a symlink)' },
        { path: '.claude/rules/nextjs-rules.md', action: 'created' },
      ]);
      expect(await readFile(path.join(outside, 'rules.mdc'), 'utf8')).toBe('Personal');
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('skips symlinked section files', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-outside-'));
    try {
      await writeFile(path.join(outside, 'instructions'), 'Personal');
      await symlink(path.join(outside, 'instructions'), path.join(root, 'AGENTS.md'));
      for (const force of [false, true]) {
        expect(await install(createPlan([fixtureStack()], ['cursor', 'codex'], { only: 'standards' }), root, async () => content, { force })).toEqual([
          { path: '.cursor/rules/nextjs-rules.mdc', action: force ? 'replaced' : 'created' },
          { path: 'AGENTS.md', action: 'skipped (AGENTS.md is a symlink)' },
        ]);
      }
      expect(await readFile(path.join(outside, 'instructions'), 'utf8')).toBe('Personal');
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('reports unsupported exports as skipped without downloading them', async () => {
    const stack = fixtureStack();
    const unknown = 'release/nextjs/native/cursor/.cursor/rules/notes.txt';
    stack.entries.find((entry) => entry.tool === 'cursor' && entry.role === 'standards')!.exports.push(unknown);
    const download = vi.fn(async () => content);
    const results = await install(createPlan([stack], ['cursor'], { only: 'standards' }), root, download);
    expect(results).toEqual([
      { path: '.cursor/rules/nextjs-rules.mdc', action: 'created' },
      { path: unknown, action: 'skipped (needs a newer presets-dev)' },
    ]);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('preserves a legacy .clinerules file and continues other installs (force=%s)', async (force) => {
    await writeFile(path.join(root, '.clinerules'), 'Personal legacy rules');
    const plan = createPlan([fixtureStack()], ['cursor', 'cline']);
    const result = await install(plan, root, async () => content, { force });
    expect(result.find((item) => item.path.startsWith('.clinerules/'))?.action).toBe('skipped (legacy .clinerules file)');
    expect(await readFile(path.join(root, '.clinerules'), 'utf8')).toBe('Personal legacy rules');
    expect(await readFile(path.join(root, '.cline/skills/nextjs-code-review/SKILL.md'))).toEqual(content);
    expect(await readFile(path.join(root, '.cursor/rules/nextjs-rules.mdc'))).toEqual(content);
  });

  it('previews the legacy Cline conflict without downloading or writing', async () => {
    await writeFile(path.join(root, '.clinerules'), 'Legacy');
    const download = vi.fn(async () => content);
    const result = await install(createPlan([fixtureStack()], ['cline']), root, download, { dryRun: true });
    expect(result.map((item) => item.action)).toEqual(['skipped (legacy .clinerules file)', 'would create']);
    expect(download).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['.clinerules']);
  });

  it('also preserves a symlinked legacy Cline file while installing other rules', async () => {
    const personal = path.join(root, 'personal-rules.md');
    await writeFile(personal, 'Personal rules');
    await symlink(personal, path.join(root, '.clinerules'));
    const plan = createPlan([fixtureStack()], ['cline', 'cursor'], { only: 'standards' });
    const result = await install(plan, root, async () => content, { force: true });
    expect(result.find((file) => file.path.startsWith('.clinerules/'))?.action).toBe('skipped (legacy .clinerules file)');
    expect(await readFile(personal, 'utf8')).toBe('Personal rules');
    expect(await readFile(path.join(root, '.cursor/rules/nextjs-rules.mdc'))).toEqual(content);
  });

  it.each([false, true])('checks shared skills through symlinks without writing through them (dryRun=%s)', async (dryRun) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-dotfiles-'));
    try {
      await addSkill(path.join(outside, 'skills/nextjs-code-review'));
      await symlink(outside, path.join(root, '.agents'), 'dir');
      await symlink(outside, path.join(root, '.claude'), 'dir');
      const result = await install(createPlan([fixtureStack()], ['cursor']), root, async () => content, { dryRun });
      expect(result[1].action).toBe('skipped (shared skill already present)');
      expect(await readdir(path.join(outside, 'skills/nextjs-code-review'))).toEqual(['SKILL.md']);
      if (!dryRun) expect(await readFile(path.join(root, '.cursor/rules/nextjs-rules.mdc'))).toEqual(content);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('creates native skills when a linked shared folder has no matching skill', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-empty-dotfiles-'));
    try {
      await symlink(outside, path.join(root, '.agents'), 'dir');
      await install(createPlan([fixtureStack()], ['cursor']), root, async () => content);
      expect(await readFile(path.join(root, '.cursor/skills/nextjs-code-review/SKILL.md'))).toEqual(content);
      expect(await readdir(outside)).toEqual([]);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('skips an existing native file behind a symlink and never overwrites it', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-native-dotfiles-'));
    try {
      await mkdir(path.join(outside, 'rules'));
      await writeFile(path.join(outside, 'rules/nextjs-rules.md'), 'Personal');
      await symlink(outside, path.join(root, '.claude'), 'dir');
      const plan = createPlan([fixtureStack()], ['claude'], { only: 'standards' });
      expect((await install(plan, root, async () => content))[0].action).toBe('skipped (exists)');
      expect((await install(plan, root, async () => content, { force: true }))[0].action).toBe('skipped (folder is a symlink)');
      expect(await readFile(path.join(outside, 'rules/nextjs-rules.md'), 'utf8')).toBe('Personal');
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it.each([false, true])('reports a section installed during download as skipped (fileExisted=%s)', async (fileExisted) => {
    if (fileExisted) await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
    const other = updateSection('Personal\n', 'Rules from another process', 'nextjs').text;
    const result = await install(createPlan([fixtureStack()], ['codex'], { only: 'standards' }), root, async () => {
      await writeFile(path.join(root, 'AGENTS.md'), other);
      return content;
    });
    expect(result[0].action).toBe('skipped (exists)');
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe(other);
  });

  it('reports a section created during download as replaced with force', async () => {
    const other = updateSection('Personal\n', 'Old rules', 'nextjs').text;
    const result = await install(createPlan([fixtureStack()], ['codex'], { only: 'standards' }), root, async () => {
      await writeFile(path.join(root, 'AGENTS.md'), other);
      return Buffer.from('Updated');
    }, { force: true });
    expect(result[0].action).toBe('replaced');
    const actual = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(actual).toContain('Personal\n\n');
    expect(actual).toContain('Updated');
    expect(actual).not.toContain('Old rules');
  });

  it('uses Codex content with reversed manifest order for --agents-md', async () => {
    const stack = fixtureStack();
    stack.entries.reverse();
    const plan = createPlan([stack], ['antigravity', 'codex'], { agentsMd: true });
    await install(plan, root, async (source) => Buffer.from(source.includes('/codex/') ? 'Codex instructions' : 'Antigravity instructions'));
    const actual = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(actual).toContain('Codex instructions');
    expect(actual).not.toContain('Antigravity instructions');
    expect(actual.match(/nextjs:start/g)).toHaveLength(1);
    expect(await readdir(root)).not.toContain('GEMINI.md');
  });

  it('bounds parallel downloads, caches duplicate sources, and writes only after completion', async () => {
    const plan = createPlan([fixtureStack(), fixtureStack('react')], ['cursor', 'copilot', 'claude']);
    plan.files[1].source = plan.files[0].source;
    let active = 0;
    let peak = 0;
    const download = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      expect(await readdir(root)).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return content;
    });
    await install(plan, root, download);
    expect(download).toHaveBeenCalledTimes(11);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
    expect(active).toBe(0);
    expect(await readFile(path.join(root, plan.files[0].target))).toEqual(content);
  });

  it('waits for in-flight downloads after failure and leaves the project untouched', async () => {
    const plan = createPlan([fixtureStack(), fixtureStack('react')], ['cursor', 'copilot', 'claude']);
    let active = 0;
    const download = vi.fn(async (source: string) => {
      active++;
      try {
        if (source === plan.files[0].source) throw new Error('Network failure');
        await new Promise((resolve) => setTimeout(resolve, 5));
        return content;
      } finally { active--; }
    });
    await expect(install(plan, root, download)).rejects.toThrow('Network failure');
    expect(download.mock.calls.length).toBeLessThanOrEqual(6);
    expect(active).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([false, true])('preserves all overlapping shared sections across processes (existing=%s)', async (existing) => {
    if (existing) await writeFile(path.join(root, 'AGENTS.md'), 'Personal\r\n');
    hookWriter({ kind: 'pause-read' });
    const stacks = ['nextjs', 'react', 'vue', 'python'];
    const results = await Promise.all(stacks.map((stack) => install(
      createPlan([fixtureStack(stack)], ['codex'], { only: 'standards' }), root,
      async () => Buffer.from(`Rules for ${stack}`),
    )));
    const actual = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    for (const stack of stacks) {
      expect(actual.match(new RegExp(`presets.dev:${stack}:start`, 'g'))).toHaveLength(1);
      expect(actual).toContain(`Rules for ${stack}`);
    }
    expect(results.flat().filter((result) => result.action === 'created')).toHaveLength(existing ? 0 : 1);
    if (existing) {
      expect(actual.startsWith('Personal\r\n')).toBe(true);
      expect(actual.replaceAll('\r\n', '')).not.toContain('\n');
    }
    expect((await readdir(root)).some((name) => name.endsWith('.lock'))).toBe(false);
  });

  it('deduplicates overlapping installs of the same stack across processes', async () => {
    hookWriter({ kind: 'pause-read' });
    const plan = createPlan([fixtureStack()], ['codex'], { only: 'standards' });
    const results = await Promise.all(Array.from({ length: 3 }, () => install(plan, root, async () => content)));
    expect(results.flat().filter((result) => result.action === 'skipped (exists)')).toHaveLength(2);
    expect((await readFile(path.join(root, 'AGENTS.md'), 'utf8')).match(/nextjs:start/g)).toHaveLength(1);
  });

  // Windows exposes only the writable bit through chmod, without POSIX groups.
  it.skipIf(process.platform === 'win32')('preserves group-write permissions through the worker', async () => {
    const before = process.umask(0o022);
    try {
      await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
      await chmod(path.join(root, 'AGENTS.md'), 0o664);
      await install(createPlan([fixtureStack()], ['codex'], { only: 'standards' }), root, async () => content);
      expect((await stat(path.join(root, 'AGENTS.md'))).mode & 0o777).toBe(0o664);
    } finally { process.umask(before); }
  });

  it.each(['swap-on-chdir', 'swap-on-write'])('never redirects writes outside the project after %s', async (kind) => {
    root = await realpath(root);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-swap-outside-'));
    try {
      const parent = path.join(root, '.cursor/rules');
      await mkdir(parent, { recursive: true });
      hookWriter({ kind, parent, outside, moved: path.join(root, '.cursor/moved-rules') });
      // Windows prevents renaming the worker's current directory outright.
      const refusal = process.platform === 'win32' && kind === 'swap-on-write' ? /EPERM|EACCES|EBUSY/ : /changed|symlink/;
      await expect(install(createPlan([fixtureStack()], ['cursor'], { only: 'standards' }), root, async () => content)).rejects.toThrow(refusal);
      expect(await readdir(outside)).toEqual([]);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('refuses a project root replaced during downloads without writing outside it', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-root-outside-'));
    const moved = `${root}-moved`;
    try {
      await expect(install(createPlan([fixtureStack()], ['cursor'], { only: 'standards' }), root, async () => {
        await rename(root, moved);
        await symlink(outside, root, 'dir');
        return content;
      })).rejects.toThrow('Project directory changed');
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(moved, { recursive: true, force: true });
    }
  });

  it('skips markers broken during download and releases the section lock', async () => {
    const plan = createPlan([fixtureStack()], ['codex'], { only: 'standards' });
    expect(await install(plan, root, async () => {
      await writeFile(path.join(root, 'AGENTS.md'), '<!-- presets.dev:nextjs:start -->');
      return content;
    })).toEqual([{ path: 'AGENTS.md', action: 'skipped (malformed presets.dev markers)' }]);
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('<!-- presets.dev:nextjs:start -->');
    expect((await readdir(root)).filter((name) => name.endsWith('.lock'))).toEqual([]);
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
    expect((await install(plan, root, async () => content))[0].action).toBe('appended');
  });

  it('reports an occupied section lock without deleting it or changing user content', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
    const lock = path.join(root, '.presets-AGENTS.md.lock');
    await mkdir(lock);
    hookWriter({ kind: 'fast-timeout' });
    await expect(install(createPlan([fixtureStack()], ['codex'], { only: 'standards' }), root, async () => content)).rejects.toThrow('Installation is busy: AGENTS.md');
    expect((await stat(lock)).isDirectory()).toBe(true);
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('Personal\n');
  });

  it.each([
    { name: 'its owner process is gone', owner: '2147483646', age: 0 },
    { name: 'it has no owner and is older than any real write', owner: undefined, age: 60 },
  ])('breaks a stale section lock when $name', async ({ owner, age }) => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
    const lock = path.join(root, '.presets-AGENTS.md.lock');
    await mkdir(lock);
    if (owner) await writeFile(path.join(lock, 'owner'), owner);
    if (age) await utimes(lock, new Date(Date.now() - age * 1000), new Date(Date.now() - age * 1000));
    const results = await install(createPlan([fixtureStack()], ['codex'], { only: 'standards' }), root, async () => content);
    expect(results).toEqual([{ path: 'AGENTS.md', action: 'appended' }]);
    expect((await readdir(root)).filter((name) => name.includes('.lock'))).toEqual([]);
  });

  it('waits for a section lock held by a live process', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
    const lock = path.join(root, '.presets-AGENTS.md.lock');
    await mkdir(lock);
    await writeFile(path.join(lock, 'owner'), String(process.pid));
    hookWriter({ kind: 'fast-timeout' });
    await expect(install(createPlan([fixtureStack()], ['codex'], { only: 'standards' }), root, async () => content)).rejects.toThrow('Installation is busy: AGENTS.md');
    expect(await readFile(path.join(lock, 'owner'), 'utf8')).toBe(String(process.pid));
  });

  it.each(['in-place', 'atomic'].flatMap((style) => ['edit-on-append-open', 'edit-on-append-write'].map((kind) => ({ style, kind }))))('preserves editor data with $style during $kind', async ({ style, kind }) => {
    const file = path.join(root, 'AGENTS.md');
    const edited = 'Personal instructions\r\nNew editor line\r\n';
    await writeFile(file, 'Personal instructions\r\n');
    const identity = await stat(file);
    hookWriter({ kind, style, content: edited });
    let result;
    try {
      result = await install(createPlan([fixtureStack()], ['codex'], { only: 'standards' }), root, async () => Buffer.from('New rules'));
    } catch (error) {
      // Windows can deny the editor's rename while the append handle is open.
      if (process.platform !== 'win32' || style !== 'atomic' || kind !== 'edit-on-append-write') throw error;
      expect(error).toBeInstanceOf(PartialInstallError);
      expect((error as Error).message).toMatch(/EPERM|EACCES/);
      expect((error as PartialInstallError).results).toEqual([]);
      expect(await readFile(file, 'utf8')).toBe('Personal instructions\r\n');
      expect(await readFile(path.join(root, 'editor-save.tmp'), 'utf8')).toBe(edited);
      expect((await readdir(root)).some((name) => name.startsWith('.presets-'))).toBe(false);
      return;
    }
    const actual = await readFile(file, 'utf8');
    expect(result[0].action).toBe('appended');
    expect(actual.startsWith(edited)).toBe(true);
    expect(actual.match(/nextjs:start/g)).toHaveLength(1);
    expect(actual).toContain('New rules');
    expect(actual.replaceAll('\r\n', '')).not.toContain('\n');
    if (style === 'in-place') expect((await stat(file)).ino).toBe(identity.ino);
  });

  it('keeps non-UTF-8 user bytes outside the section on a forced replacement', async () => {
    const file = path.join(root, 'AGENTS.md');
    const before = Buffer.concat([Buffer.from('Caf'), Buffer.from([0xe9, 0xff]), Buffer.from('\n')]);
    const after = Buffer.concat([Buffer.from('Footer '), Buffer.from([0xfe]), Buffer.from('\n')]);
    await writeFile(file, Buffer.concat([before, Buffer.from(updateSection('', 'Old rules', 'nextjs').text), after]));
    const plan = createPlan([fixtureStack()], ['codex'], { only: 'standards' });
    expect((await install(plan, root, async () => content, { force: true }))[0].action).toBe('replaced');
    const bytes = await readFile(file);
    expect(bytes.subarray(0, before.length)).toEqual(before);
    expect(bytes.subarray(bytes.length - after.length)).toEqual(after);
    expect(bytes.includes(Buffer.from('\u00e9'))).toBe(true);
    expect(bytes.includes(Buffer.from('Old rules'))).toBe(false);
  });

  // process.kill terminates Windows processes without delivering these handlers.
  it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'])('releases the section lock when the writer receives %s', async (signal) => {
    hookWriter({ kind: 'signal-on-temp', signal });
    const plan = createPlan([fixtureStack()], ['codex'], { only: 'standards' });
    await expect(install(plan, root, async () => content)).rejects.toThrow('Preset writer failed');
    expect((await readdir(root)).filter((name) => name.endsWith('.lock'))).toEqual([]);
    vi.unstubAllEnvs();
    expect((await install(plan, root, async () => content))[0].action).toBe('created');
  });

  it.skipIf(process.platform === 'win32').each(
    (['cursor', 'codex'] as const).flatMap((tool) => ['SIGINT', 'SIGTERM'].map((signal) => ({ tool, signal }))),
  )('removes an incomplete exclusive $tool write on $signal and allows retry', async ({ tool, signal }) => {
    const plan = createPlan([fixtureStack()], [tool], { only: 'standards' });
    const target = path.join(root, plan.files[0].target);
    hookWriter({ kind: 'signal-during-exclusive', target: path.basename(target), signal });
    await expect(install(plan, root, async () => content)).rejects.toThrow('Preset writer failed');
    expect(await readdir(path.dirname(target))).toEqual([]);
    vi.unstubAllEnvs();
    expect((await install(plan, root, async () => content))[0].action).toBe('created');
    expect(await readFile(target, 'utf8')).toContain('Synthetic export');
  });

  it.skipIf(process.platform === 'win32')('preserves a replacement of an incomplete exclusive file during signal cleanup', async () => {
    const plan = createPlan([fixtureStack()], ['cursor'], { only: 'standards' });
    const target = path.join(root, plan.files[0].target);
    hookWriter({ kind: 'signal-during-exclusive', target: path.basename(target), signal: 'SIGTERM', replace: true });
    await expect(install(plan, root, async () => content)).rejects.toThrow('Preset writer failed');
    expect(await readFile(target, 'utf8')).toBe('Other process');
    expect(await readdir(path.dirname(target))).toEqual(['nextjs-rules.mdc', 'nextjs-rules.mdc.interrupted']);
  });

  it.skipIf(process.platform === 'win32')('cleans an exclusive file when interrupted immediately after creation', async () => {
    const plan = createPlan([fixtureStack()], ['cursor'], { only: 'standards' });
    const target = path.join(root, plan.files[0].target);
    hookWriter({ kind: 'signal-after-exclusive-open', target: path.basename(target), signal: 'SIGTERM' });
    await expect(install(plan, root, async () => content)).rejects.toThrow('Preset writer failed');
    expect(await readdir(path.dirname(target))).toEqual([]);
    vi.unstubAllEnvs();
    expect((await install(plan, root, async () => content))[0].action).toBe('created');
  });

  it.skipIf(process.platform === 'win32')('removes a temp file already linked as the target when interrupted', async () => {
    hookWriter({ kind: 'signal-after-link' });
    const plan = createPlan([fixtureStack()], ['codex'], { only: 'standards' });
    await expect(install(plan, root, async () => content)).rejects.toThrow('Preset writer failed');
    expect((await readdir(root)).filter((name) => name.startsWith('.presets-'))).toEqual([]);
    expect((await stat(path.join(root, 'AGENTS.md'))).nlink).toBe(1);
    vi.unstubAllEnvs();
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
    expect((await install(plan, root, async () => content))[0].action).toBe('appended');
  });

  it.skipIf(process.platform === 'win32').each(['cursor', 'codex'] as const)('cleans the pinned directory after a signal and directory replacement for %s', async (tool) => {
    root = await realpath(root);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-signal-outside-'));
    const parent = tool === 'codex' ? root : path.join(root, '.cursor/rules');
    const moved = `${parent}-moved`;
    try {
      await mkdir(parent, { recursive: true });
      hookWriter({ kind: 'signal-after-swap', parent, moved, outside, section: tool === 'codex' });
      const plan = createPlan([fixtureStack()], [tool], { only: 'standards' });
      await expect(install(plan, root, async () => content)).rejects.toThrow('Preset writer failed');
      const names = await readdir(outside);
      const temp = names.find((name) => name.endsWith('.tmp'));
      expect(temp).toBeDefined();
      expect(await readFile(path.join(outside, temp!), 'utf8')).toBe('Unrelated outside file');
      if (tool === 'codex') expect((await stat(path.join(outside, '.presets-AGENTS.md.lock'))).isDirectory()).toBe(true);
      expect(await readdir(moved)).toEqual([path.basename(plan.files[0].target)]);
      expect((await stat(path.join(moved, path.basename(plan.files[0].target)))).nlink).toBe(1);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(moved, { recursive: true, force: true });
    }
  });

  it.each([
    { tool: 'cursor', force: false, fallback: false },
    { tool: 'cursor', force: true, fallback: false },
    { tool: 'codex', force: false, fallback: false },
    { tool: 'codex', force: true, fallback: false },
    { tool: 'cursor', force: false, fallback: true },
  ] as const)('reports a published $tool file when cleanup fails (force=$force, fallback=$fallback)', async ({ tool, force, fallback }) => {
    const plan = createPlan([fixtureStack()], [tool], { only: 'standards' });
    if (force) await install(plan, root, async () => Buffer.from('Old rules'));
    hookWriter({ kind: 'cleanup-failure', fallback });
    const error = await install(plan, root, async () => content, { force }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PartialInstallError);
    expect((error as Error).message).toContain('Temporary cleanup denied');
    expect((error as PartialInstallError).results).toEqual([{ path: plan.files[0].target, action: force ? 'replaced' : 'created' }]);
    const actual = await readFile(path.join(root, plan.files[0].target));
    if (tool === 'codex') expect(actual.toString()).toContain(content.toString().replaceAll('\r\n', '\n'));
    else expect(actual).toEqual(content);
  });

  it('reports an appended section when closing its handle fails', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
    hookWriter({ kind: 'append-close-failure' });
    const plan = createPlan([fixtureStack()], ['codex'], { only: 'standards' });
    const error = await install(plan, root, async () => content).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PartialInstallError);
    expect((error as Error).message).toContain('Append close failed');
    expect((error as PartialInstallError).results).toEqual([{ path: 'AGENTS.md', action: 'appended' }]);
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toContain('Synthetic export\n\u00e9\n');
    expect(await readdir(root)).toEqual(['AGENTS.md']);
  });

  it('does not report a write that failed before publication', async () => {
    hookWriter({ kind: 'publish-failure' });
    const plan = createPlan([fixtureStack()], ['cursor'], { only: 'standards' });
    const error = await install(plan, root, async () => content).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PartialInstallError);
    expect((error as Error).message).toContain('Publication failed');
    expect((error as PartialInstallError).results).toEqual([]);
    expect(await readdir(path.join(root, '.cursor/rules'))).toEqual([]);
  });

  it('detects a parent directory moved out of the project and replaced by a symlink', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-moved-parent-'));
    try {
      await mkdir(path.join(root, '.cursor/rules'), { recursive: true });
      const moved = path.join(outside, '.cursor');
      hookWriter({ kind: 'swap-on-write', parent: path.join(root, '.cursor'), moved, outside: moved });
      const plan = createPlan([fixtureStack()], ['cursor'], { only: 'standards' });
      const error = await install(plan, root, async () => content).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PartialInstallError);
      if (process.platform === 'win32') {
        expect((error as Error).message).toMatch(/EPERM|EACCES|EBUSY/);
        expect((error as PartialInstallError).results).toEqual([]);
        expect(await readdir(outside)).toEqual([]);
        expect(await readdir(path.join(root, '.cursor/rules'))).toEqual([]);
      } else {
        expect((error as Error).message).toContain('Project directory changed');
        expect((error as PartialInstallError).results).toEqual([{ path: plan.files[0].target, action: 'created' }]);
        expect(await readFile(path.join(moved, 'rules/nextjs-rules.mdc'))).toEqual(content);
      }
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('reports files written before a later failure', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
    await mkdir(path.join(root, '.presets-AGENTS.md.lock'));
    hookWriter({ kind: 'fast-timeout' });
    const plan = createPlan([fixtureStack()], ['cursor', 'codex'], { only: 'standards' });
    const error = await install(plan, root, async () => content).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PartialInstallError);
    expect((error as PartialInstallError).results).toEqual([{ path: '.cursor/rules/nextjs-rules.mdc', action: 'created' }]);
  });

  it('skips a hard-linked AGENTS.md and installs the other tools', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-hardlink-early-'));
    try {
      await writeFile(path.join(outside, 'instructions.md'), 'Personal\n');
      await link(path.join(outside, 'instructions.md'), path.join(root, 'AGENTS.md'));
      const plan = createPlan([fixtureStack()], ['cursor', 'codex'], { only: 'standards' });
      expect(await install(plan, root, async () => content, { dryRun: true })).toEqual([
        { path: '.cursor/rules/nextjs-rules.mdc', action: 'would create' },
        { path: 'AGENTS.md', action: 'skipped (file is hard-linked)' },
      ]);
      await expect(stat(path.join(root, '.cursor'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await install(plan, root, async () => content)).toEqual([
        { path: '.cursor/rules/nextjs-rules.mdc', action: 'created' },
        { path: 'AGENTS.md', action: 'skipped (file is hard-linked)' },
      ]);
      expect(await readFile(path.join(outside, 'instructions.md'), 'utf8')).toBe('Personal\n');
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('skips a symlinked GEMINI.md with a hint and installs the other tools', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
    await symlink('AGENTS.md', path.join(root, 'GEMINI.md'));
    const plan = createPlan([fixtureStack()], ['cursor', 'antigravity'], { only: 'standards' });
    expect(await install(plan, root, async () => content)).toEqual([
      { path: '.cursor/rules/nextjs-rules.mdc', action: 'created' },
      { path: 'GEMINI.md', action: 'skipped (GEMINI.md is a symlink; use --agents-md)' },
    ]);
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('Personal\n');
  });

  it.each(['in-place', 'atomic'])('aborts a forced replacement after a concurrent $style editor save', async (style) => {
    const file = path.join(root, 'AGENTS.md');
    const original = updateSection('Personal\n', 'Old rules', 'nextjs').text;
    const edited = original + '\nNew editor line\n';
    await writeFile(file, original);
    hookWriter({ kind: 'edit-on-temp', style, content: edited });
    const plan = createPlan([fixtureStack()], ['codex'], { only: 'standards' });
    await expect(install(plan, root, async () => Buffer.from('New rules'), { force: true })).rejects.toThrow('File changed during installation');
    expect(await readFile(file, 'utf8')).toBe(edited);
    expect((await readdir(root)).filter((name) => name.startsWith('.presets-'))).toEqual([]);
    vi.unstubAllEnvs();
    expect((await install(plan, root, async () => Buffer.from('New rules'), { force: true }))[0].action).toBe('replaced');
    expect(await readFile(file, 'utf8')).toBe(edited.replace('Old rules', 'New rules'));
  });

  it.each((['cursor', 'copilot', 'windsurf'] as const).flatMap((tool) => [false, true].map((force) => ({ tool, force }))))('rechecks a shared skill created during download for $tool (force=$force)', async ({ tool, force }) => {
    const plan = createPlan([fixtureStack()], [tool], { only: 'skill' });
    const result = await install(plan, root, async () => {
      await addSkill(path.join(root, '.agents/skills/nextjs-code-review'));
      return content;
    }, { force });
    expect(result[0].action).toBe('skipped (shared skill already present)');
    await expect(readFile(path.join(root, plan.files[0].target))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not replace an existing native copy when a shared skill appears during a forced download', async () => {
    const plan = createPlan([fixtureStack()], ['cursor'], { only: 'skill' });
    const target = path.join(root, plan.files[0].target);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'Personal copy');
    const result = await install(plan, root, async () => {
      await addSkill(path.join(root, '.agents/skills/nextjs-code-review'));
      return content;
    }, { force: true });
    expect(result[0].action).toBe('skipped (shared skill already present)');
    expect(await readFile(target, 'utf8')).toBe('Personal copy');
  });

  it.each([false, true])('never appends through a hard-linked instruction file (force=%s)', async (force) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-hardlink-outside-'));
    try {
      const original = path.join(outside, 'instructions.md');
      await writeFile(original, 'Personal instructions\n');
      await link(original, path.join(root, 'AGENTS.md'));
      const plan = createPlan([fixtureStack()], ['codex'], { only: 'standards' });
      expect(await install(plan, root, async () => content, { force })).toEqual([{ path: 'AGENTS.md', action: 'skipped (file is hard-linked)' }]);
      expect(await readFile(original, 'utf8')).toBe('Personal instructions\n');
      expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('Personal instructions\n');
      expect((await readdir(root)).some((name) => name.endsWith('.lock'))).toBe(false);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('never force-replaces a section through a hard-linked instruction file', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-hardlink-replace-'));
    try {
      const original = path.join(outside, 'instructions.md');
      const text = updateSection('Personal\n', 'Old rules', 'nextjs').text;
      await writeFile(original, text);
      await link(original, path.join(root, 'AGENTS.md'));
      const plan = createPlan([fixtureStack()], ['cursor', 'codex'], { only: 'standards' });
      expect(await install(plan, root, async () => content, { force: true })).toEqual([
        { path: '.cursor/rules/nextjs-rules.mdc', action: 'created' },
        { path: 'AGENTS.md', action: 'skipped (file is hard-linked)' },
      ]);
      expect(await readFile(original, 'utf8')).toBe(text);
      expect((await stat(path.join(root, 'AGENTS.md'))).nlink).toBe(2);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('skips a forced section replacement when a hard link appears during download', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-hardlink-late-'));
    try {
      const file = path.join(root, 'AGENTS.md');
      const text = updateSection('Personal\n', 'Old rules', 'nextjs').text;
      await writeFile(file, text);
      const plan = createPlan([fixtureStack()], ['codex', 'cursor'], { only: 'standards' });
      const result = await install(plan, root, async () => {
        await link(file, path.join(outside, 'instructions.md')).catch(() => {});
        return content;
      }, { force: true });
      expect(result).toContainEqual({ path: 'AGENTS.md', action: 'skipped (file is hard-linked)' });
      expect(result).toContainEqual({ path: '.cursor/rules/nextjs-rules.mdc', action: 'created' });
      expect(await readFile(path.join(outside, 'instructions.md'), 'utf8')).toBe(text);
      expect((await stat(file)).nlink).toBe(2);
      expect((await readdir(root)).filter((name) => name.startsWith('.presets-'))).toEqual([]);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it.each([false, true])('skips tools whose folder is a regular file and installs the others (dryRun=%s)', async (dryRun) => {
    await writeFile(path.join(root, '.github'), 'Not a folder');
    const plan = createPlan([fixtureStack()], ['copilot', 'claude']);
    const result = await install(plan, root, async () => content, { dryRun, force: true });
    expect(result.filter((entry) => entry.path.startsWith('.github/')).map((entry) => entry.action))
      .toEqual(['skipped (parent folder is a file)', 'skipped (parent folder is a file)']);
    expect(result.filter((entry) => entry.path.startsWith('.claude/')).map((entry) => entry.action))
      .toEqual(dryRun ? ['would create', 'would create'] : ['created', 'created']);
    expect(await readFile(path.join(root, '.github'), 'utf8')).toBe('Not a folder');
  });

  it('skips an instruction file with stray markers and installs the other tools', async () => {
    const stray = 'Docs: we wrap sections with <!-- presets.dev:nextjs:start --> markers\n';
    await writeFile(path.join(root, 'AGENTS.md'), stray);
    const plan = createPlan([fixtureStack()], ['cursor', 'codex'], { only: 'standards' });
    expect(await install(plan, root, async () => content, { force: true })).toEqual([
      { path: '.cursor/rules/nextjs-rules.mdc', action: 'created' },
      { path: 'AGENTS.md', action: 'skipped (malformed presets.dev markers)' },
    ]);
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe(stray);
  });

  it('skips a section export that contains markers so later runs still work', async () => {
    const plan = createPlan([fixtureStack()], ['cursor', 'codex'], { only: 'standards' });
    const marked = Buffer.from('Rules\n<!-- presets.dev:nextjs:end -->\n');
    const download = async (source: string) => source.includes('AGENTS.') ? marked : content;
    expect(await install(plan, root, download)).toEqual([
      { path: '.cursor/rules/nextjs-rules.mdc', action: 'created' },
      { path: 'AGENTS.md', action: 'skipped (export contains presets.dev markers)' },
    ]);
    await expect(stat(path.join(root, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await install(plan, root, async () => content))[1].action).toBe('created');
  });
  it.each([false, true])('skips a folder where a file should be and installs the other tools (force=%s)', async (force) => {
    await mkdir(path.join(root, 'AGENTS.md'));
    await mkdir(path.join(root, '.claude/rules/nextjs-rules.md'), { recursive: true });
    const plan = createPlan([fixtureStack()], ['cursor', 'claude', 'codex'], { only: 'standards' });
    expect(await install(plan, root, async () => content, { force })).toEqual([
      { path: '.cursor/rules/nextjs-rules.mdc', action: 'created' },
      { path: '.claude/rules/nextjs-rules.md', action: 'skipped (not a regular file)' },
      { path: 'AGENTS.md', action: 'skipped (not a regular file)' },
    ]);
  });

  it.each([false, true])('never force-replaces a hard-linked rule file (dryRun=%s)', async (dryRun) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'presets-hardlink-rule-'));
    try {
      const original = path.join(outside, 'rules.mdc');
      await writeFile(original, 'Team rule');
      await mkdir(path.join(root, '.cursor/rules'), { recursive: true });
      await link(original, path.join(root, '.cursor/rules/nextjs-rules.mdc'));
      const plan = createPlan([fixtureStack()], ['cursor'], { only: 'standards' });
      expect(await install(plan, root, async () => content, { force: true, dryRun }))
        .toEqual([{ path: '.cursor/rules/nextjs-rules.mdc', action: 'skipped (file is hard-linked)' }]);
      expect(await readFile(original, 'utf8')).toBe('Team rule');
      expect((await stat(original)).nlink).toBe(2);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  // Root ignores write permission, so these checks only hold for normal users.
  const asRoot = process.getuid?.() === 0;
  it.skipIf(asRoot).each([false, true])('skips a read-only AGENTS.md and still installs the other files (dryRun=%s)', async (dryRun) => {
    const file = path.join(root, 'AGENTS.md');
    await writeFile(file, 'Personal\n');
    await chmod(file, 0o444);
    const plan = createPlan([fixtureStack()], ['cursor', 'codex']);
    const result = await install(plan, root, async () => content, { dryRun });
    expect(result).toContainEqual({ path: 'AGENTS.md', action: 'skipped (permission denied)' });
    expect(result).toContainEqual({ path: '.agents/skills/nextjs-code-review/SKILL.md', action: dryRun ? 'would create' : 'created' });
    expect(await readFile(file, 'utf8')).toBe('Personal\n');
    if (!dryRun) expect(await readFile(path.join(root, '.agents/skills/nextjs-code-review/SKILL.md'))).toEqual(content);
  });

  it.skipIf(asRoot)('reports exists rather than permission for a read-only AGENTS.md that has the section', async () => {
    const file = path.join(root, 'AGENTS.md');
    await writeFile(file, updateSection('Personal\n', 'Rules', 'nextjs').text);
    await chmod(file, 0o444);
    const plan = createPlan([fixtureStack()], ['codex'], { only: 'standards' });
    expect(await install(plan, root, async () => content)).toEqual([{ path: 'AGENTS.md', action: 'skipped (exists)' }]);
  });

  it.skipIf(asRoot)('skips a file made read-only during download and continues', async () => {
    const file = path.join(root, 'AGENTS.md');
    await writeFile(file, 'Personal\n');
    const plan = createPlan([fixtureStack()], ['codex', 'cursor'], { only: 'standards' });
    const result = await install(plan, root, async () => { await chmod(file, 0o444); return content; });
    expect(result).toContainEqual({ path: 'AGENTS.md', action: 'skipped (permission denied)' });
    expect(result).toContainEqual({ path: '.cursor/rules/nextjs-rules.mdc', action: 'created' });
    expect(await readFile(file, 'utf8')).toBe('Personal\n');
  });

  // Windows folders have no POSIX write bit to remove.
  it.skipIf(asRoot || process.platform === 'win32')('skips a tool whose folder is not writable and names nothing it did not write', async () => {
    await mkdir(path.join(root, '.cursor'));
    await chmod(path.join(root, '.cursor'), 0o555);
    try {
      const plan = createPlan([fixtureStack()], ['cursor', 'claude'], { only: 'standards' });
      expect(await install(plan, root, async () => content)).toEqual([
        { path: '.cursor/rules/nextjs-rules.mdc', action: 'skipped (permission denied)' },
        { path: '.claude/rules/nextjs-rules.md', action: 'created' },
      ]);
    } finally { await chmod(path.join(root, '.cursor'), 0o755); }
  });
});
