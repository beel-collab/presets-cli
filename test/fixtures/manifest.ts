import { TOOLS, type Entry, type Manifest, type Stack } from '../../src/types.js';

// Synthetic content only: no third-party presets are checked into this repo.
export function fixtureStack(id = 'nextjs'): Stack {
  const rules = {
    cursor: `.cursor/rules/${id}-rules.mdc`, copilot: `.github/instructions/${id}.instructions.md`,
    claude: `.claude/rules/${id}-rules.md`, windsurf: `.devin/rules/${id}-rules.md`,
    cline: `.clinerules/${id}-rules.md`, codex: `AGENTS.${id}-section.md`, antigravity: `GEMINI.${id}-section.md`,
  };
  const skills = {
    cursor: '.cursor', copilot: '.github', claude: '.claude', windsurf: '.devin',
    cline: '.cline', codex: '.agents', antigravity: '.agents',
  };
  const entries: Entry[] = TOOLS.flatMap((tool) => [
    { tool, role: 'standards', exports: [`release/${id}/native/${tool}/${rules[tool]}`] },
    { tool, role: 'skill', exports: [`release/${id}/native/${['codex', 'antigravity'].includes(tool) ? 'agents' : tool}/${skills[tool]}/skills/${id}-code-review/SKILL.md`] },
  ]);
  return { id, status: 'complete', entries };
}

export function fixtureManifest(): Manifest {
  return { stacks: [fixtureStack(), fixtureStack('react'), { ...fixtureStack('unfinished'), status: 'draft' }] };
}
