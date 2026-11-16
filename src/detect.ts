import { lstat } from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { isAbsent, isPermissionError } from './paths.js';
import { PresetsError, TOOLS, type Tool } from './types.js';

export const SIGNALS: Record<Tool, string[]> = {
  cursor: ['.cursor', '.cursorrules'], copilot: ['.github/copilot-instructions.md', '.github/instructions'],
  claude: ['.claude', 'CLAUDE.md'], windsurf: ['.devin', '.windsurf', '.windsurfrules'],
  cline: ['.clinerules', '.cline'], codex: ['AGENTS.md', '.codex'], antigravity: ['GEMINI.md', '.gemini'],
};
export const NO_TOOL_MESSAGE = `No AI tool detected. Pass --tool <${TOOLS.join('|')}>.`;

export async function detectTools(root: string): Promise<Tool[]> {
  const detected = await Promise.all(TOOLS.map(async (tool) => {
    for (const signal of SIGNALS[tool]) {
      // The CLI only runs this in a project folder it can search, so a
      // permission error means a nested signal sits in a folder that exists.
      // Count it, so the install reports the permission skip instead of
      // silently dropping the tool.
      try { await lstat(path.join(root, signal)); return tool; }
      catch (error) {
        if (isPermissionError(error)) return tool;
        if (!isAbsent(error)) throw error;
      }
    }
    return undefined;
  }));
  return detected.filter((tool): tool is Tool => tool !== undefined);
}

export async function chooseTools(root: string, yes = false, interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)): Promise<Tool[]> {
  const detected = await detectTools(root);
  if (detected.length === 1 || (detected.length > 1 && (yes || !interactive))) return detected;
  if (!interactive || yes) throw new PresetsError(NO_TOOL_MESSAGE);
  const result = await prompts({
    type: 'multiselect', name: 'tools', message: 'Install presets for which tools?', min: 1,
    choices: TOOLS.map((tool) => ({ title: tool, value: tool, selected: detected.includes(tool) })),
    hint: 'Space to select, Enter to install',
  }, { onCancel: () => { throw new PresetsError('Installation cancelled.'); } });
  if (!result.tools?.length) throw new PresetsError('Select at least one tool.');
  return result.tools as Tool[];
}
