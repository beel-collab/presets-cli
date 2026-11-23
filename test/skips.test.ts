import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlan } from '../src/plan.js';
import { install } from '../src/install.js';
import { fixtureStack } from './fixtures/manifest.js';
import { addSkill, hookWriter } from './fixtures/helpers.js';

// Per-file refusals found while writing: each skips only its own file.
let root: string;
let outside: string;
const locked: string[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'presets-skips-'));
  outside = await mkdtemp(path.join(os.tmpdir(), 'presets-skips-outside-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const folder of locked.splice(0)) await chmod(folder, 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
const content = Buffer.from('Synthetic export\n');
async function lock(folder: string) {
  await chmod(folder, 0o555);
  locked.push(folder);
}

// Root ignores write permission, and Windows folders have no write bit.
const posixUser = process.platform !== 'win32' && process.getuid?.() !== 0;

describe.skipIf(!posixUser)('permission skips', () => {
  it.each([false, true])('skips AGENTS.md in a read-only project root and still writes the shared skill (dryRun=%s)', async (dryRun) => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
    await mkdir(path.join(root, '.agents/skills'), { recursive: true });
    await lock(root);
    const result = await install(createPlan([fixtureStack()], ['codex']), root, async () => content, { dryRun });
    expect(result).toEqual([
      { path: 'AGENTS.md', action: 'skipped (permission denied)' },
      { path: '.agents/skills/nextjs-code-review/SKILL.md', action: dryRun ? 'would create' : 'created' },
    ]);
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('Personal\n');
  });

  it('skips AGENTS.md when the root turns read-only during download', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
    await mkdir(path.join(root, '.cursor/rules'), { recursive: true });
    const plan = createPlan([fixtureStack()], ['codex', 'cursor'], { only: 'standards' });
    const result = await install(plan, root, async () => { await lock(root); return content; });
    expect(result).toContainEqual({ path: 'AGENTS.md', action: 'skipped (permission denied)' });
    expect(result).toContainEqual({ path: '.cursor/rules/nextjs-rules.mdc', action: 'created' });
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('Personal\n');
    expect((await readdir(root)).filter((name) => name.startsWith('.presets-'))).toEqual([]);
  });

  it.each([false, true])('installs the tool copies when .agents cannot be searched (dryRun=%s)', async (dryRun) => {
    await mkdir(path.join(root, '.agents/skills'), { recursive: true });
    await chmod(path.join(root, '.agents'), 0o644);
    locked.push(path.join(root, '.agents'));
    const result = await install(createPlan([fixtureStack()], ['cursor', 'codex'], { only: 'skill' }), root, async () => content, { dryRun });
    expect(result).toEqual([
      { path: '.cursor/skills/nextjs-code-review/SKILL.md', action: dryRun ? 'would create' : 'created' },
      { path: '.agents/skills/nextjs-code-review/SKILL.md', action: 'skipped (permission denied)' },
    ]);
  });

  it('skips a rule whose folder becomes unsearchable during download and installs the rest', async () => {
    await mkdir(path.join(root, '.cursor/rules'), { recursive: true });
    const plan = createPlan([fixtureStack()], ['cursor', 'claude'], { only: 'standards' });
    const result = await install(plan, root, async () => {
      await chmod(path.join(root, '.cursor'), 0o644);
      locked.push(path.join(root, '.cursor'));
      return content;
    });
    expect(result).toEqual([
      { path: '.cursor/rules/nextjs-rules.mdc', action: 'skipped (permission denied)' },
      { path: '.claude/rules/nextjs-rules.md', action: 'created' },
    ]);
  });

  it('skips a rule whose folder cannot be created after the parent turns read-only', async () => {
    await mkdir(path.join(root, '.cursor'));
    const plan = createPlan([fixtureStack()], ['cursor', 'claude'], { only: 'standards' });
    expect(await install(plan, root, async () => { await lock(path.join(root, '.cursor')); return content; })).toEqual([
      { path: '.cursor/rules/nextjs-rules.mdc', action: 'skipped (permission denied)' },
      { path: '.claude/rules/nextjs-rules.md', action: 'created' },
    ]);
  });

  it.each([false, true])('reports a tool copy as shared when the shared copy lands, whatever else blocked it (dryRun=%s)', async (dryRun) => {
    await mkdir(path.join(root, '.cursor'));
    await lock(path.join(root, '.cursor'));
    const plan = createPlan([fixtureStack()], ['cursor', 'codex'], { only: 'skill' });
    expect(await install(plan, root, async () => content, { dryRun })).toEqual([
      { path: '.cursor/skills/nextjs-code-review/SKILL.md', action: 'skipped (uses shared .agents/skills/nextjs-code-review)' },
      { path: '.agents/skills/nextjs-code-review/SKILL.md', action: dryRun ? 'would create' : 'created' },
    ]);
  });

  it.each([false, true])('skips a rule in an existing read-only folder (dryRun=%s)', async (dryRun) => {
    await mkdir(path.join(root, '.cursor/rules'), { recursive: true });
    await lock(path.join(root, '.cursor/rules'));
    const plan = createPlan([fixtureStack()], ['cursor', 'claude'], { only: 'standards' });
    expect(await install(plan, root, async () => content, { dryRun })).toEqual([
      { path: '.cursor/rules/nextjs-rules.mdc', action: 'skipped (permission denied)' },
      { path: '.claude/rules/nextjs-rules.md', action: dryRun ? 'would create' : 'created' },
    ]);
  });

  it('skips a rule whose folder turns read-only during download', async () => {
    await mkdir(path.join(root, '.cursor/rules'), { recursive: true });
    const plan = createPlan([fixtureStack()], ['cursor', 'claude'], { only: 'standards' });
    expect(await install(plan, root, async () => { await lock(path.join(root, '.cursor/rules')); return content; })).toEqual([
      { path: '.cursor/rules/nextjs-rules.mdc', action: 'skipped (permission denied)' },
      { path: '.claude/rules/nextjs-rules.md', action: 'created' },
    ]);
  });

  it.each([false, true])('installs the tool copy of a skill when the shared .agents copy cannot be written (dryRun=%s)', async (dryRun) => {
    await mkdir(path.join(root, '.agents'));
    await lock(path.join(root, '.agents'));
    const plan = createPlan([fixtureStack()], ['codex', 'cursor'], { only: 'skill' });
    const result = await install(plan, root, async () => content, { dryRun });
    expect(result).toContainEqual({ path: '.agents/skills/nextjs-code-review/SKILL.md', action: 'skipped (permission denied)' });
    expect(result).toContainEqual({ path: '.cursor/skills/nextjs-code-review/SKILL.md', action: dryRun ? 'would create' : 'created' });
    if (!dryRun) expect(await readFile(path.join(root, '.cursor/skills/nextjs-code-review/SKILL.md'))).toEqual(content);
  });

  it.each([false, true])('skips targets behind a folder that cannot be searched (dryRun=%s)', async (dryRun) => {
    await mkdir(path.join(root, '.claude/rules'), { recursive: true });
    await chmod(path.join(root, '.claude'), 0o644);
    locked.push(path.join(root, '.claude'));
    const plan = createPlan([fixtureStack()], ['claude', 'cursor'], { only: 'standards' });
    expect(await install(plan, root, async () => content, { dryRun })).toEqual([
      { path: '.cursor/rules/nextjs-rules.mdc', action: dryRun ? 'would create' : 'created' },
      { path: '.claude/rules/nextjs-rules.md', action: 'skipped (permission denied)' },
    ]);
  });

  it.each([false, true])('skips an unreadable AGENTS.md (dryRun=%s)', async (dryRun) => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Private\n');
    await chmod(path.join(root, 'AGENTS.md'), 0o000);
    const plan = createPlan([fixtureStack()], ['codex', 'cursor'], { only: 'standards' });
    const result = await install(plan, root, async () => content, { dryRun });
    expect(result).toContainEqual({ path: 'AGENTS.md', action: 'skipped (permission denied)' });
    expect(result).toContainEqual({ path: '.cursor/rules/nextjs-rules.mdc', action: dryRun ? 'would create' : 'created' });
  });

  it('replaces an unreadable rule file under --force without reading it', async () => {
    const file = path.join(root, '.cursor/rules/nextjs-rules.mdc');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'Old');
    await chmod(file, 0o200);
    const plan = createPlan([fixtureStack()], ['cursor'], { only: 'standards' });
    expect(await install(plan, root, async () => content, { force: true })).toEqual([{ path: '.cursor/rules/nextjs-rules.mdc', action: 'replaced' }]);
    await chmod(file, 0o600);
    expect(await readFile(file)).toEqual(content);
  });
});

describe('refusals found while writing', () => {
  it.skipIf(!posixUser)('stops on a symlink to a read-only file planted during download', async () => {
    const target = path.join(outside, 'read-only.md');
    await writeFile(target, 'Outside');
    await chmod(target, 0o444);
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
    const plan = createPlan([fixtureStack()], ['codex'], { only: 'standards' });
    await expect(install(plan, root, async () => {
      await unlink(path.join(root, 'AGENTS.md'));
      await symlink(target, path.join(root, 'AGENTS.md'));
      return content;
    })).rejects.toThrow('Refusing symlink');
    expect(await readFile(target, 'utf8')).toBe('Outside');
  });

  it('skips a rule file that gains a hard link during a forced download', async () => {
    const file = path.join(root, '.cursor/rules/nextjs-rules.mdc');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'Team rule');
    const plan = createPlan([fixtureStack()], ['cursor', 'claude'], { only: 'standards' });
    const result = await install(plan, root, async () => {
      await link(file, path.join(outside, 'rule.mdc')).catch(() => {});
      return content;
    }, { force: true });
    expect(result).toEqual([
      { path: '.cursor/rules/nextjs-rules.mdc', action: 'skipped (file is hard-linked)' },
      { path: '.claude/rules/nextjs-rules.md', action: 'created' },
    ]);
    expect(await readFile(path.join(outside, 'rule.mdc'), 'utf8')).toBe('Team rule');
    expect((await stat(file)).nlink).toBe(2);
    expect((await readdir(path.dirname(file))).filter((name) => name.startsWith('.presets-'))).toEqual([]);
  });

  it('installs the tool copy when the shared write fails after its folder was created', async () => {
    hookWriter({ kind: 'temp-error', code: 'EACCES', match: '.agents' });
    const plan = createPlan([fixtureStack()], ['cursor', 'codex'], { only: 'skill' });
    expect(await install(plan, root, async () => content)).toEqual([
      { path: '.cursor/skills/nextjs-code-review/SKILL.md', action: 'created' },
      { path: '.agents/skills/nextjs-code-review/SKILL.md', action: 'skipped (permission denied)' },
    ]);
    expect(await readdir(path.join(root, '.agents/skills/nextjs-code-review'))).toEqual([]);
    vi.unstubAllEnvs();
    // The empty folder left behind still doesn't count as the shared skill.
    expect((await install(createPlan([fixtureStack()], ['copilot'], { only: 'skill' }), root, async () => content))[0].action).toBe('created');
  });

  it.each(['EACCES', 'EROFS'])('skips a file whose write fails with %s and installs the rest', async (code) => {
    hookWriter({ kind: 'temp-error', code, match: '.cursor' });
    const plan = createPlan([fixtureStack()], ['cursor', 'claude'], { only: 'standards' });
    expect(await install(plan, root, async () => content)).toEqual([
      { path: '.cursor/rules/nextjs-rules.mdc', action: 'skipped (permission denied)' },
      { path: '.claude/rules/nextjs-rules.md', action: 'created' },
    ]);
  });

  it('stops on EPERM while writing, which Windows also uses for a folder in use', async () => {
    hookWriter({ kind: 'temp-error', code: 'EPERM', match: '.cursor' });
    const plan = createPlan([fixtureStack()], ['cursor', 'claude'], { only: 'standards' });
    await expect(install(plan, root, async () => content)).rejects.toThrow('.cursor/rules/nextjs-rules.mdc: EPERM');
  });

  it('never appends through a hard link that appears during download', async () => {
    const file = path.join(root, 'AGENTS.md');
    await writeFile(file, 'Personal\n');
    const plan = createPlan([fixtureStack()], ['codex', 'cursor'], { only: 'standards' });
    const result = await install(plan, root, async () => {
      await link(file, path.join(outside, 'instructions.md')).catch(() => {});
      return content;
    });
    expect(result).toContainEqual({ path: 'AGENTS.md', action: 'skipped (file is hard-linked)' });
    expect(result).toContainEqual({ path: '.cursor/rules/nextjs-rules.mdc', action: 'created' });
    expect(await readFile(path.join(outside, 'instructions.md'), 'utf8')).toBe('Personal\n');
  });

  it('does not count an empty .agents skill folder as the shared skill', async () => {
    await mkdir(path.join(root, '.agents/skills/nextjs-code-review'), { recursive: true });
    const result = await install(createPlan([fixtureStack()], ['cursor'], { only: 'skill' }), root, async () => content);
    expect(result).toEqual([{ path: '.cursor/skills/nextjs-code-review/SKILL.md', action: 'created' }]);
    await addSkill(path.join(root, '.agents/skills/nextjs-code-review'));
    const again = await install(createPlan([fixtureStack()], ['copilot'], { only: 'skill' }), root, async () => content);
    expect(again).toEqual([{ path: '.github/skills/nextjs-code-review/SKILL.md', action: 'skipped (uses shared .agents/skills/nextjs-code-review)' }]);
  });

  it.each([false, true])('judges the shared skill by its SKILL.md, not by supporting files (dryRun=%s)', async (dryRun) => {
    const stack = fixtureStack();
    for (const entry of stack.entries.filter((item) => item.role === 'skill' && ['cursor', 'codex'].includes(item.tool))) {
      entry.exports.push(entry.exports[0].replace('SKILL.md', 'references/a.md'));
    }
    await mkdir(path.join(root, '.agents/skills/nextjs-code-review/SKILL.md'), { recursive: true });
    const result = await install(createPlan([stack], ['cursor', 'codex'], { only: 'skill' }), root, async () => content, { dryRun });
    const write = dryRun ? 'would create' : 'created';
    expect(result).toEqual([
      { path: '.cursor/skills/nextjs-code-review/SKILL.md', action: write },
      { path: '.cursor/skills/nextjs-code-review/references/a.md', action: write },
      { path: '.agents/skills/nextjs-code-review/SKILL.md', action: 'skipped (not a regular file)' },
      { path: '.agents/skills/nextjs-code-review/references/a.md', action: write },
    ]);
  });

  it.each([false, true].flatMap((dryRun) => [false, true].map((force) => ({ dryRun, force }))))('reports an existing tool copy the same way on every run once the shared skill lands (dryRun=$dryRun, force=$force)', async ({ dryRun, force }) => {
    await addSkill(path.join(root, '.cursor/skills/nextjs-code-review'));
    const plan = createPlan([fixtureStack()], ['cursor', 'codex'], { only: 'skill' });
    expect(await install(plan, root, async () => content, { dryRun, force })).toEqual([
      { path: '.cursor/skills/nextjs-code-review/SKILL.md', action: 'skipped (uses shared .agents/skills/nextjs-code-review)' },
      { path: '.agents/skills/nextjs-code-review/SKILL.md', action: dryRun ? 'would create' : 'created' },
    ]);
    if (dryRun) return;
    expect(await readFile(path.join(root, '.cursor/skills/nextjs-code-review/SKILL.md'), 'utf8')).toBe('Shared skill');
    expect((await install(plan, root, async () => content, { force }))[0].action).toBe('skipped (uses shared .agents/skills/nextjs-code-review)');
  });

  it.each([false, true])('writes .agents once and skips the tool copy when both are planned (dryRun=%s)', async (dryRun) => {
    const plan = createPlan([fixtureStack()], ['cursor', 'codex'], { only: 'skill' });
    const result = await install(plan, root, async () => content, { dryRun });
    expect(result).toEqual([
      { path: '.cursor/skills/nextjs-code-review/SKILL.md', action: 'skipped (uses shared .agents/skills/nextjs-code-review)' },
      { path: '.agents/skills/nextjs-code-review/SKILL.md', action: dryRun ? 'would create' : 'created' },
    ]);
    await expect(stat(path.join(root, '.cursor'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(!posixUser).each([false, true])('skips Cline when .clinerules links into a folder it cannot search, and installs the rest (dryRun=%s)', async (dryRun) => {
    await mkdir(path.join(outside, 'private/rules'), { recursive: true });
    await chmod(path.join(outside, 'private'), 0o600);
    locked.push(path.join(outside, 'private'));
    await symlink(path.join(outside, 'private/rules'), path.join(root, '.clinerules'));
    const plan = createPlan([fixtureStack()], ['cursor', 'cline'], { only: 'standards' });
    expect(await install(plan, root, async () => content, { dryRun })).toEqual([
      { path: '.cursor/rules/nextjs-rules.mdc', action: dryRun ? 'would create' : 'created' },
      { path: '.clinerules/nextjs-rules.md', action: 'skipped (folder is a symlink)' },
    ]);
  });

  it.each([false, true])('skips Cline when .clinerules is a symlink loop (dryRun=%s)', async (dryRun) => {
    await symlink('.clinerules', path.join(root, '.clinerules'));
    const plan = createPlan([fixtureStack()], ['cursor', 'cline'], { only: 'standards' });
    expect(await install(plan, root, async () => content, { dryRun })).toEqual([
      { path: '.cursor/rules/nextjs-rules.mdc', action: dryRun ? 'would create' : 'created' },
      { path: '.clinerules/nextjs-rules.md', action: 'skipped (folder is a symlink)' },
    ]);
  });

  it.each([false, true])('installs the tool copy when .agents is a symlink loop (dryRun=%s)', async (dryRun) => {
    await symlink('.agents', path.join(root, '.agents'));
    const plan = createPlan([fixtureStack()], ['cursor', 'codex'], { only: 'skill' });
    expect(await install(plan, root, async () => content, { dryRun })).toEqual([
      { path: '.cursor/skills/nextjs-code-review/SKILL.md', action: dryRun ? 'would create' : 'created' },
      { path: '.agents/skills/nextjs-code-review/SKILL.md', action: 'skipped (folder is a symlink)' },
    ]);
  });
});

describe.skipIf(!posixUser)('read-only section files', () => {
  const section = '<!-- presets.dev:nextjs:start -->\nOld\n<!-- presets.dev:nextjs:end -->\n';
  it.each([
    ...[false, true].map((dryRun) => ({ dryRun, text: `Personal\n\n${section}`, action: 'skipped (exists)' })),
    ...[false, true].map((dryRun) => ({ dryRun, text: `Personal\n\n${section}${section}`, action: 'skipped (malformed presets.dev markers)' })),
  ])('reports a read-only AGENTS.md by its section state (dryRun=$dryRun, $action)', async ({ dryRun, text, action }) => {
    await writeFile(path.join(root, 'AGENTS.md'), text);
    await chmod(path.join(root, 'AGENTS.md'), 0o444);
    const result = await install(createPlan([fixtureStack()], ['codex'], { only: 'standards' }), root, async () => content, { dryRun });
    expect(result).toEqual([{ path: 'AGENTS.md', action }]);
  });
});

describe('text encoding', () => {
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# Rules\r\n', 'utf16le')]);
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('# Rules\r\n', 'utf16le').swap16()]);
  const bomless = Buffer.from('# Rules\r\n', 'utf16le');
  it.each([false, true].flatMap((dryRun) => [utf16le, utf16be, bomless].map((bytes) => ({ dryRun, bytes }))))('skips a UTF-16 AGENTS.md instead of corrupting it (dryRun=$dryRun)', async ({ dryRun, bytes }) => {
    await writeFile(path.join(root, 'AGENTS.md'), bytes);
    const result = await install(createPlan([fixtureStack()], ['codex'], { only: 'standards' }), root, async () => content, { dryRun });
    expect(result).toEqual([{ path: 'AGENTS.md', action: 'skipped (unsupported text encoding)' }]);
    expect(await readFile(path.join(root, 'AGENTS.md'))).toEqual(bytes);
  });
  it('still appends to a UTF-8 AGENTS.md with a byte-order mark', async () => {
    const bytes = Buffer.from('﻿# Rules\n');
    await writeFile(path.join(root, 'AGENTS.md'), bytes);
    const result = await install(createPlan([fixtureStack()], ['codex'], { only: 'standards' }), root, async () => content);
    expect(result).toEqual([{ path: 'AGENTS.md', action: 'appended' }]);
    expect((await readFile(path.join(root, 'AGENTS.md'))).subarray(0, bytes.length)).toEqual(bytes);
  });
});

describe('leftover temporary links', () => {
  it.each([false, true])('ignores and removes a leftover .presets temp linked to the target (dryRun=%s)', async (dryRun) => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
    const temp = path.join(root, '.presets-00000000-0000-0000-0000-000000000000.tmp');
    await link(path.join(root, 'AGENTS.md'), temp);
    const result = await install(createPlan([fixtureStack()], ['codex'], { only: 'standards' }), root, async () => content, { dryRun });
    expect(result).toEqual([{ path: 'AGENTS.md', action: dryRun ? 'would append' : 'appended' }]);
    expect((await readdir(root)).includes(path.basename(temp))).toBe(dryRun);
  });
  it('still refuses a hard link that is not a presets temp file', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal\n');
    await link(path.join(root, 'AGENTS.md'), path.join(root, 'notes.md'));
    const result = await install(createPlan([fixtureStack()], ['codex'], { only: 'standards' }), root, async () => content);
    expect(result).toEqual([{ path: 'AGENTS.md', action: 'skipped (file is hard-linked)' }]);
  });
});

describe('writer process edge cases', () => {
  it('reads the writer result even when a preload prints to stdout', async () => {
    hookWriter({ kind: 'stdout-noise' });
    const result = await install(createPlan([fixtureStack()], ['cursor'], { only: 'standards' }), root, async () => content);
    expect(result).toEqual([{ path: '.cursor/rules/nextjs-rules.mdc', action: 'created' }]);
  });

  it('keeps a tool skill whole when the shared copy appears mid-run', async () => {
    const stack = fixtureStack();
    stack.entries.find((entry) => entry.tool === 'cursor' && entry.role === 'skill')!.exports
      .push('release/nextjs/native/cursor/.cursor/skills/nextjs-code-review/references/guide.md');
    hookWriter({ kind: 'shared-after-first-link', shared: path.join(root, '.agents/skills/nextjs-code-review/SKILL.md') });
    const result = await install(createPlan([stack], ['cursor'], { only: 'skill' }), root, async () => content);
    expect(result).toEqual([
      { path: '.cursor/skills/nextjs-code-review/SKILL.md', action: 'created' },
      { path: '.cursor/skills/nextjs-code-review/references/guide.md', action: 'created' },
    ]);
  });
});
