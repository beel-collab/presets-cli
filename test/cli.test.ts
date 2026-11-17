import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureManifest } from './fixtures/manifest.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const mock = new URL('fixtures/mock-fetch.mjs', import.meta.url).href;
let root: string;
let config: string;
let fixture: { ref: string; manifestPath: string; manifest: ReturnType<typeof fixtureManifest>; fail?: string };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'presets-cli-'));
  config = path.join(root, 'fixture.json');
  fixture = { ref: 'main', manifestPath: 'release/original-2026-11/stacks.json', manifest: fixtureManifest() };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function run(args: string[]) {
  await writeFile(config, JSON.stringify(fixture));
  try {
    const result = await exec(process.execPath, ['--import', mock, path.join(repo, 'dist/cli.js'), ...args], {
      cwd: root, env: { ...process.env, PRESETS_TEST_FIXTURE: config, PRESETS_MANIFEST: fixture.manifestPath, NO_COLOR: '1' },
    });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as { stdout: string; stderr: string; code: number };
    return result;
  }
}

describe('built CLI', () => {
  it('lists complete stacks as JSON and supports help/version', async () => {
    const result = await run(['list', '--json', '--tool', 'cursor']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(2);
    expect((await run(['--help'])).stdout).toContain('add');
    expect((await run(['--version'])).stdout.trim()).toBe('0.1.1');
  });
  it('adds multiple stacks, filters roles, and respects --ref and --cwd', async () => {
    fixture.ref = 'test-tag';
    const result = await run(['add', 'nextjs', 'react', '--tool', 'cursor', '--only', 'standards', '--ref', 'test-tag', '--cwd', root]);
    expect(result.code).toBe(0);
    expect(await readFile(path.join(root, '.cursor/rules/nextjs-rules.mdc'), 'utf8')).toBe('Synthetic native export\n');
    expect(await readdir(path.join(root, '.cursor'))).toEqual(['rules']);
    expect(result.stdout).toContain('2 file action(s)');
  });
  it('prints a full dry run without any install writes', async () => {
    const result = await run(['add', 'nextjs', '--tool', 'cursor', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('would create .cursor/rules/nextjs-rules.mdc');
    expect(result.stdout).toContain('would create .cursor/skills/nextjs-code-review/SKILL.md');
    expect(await readdir(root)).toEqual(['fixture.json']);
  });
  it('preserves existing instructions, is idempotent, and supports --agents-md', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Personal\r\n');
    const args = ['add', 'nextjs', '--tool', 'codex,antigravity', '--agents-md'];
    expect((await run(args)).code).toBe(0);
    const first = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(first.startsWith('Personal\r\n')).toBe(true);
    expect(first.match(/nextjs:start/g)).toHaveLength(1);
    expect((await run(args)).stdout).toContain('skipped (exists)');
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe(first);
    expect(await readdir(root)).not.toContain('GEMINI.md');
  });
  it('exits 1 for unknown ids, invalid roles, and no-tool --yes', async () => {
    expect((await run(['add', 'nextj', '--tool', 'cursor'])).stderr).toContain('Did you mean nextjs');
    const badTool = await run(['add', 'nextjs', '--tool', 'bad']);
    expect(badTool.code).toBe(1);
    expect(badTool.stderr).toContain('Valid tools');
    expect((await run(['add', 'nextjs', '--only', 'agent'])).code).toBe(1);
    const noTool = await run(['add', 'nextjs', '--yes']);
    expect(noTool.code).toBe(1);
    expect(noTool.stderr).toContain('No AI tool detected. Pass --tool <');
  });
  it.each([{ tool: [] }, { tool: ['--tool', 'cursor'] }])('rejects a missing project directory before detection or downloads ($tool)', async ({ tool }) => {
    // An unsafe manifest override would fail first if directory validation were late.
    fixture.manifestPath = '../invalid-manifest.json';
    const missing = path.join(root, 'missing');
    const result = await run(['add', 'nextjs', '--cwd', missing, '--yes', ...tool]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Project directory does not exist: ${missing}`);
    expect(result.stderr).not.toMatch(/ENOENT|No AI tool detected|Unsafe relative path/);
    expect(await readdir(root)).toEqual(['fixture.json']);
  });
  // Root ignores search permission, and Windows folders have no search bit.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each([{ tool: [] }, { tool: ['--tool', 'cursor'] }])('rejects a project directory it cannot search ($tool)', async ({ tool }) => {
    const project = path.join(root, 'project');
    await mkdir(path.join(project, '.cursor'), { recursive: true });
    await chmod(project, 0o600);
    try {
      const result = await run(['add', 'nextjs', '--cwd', project, '--yes', ...tool]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Cannot access project directory ${project}`);
      expect(result.stdout).not.toContain('skipped');
      expect(result.stderr).not.toContain('No AI tool detected');
    } finally { await chmod(project, 0o755); }
  });
  it('rejects a file passed as the project directory', async () => {
    const result = await run(['add', 'nextjs', '--cwd', config, '--yes']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Not a project directory: ${config}`);
  });
  it('exits 2 on a later download failure and leaves no installed files', async () => {
    fixture.fail = fixture.manifest.stacks[0].entries[1].exports[0];
    const result = await run(['add', 'nextjs', '--tool', 'cursor']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`https://raw.githubusercontent.com/beel-collab/presets.dev/main/${fixture.fail}`);
    expect(await readdir(root)).toEqual(['fixture.json']);
  });
  it('rejects a malicious manifest before writing', async () => {
    fixture.manifest.stacks[0].entries[0].exports = ['release/nextjs/native/cursor/../../escape.md'];
    expect((await run(['add', 'nextjs', '--tool', 'cursor', '--force'])).code).toBe(1);
    expect(await readdir(root)).toEqual(['fixture.json']);
  });

  it('counts unsupported exports as skipped in the summary', async () => {
    const entry = fixture.manifest.stacks[0].entries.find((item) => item.tool === 'cursor' && item.role === 'standards')!;
    entry.exports.push('release/nextjs/native/cursor/.cursor/rules/a.txt', 'release/nextjs/native/cursor-next/.cursor/rules/b.mdc');
    const result = await run(['add', 'nextjs', '--tool', 'cursor']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('skipped (needs a newer presets-dev) release/nextjs/native/cursor/.cursor/rules/a.txt');
    expect(result.stdout).toContain('2 file action(s), 2 skipped.');
  });

  it('reports a legacy Cline conflict and still installs Cline skills and other tools', async () => {
    await writeFile(path.join(root, '.clinerules'), 'Personal rules');
    const result = await run(['add', 'nextjs', '--tool', 'cline,cursor', '--force']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('skipped (legacy .clinerules file) .clinerules/nextjs-rules.md');
    expect(result.stdout).toContain('3 file action(s), 1 skipped.');
    expect(await readFile(path.join(root, '.clinerules'), 'utf8')).toBe('Personal rules');
    expect(await readFile(path.join(root, '.cline/skills/nextjs-code-review/SKILL.md'), 'utf8')).toBe('Synthetic native export\n');
    expect(await readFile(path.join(root, '.cursor/rules/nextjs-rules.mdc'), 'utf8')).toBe('Synthetic native export\n');
  });
});
