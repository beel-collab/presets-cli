import { classifyPath } from './paths.js';
import { PresetsError, type Entry, type Role, type Stack, type Tool } from './types.js';

export interface FileAction {
  stack: string;
  source: string;
  target: string;
  mode: 'file' | 'section';
  sharedSkill?: string;
  // The skill folder name, for skill exports (SKILL.md and supporting files).
  skill?: string;
}

// An export whose layout this CLI version does not know yet.
export interface UnsupportedExport { stack: string; source: string }

export interface Plan { files: FileAction[]; unsupported: UnsupportedExport[] }

export interface PlanOptions { only?: Role; agentsMd?: boolean }

const ruleRoots: Partial<Record<Tool, string>> = {
  cursor: '.cursor/rules/', copilot: '.github/instructions/', claude: '.claude/rules/',
  windsurf: '.devin/rules/', cline: '.clinerules/',
};
const skillRoots: Record<Tool, string> = {
  cursor: '.cursor/skills/', copilot: '.github/skills/', claude: '.claude/skills/',
  windsurf: '.devin/skills/', cline: '.cline/skills/', codex: '.agents/skills/', antigravity: '.agents/skills/',
};

type Resolved = Pick<FileAction, 'target' | 'mode' | 'sharedSkill' | 'skill'>;

// Maps one export to its project path, or undefined when this CLI version does
// not know the layout, so content can add layouts without breaking installs.
// parseManifest already drops dangerous paths; the throw keeps that guarantee
// for direct callers, so the unsupported list is always safe to print.
function resolveExport(stack: string, entry: Entry, source: string, agentsMd: boolean): Resolved | undefined {
  const kind = classifyPath(source);
  if (kind === 'dangerous') throw new PresetsError(`Unsafe export path: ${JSON.stringify(source)}`);
  if (kind === 'unsupported') return undefined;
  const shared = entry.role === 'skill' && (entry.tool === 'codex' || entry.tool === 'antigravity');
  const prefix = `release/${stack}/native/${shared ? 'agents' : entry.tool}/`;
  if (!source.startsWith(prefix)) return undefined;
  const path = source.slice(prefix.length);
  if (entry.role === 'skill') {
    const root = skillRoots[entry.tool];
    const tail = path.slice(root.length);
    // A skill folder may carry supporting files (references/, scripts/) next to SKILL.md.
    if (!path.startsWith(root) || !tail.includes('/')) return undefined;
    const readsShared = entry.tool === 'cursor' || entry.tool === 'copilot' || entry.tool === 'windsurf';
    const skill = tail.split('/')[0];
    return { target: path, mode: 'file', skill, ...(readsShared ? { sharedSkill: `.agents/skills/${skill}` } : {}) };
  }
  if (entry.tool === 'codex' || entry.tool === 'antigravity') {
    if (path !== `${entry.tool === 'codex' ? 'AGENTS' : 'GEMINI'}.${stack}-section.md`) return undefined;
    return { target: entry.tool === 'codex' || agentsMd ? 'AGENTS.md' : 'GEMINI.md', mode: 'section' };
  }
  const root = ruleRoots[entry.tool]!;
  return path.startsWith(root) && /\.(md|mdc)$/.test(path) ? { target: path, mode: 'file' } : undefined;
}

// With --agents-md, Codex and Antigravity standards both resolve to the stack's
// AGENTS.md section. Ordering Codex first lets the dedupe below keep Codex's
// section whenever it is installable, and Antigravity's otherwise.
const codexStandardsFirst = (entry: Entry) => Number(!(entry.tool === 'codex' && entry.role === 'standards'));

// Pure: paths and selection come from the manifest; existing files are handled
// by the executor.
export function createPlan(stacks: Stack[], tools: Tool[], options: PlanOptions = {}): Plan {
  const plan: Plan = { files: [], unsupported: [] };
  const keys = new Set<string>();
  for (const stack of stacks) {
    const entries = options.agentsMd ? [...stack.entries].sort((a, b) => codexStandardsFirst(a) - codexStandardsFirst(b)) : stack.entries;
    for (const entry of entries) {
      if (!tools.includes(entry.tool) || (options.only && entry.role !== options.only)) continue;
      for (const source of entry.exports) {
        const resolved = resolveExport(stack.id, entry, source, Boolean(options.agentsMd));
        // Codex and Antigravity share skill exports, so both kinds are deduplicated.
        const key = resolved ? `${resolved.target}:${resolved.mode === 'section' ? stack.id : ''}` : `unsupported:${source}`;
        if (keys.has(key)) continue;
        keys.add(key);
        if (resolved) plan.files.push({ stack: stack.id, source, ...resolved });
        else plan.unsupported.push({ stack: stack.id, source });
      }
    }
  }
  return plan;
}
