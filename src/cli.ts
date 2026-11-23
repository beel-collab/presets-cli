#!/usr/bin/env node
import { Command, Option } from 'commander';
import pc from 'picocolors';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import packageInfo from '../package.json' with { type: 'json' };
import { ContentClient, DEFAULT_REF } from './fetch.js';
import { listStacks, loadManifest, selectStacks } from './manifest.js';
import { createPlan } from './plan.js';
import { install, type InstallResult } from './install.js';
import { chooseTools } from './detect.js';
import { PartialInstallError } from './writer-client.js';
import { isSkipped, PresetsError, parseTools, type Role } from './types.js';

interface AddOptions {
  tool?: string; only?: Role; dryRun?: boolean; force?: boolean; agentsMd?: boolean; geminiMd?: boolean;
  ref: string; cwd: string; yes?: boolean;
}

function printResults(results: InstallResult[]): void {
  for (const result of results) console.log(`${isSkipped(result.action) ? pc.dim(result.action) : pc.green(result.action)} ${result.path}`);
}

const program = new Command().name('presets-dev').description('Install presets.dev rules and skills for your AI coding tools.').version(packageInfo.version);

program.command('add').description('Install one or more stacks').argument('<stack...>')
  .option('-t, --tool <tool,...>', 'Tool ids, separated by commas (default: auto-detect)')
  .addOption(new Option('--only <role>', 'Install just one role').choices(['standards', 'skill']))
  .option('--dry-run', 'Print the plan without writing files')
  .option('--force', 'Replace existing preset files or marked sections')
  .option('--agents-md', 'Append Antigravity standards to AGENTS.md')
  .option('--gemini-md', 'Keep Antigravity standards in GEMINI.md even when Codex is selected')
  .option('--ref <ref>', 'Content git ref', DEFAULT_REF)
  .option('--cwd <dir>', 'Project root', process.cwd())
  .option('-y, --yes', 'Use detected tools without prompting')
  .action(async (ids: string[], options: AddOptions) => {
    let directory;
    try { directory = await stat(options.cwd); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new PresetsError(`Project directory does not exist: ${options.cwd}`);
      throw new PresetsError(`Cannot access project directory ${options.cwd}: ${(error as Error).message}`);
    }
    if (!directory.isDirectory()) throw new PresetsError(`Not a project directory: ${options.cwd}`);
    // Every later check looks inside it, so one that can't be searched would
    // only show up as a skip for every file.
    await access(options.cwd, constants.X_OK).catch((error: unknown) => {
      throw new PresetsError(`Cannot access project directory ${options.cwd}: ${(error as Error).message}`);
    });
    const explicit = options.tool === undefined ? undefined : parseTools(options.tool);
    const tools = explicit ?? await chooseTools(options.cwd, options.yes);
    if (options.agentsMd && options.geminiMd) throw new PresetsError('Pass either --agents-md or --gemini-md, not both.');
    // Antigravity reads AGENTS.md as well as GEMINI.md, so with Codex selected a
    // GEMINI.md copy would load the same standards twice.
    const shareAgentsMd = !options.agentsMd && !options.geminiMd && options.only !== 'skill'
      && tools.includes('codex') && tools.includes('antigravity');
    if (shareAgentsMd) {
      options.agentsMd = true;
      console.log(pc.dim('Antigravity CLI reads AGENTS.md too, so its standards go there once. Pass --gemini-md for a separate GEMINI.md.'));
    }
    const client = new ContentClient(options.ref);
    const manifest = await loadManifest(client);
    const stacks = selectStacks(manifest, ids);
    const plan = createPlan(stacks, tools, options);
    const results = await install(plan, options.cwd, (source) => client.download(source), options);
    printResults(results);
    const skipped = results.filter((result) => isSkipped(result.action)).length;
    console.log(`${options.dryRun ? 'Dry run: ' : ''}${results.length - skipped} file action(s), ${skipped} skipped. https://presets.dev`);
  });

program.command('list').description('List installable stacks and their skills')
  .option('--json', 'Print machine-readable JSON')
  .option('-t, --tool <tool>', 'Filter to one tool')
  .option('--ref <ref>', 'Content git ref', DEFAULT_REF)
  .action(async (options: { json?: boolean; tool?: string; ref: string }) => {
    const tools = options.tool === undefined ? undefined : parseTools(options.tool);
    if (tools && tools.length !== 1) throw new PresetsError('list --tool accepts exactly one tool.');
    const rows = listStacks(await loadManifest(new ContentClient(options.ref)), tools?.[0]);
    if (options.json) console.log(JSON.stringify(rows, null, 2));
    else for (const row of rows) console.log(`${row.id}\t${row.skills.join(', ')}`);
  });

program.parseAsync().catch((error: unknown) => {
  // Files written before the failure stay on disk, so say which ones.
  if (error instanceof PartialInstallError && error.results.length) {
    console.log('Completed before the error:');
    printResults(error.results);
  }
  console.error(pc.red((error as Error).message));
  process.exitCode = error instanceof PresetsError ? error.exitCode : 1;
});
