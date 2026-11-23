export const TOOLS = ['cursor', 'copilot', 'claude', 'windsurf', 'cline', 'codex', 'antigravity'] as const;
export type Tool = (typeof TOOLS)[number];
export type Role = 'standards' | 'skill';

export interface Entry {
  tool: Tool;
  role: Role;
  exports: string[];
}

export interface Stack {
  id: string;
  status: string;
  entries: Entry[];
}

export interface Manifest {
  stacks: Stack[];
}

export class PresetsError extends Error {
  constructor(message: string, public readonly exitCode = 1) {
    super(message);
  }
}

export type SkipAction = 'skipped (exists)' | `skipped (uses shared ${string})` | `skipped (same file as ${string})` | 'skipped (legacy .clinerules file)'
  | 'skipped (needs a newer presets-dev)' | 'skipped (folder is a symlink)' | 'skipped (file is a symlink)' | 'skipped (file is hard-linked)'
  | 'skipped (AGENTS.md is a symlink)' | 'skipped (GEMINI.md is a symlink; use --agents-md)' | 'skipped (parent folder is a file)'
  | 'skipped (not a regular file)' | 'skipped (permission denied)' | 'skipped (malformed presets.dev markers)'
  | 'skipped (export contains presets.dev markers)' | 'skipped (unsupported text encoding)';

export const isSkipped = (action: string): boolean => action.startsWith('skipped');

// A tool's own skill copy left out because the tool reads the shared .agents/skills copy.
export const usesShared = (sharedSkill: string): SkipAction => `skipped (uses shared ${sharedSkill})`;

// A refusal that concerns one target only: it is reported as that file's
// skip and the other files still install, as long as nothing was published.
export class SkipFileError extends PresetsError {
  constructor(public readonly action: SkipAction) {
    super(action);
  }
}

export function parseTools(value: string): Tool[] {
  const ids = value.split(',').map((id) => id.trim());
  for (const id of ids) {
    if (!TOOLS.includes(id as Tool)) {
      throw new PresetsError(`Unknown tool "${id}". Valid tools: ${TOOLS.join(', ')}.`);
    }
  }
  return [...new Set(ids)] as Tool[];
}
