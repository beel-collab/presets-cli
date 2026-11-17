import { describe, expect, it } from 'vitest';
import { createPlan } from '../src/plan.js';
import { TOOLS, type Tool } from '../src/types.js';
import { fixtureStack } from './fixtures/manifest.js';

describe('native install plan', () => {
  const targets: Record<Tool, string[]> = {
    cursor: ['.cursor/rules/nextjs-rules.mdc', '.cursor/skills/nextjs-code-review/SKILL.md'],
    copilot: ['.github/instructions/nextjs.instructions.md', '.github/skills/nextjs-code-review/SKILL.md'],
    claude: ['.claude/rules/nextjs-rules.md', '.claude/skills/nextjs-code-review/SKILL.md'],
    windsurf: ['.devin/rules/nextjs-rules.md', '.devin/skills/nextjs-code-review/SKILL.md'],
    cline: ['.clinerules/nextjs-rules.md', '.cline/skills/nextjs-code-review/SKILL.md'],
    codex: ['AGENTS.md', '.agents/skills/nextjs-code-review/SKILL.md'],
    antigravity: ['GEMINI.md', '.agents/skills/nextjs-code-review/SKILL.md'],
  };
  it.each(TOOLS)('maps every native export for %s', (tool) => {
    const plan = createPlan([fixtureStack()], [tool]);
    expect(plan.files.map((item) => item.target)).toEqual(targets[tool]);
    expect(plan.files.every((item) => item.source.startsWith('release/'))).toBe(true);
    expect(plan.unsupported).toEqual([]);
    expect(plan.files[0].mode).toBe(['codex', 'antigravity'].includes(tool) ? 'section' : 'file');
  });

  it('deduplicates shared skills and optional AGENTS sections', () => {
    const stacks = [fixtureStack()];
    expect(createPlan(stacks, ['codex', 'antigravity']).files.map((item) => item.target)).toEqual([
      'AGENTS.md', '.agents/skills/nextjs-code-review/SKILL.md', 'GEMINI.md',
    ]);
    expect(createPlan(stacks, ['codex', 'antigravity'], { agentsMd: true }).files).toHaveLength(2);
    expect(createPlan(stacks, ['antigravity'], { agentsMd: true }).files[0].target).toBe('AGENTS.md');
  });

  it('supports multiple stacks and role filtering', () => {
    for (const only of ['standards', 'skill'] as const) {
      const plan = createPlan([fixtureStack(), fixtureStack('react')], ['cursor'], { only });
      expect(plan.files).toHaveLength(2);
      expect(plan.files.every((file) => (only === 'skill') === file.target.endsWith('SKILL.md'))).toBe(true);
    }
  });

  it.each([false, true])('prefers Codex for shared AGENTS sections independently of manifest order (reverse=%s)', (reverse) => {
    const stack = fixtureStack();
    const original = [...stack.entries];
    if (reverse) stack.entries.reverse();
    const plan = createPlan([stack], ['antigravity', 'codex'], { agentsMd: true });
    expect(plan.files.filter((file) => file.mode === 'section').map((file) => file.source)).toEqual([
      'release/nextjs/native/codex/AGENTS.nextjs-section.md',
    ]);
    expect(stack.entries).toEqual(reverse ? original.reverse() : original);
    const antigravity = createPlan([stack], ['antigravity'], { agentsMd: true });
    expect(antigravity.files.find((file) => file.mode === 'section')?.source).toBe('release/nextjs/native/antigravity/GEMINI.nextjs-section.md');
  });

  it('accepts supporting files inside skill folders and nested rule folders', () => {
    const stack = fixtureStack();
    const skill = stack.entries.find((entry) => entry.tool === 'claude' && entry.role === 'skill')!;
    skill.exports.push('release/nextjs/native/claude/.claude/skills/nextjs-code-review/references/checklist.md');
    const rules = stack.entries.find((entry) => entry.tool === 'claude' && entry.role === 'standards')!;
    rules.exports.push('release/nextjs/native/claude/.claude/rules/nextjs/testing.md');
    expect(createPlan([stack], ['claude']).files.map((file) => file.target)).toEqual([
      '.claude/rules/nextjs-rules.md', '.claude/rules/nextjs/testing.md',
      '.claude/skills/nextjs-code-review/SKILL.md', '.claude/skills/nextjs-code-review/references/checklist.md',
    ]);
  });

  it.each([
    ['cursor', 'standards', 'release/nextjs/native/cursor/package.json'],
    ['cursor', 'standards', 'release/nextjs/native/cursor/.cursor/rules/notes.txt'],
    ['claude', 'skill', 'release/nextjs/native/claude/.claude/skills/stray.md'],
    ['copilot', 'standards', 'release/nextjs/native/copilot/.github/copilot-instructions.md'],
    ['codex', 'standards', 'release/nextjs/native/codex/AGENTS.other-section.md'],
    ['codex', 'skill', 'release/nextjs/native/codex/.agents/skills/x/SKILL.md'],
    ['windsurf', 'standards', 'release/nextjs/native/windsurf-next/.devin/rules/x.md'],
    ['cursor', 'standards', 'release/other/native/cursor/.cursor/rules/rules.md'],
    ['cursor', 'standards', 'release/nextjs/native/windsurf/.windsurf/rules/rules.md'],
    ['cursor', 'standards', 'release/nextjs/native/cursor/C:\\escape'],
    ['cursor', 'standards', 'release/nextjs/native/cursor/.cursor/rules/%2e%2e/escape.md'],
    ['claude', 'skill', 'release/nextjs/native/claude/.claude/skills/nextjs-code-review/references/api+v2.md'],
    ['claude', 'skill', 'release/nextjs/native/claude/.claude/skills/nextjs-code-review/My File.md'],
    ['claude', 'skill', 'release/nextjs/native/claude/.claude/skills/nextjs-code-review/caf\u00e9.md'],
    ['claude', 'skill', 'release/nextjs/native/claude/.claude/skills/nextjs-code-review/assets/'],
    ['cursor', 'standards', 'release/nextjs/native/cursor//absolute.mdc'],
    ['cursor', 'standards', 'https://evil.test/file'],
  ] as const)('marks export layouts this version does not know as unsupported (%s %s: %s)', (tool, role, source) => {
    const stack = fixtureStack();
    stack.entries.find((entry) => entry.tool === tool && entry.role === role)!.exports.push(source);
    const plan = createPlan([stack, fixtureStack('react')], [tool]);
    expect(plan.unsupported).toEqual([{ stack: 'nextjs', source }]);
    expect(plan.files.map((file) => file.source)).not.toContain(source);
    expect(plan.files.filter((file) => file.stack === 'react')).toHaveLength(2);
  });

  it('keeps the Antigravity AGENTS section when the Codex one is unsupported', () => {
    const stack = fixtureStack();
    stack.entries.find((entry) => entry.tool === 'codex' && entry.role === 'standards')!.exports = ['release/nextjs/native/codex/AGENTS.md'];
    const sections = createPlan([stack], ['codex', 'antigravity'], { agentsMd: true, only: 'standards' });
    expect(sections.files.map((file) => [file.target, file.source])).toEqual([
      ['AGENTS.md', 'release/nextjs/native/antigravity/GEMINI.nextjs-section.md'],
    ]);
    expect(sections.unsupported).toEqual([{ stack: 'nextjs', source: 'release/nextjs/native/codex/AGENTS.md' }]);
  });

  it('reports an unsupported export shared by Codex and Antigravity once', () => {
    const stack = fixtureStack();
    const source = 'release/nextjs/native/agents/.agents/workflows/deploy.md';
    for (const entry of stack.entries) if (entry.role === 'skill' && ['codex', 'antigravity'].includes(entry.tool)) entry.exports.push(source);
    expect(createPlan([stack], ['codex', 'antigravity'], { only: 'skill' }).unsupported).toEqual([{ stack: 'nextjs', source }]);
  });

  it.each([
    '/etc/passwd', 'release/nextjs/native/cursor/../../outside',
    'release/nextjs/native/cursor/.cursor/../outside.md',
    'release/nextjs/native/cursor/..\\..\\outside',
    '\\\\server\\share', 'C:\\Windows\\x.md', 'C:/x.md',
    'release/nextjs/native/cursor/.cursor/rules/a.mdc\ncreated .cursor/rules/evil.mdc',
    'release/nextjs/native/cursor/.cursor/rules/\u001b[31mred.mdc',
    'release/nextjs/native/cursor/.cursor/rules/\u202eevil.mdc',
  ])('rejects dangerous exports: %j', (source) => {
    const stack = fixtureStack();
    stack.entries[0].exports = [source];
    expect(() => createPlan([stack], ['cursor'])).toThrow();
  });
});
