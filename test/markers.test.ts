import { describe, expect, it } from 'vitest';
import { updateSection } from '../src/markers.js';

describe('marked shared sections', () => {
  it('preserves existing text, separates with one blank line, and is idempotent', () => {
    const first = updateSection('# Personal instructions\n', 'Synthetic rules\n', 'nextjs');
    expect(first.text).toBe('# Personal instructions\n\n<!-- presets.dev:nextjs:start -->\nSynthetic rules\n<!-- presets.dev:nextjs:end -->\n');
    expect(updateSection(first.text, 'Different rules', 'nextjs')).toEqual({ text: first.text, skipped: true });
  });
  it('replaces only the marked contents with force', () => {
    const first = updateSection('My rules', 'Old rules', 'nextjs').text + '\nMy footer\n';
    expect(updateSection(first, 'New rules', 'nextjs', true).text).toBe(first.replace('Old rules', 'New rules'));
  });
  it('preserves CRLF and normalizes downloaded line endings', () => {
    const first = updateSection('Personal\r\n', 'Line one\nLine two\n', 'nextjs').text;
    expect(first.replaceAll('\r\n', '')).not.toContain('\n');
    const replaced = updateSection(first, 'Updated\nRules\n', 'nextjs', true).text;
    expect(replaced.replaceAll('\r\n', '')).not.toContain('\n');
    expect(replaced.endsWith('\r\n')).toBe(true);
  });
  it('creates missing files and appends independent stacks', () => {
    const first = updateSection('', 'First', 'nextjs').text;
    expect(updateSection(first, 'Second', 'react').text).toContain('nextjs:end -->\n\n<!-- presets.dev:react:start -->');
  });

  it('preserves existing trailing blank lines and exposes only the appended suffix', () => {
    const existing = 'Personal instructions\n\n\n';
    const section = updateSection(existing, 'New rules', 'nextjs');
    expect(section.text).toBe(existing + section.append);
    expect(section.append?.startsWith('<!-- presets.dev:nextjs:start -->')).toBe(true);
  });
  it.each([
    '<!-- presets.dev:nextjs:start -->', '<!-- presets.dev:nextjs:end -->',
    '<!-- presets.dev:nextjs:end --><!-- presets.dev:nextjs:start -->',
    '<!-- presets.dev:nextjs:start --><!-- presets.dev:nextjs:start --><!-- presets.dev:nextjs:end -->',
  ])('rejects malformed markers without modifying user content', (text) => {
    expect(() => updateSection(text, 'Rules', 'nextjs', true)).toThrow('malformed presets.dev markers');
  });
  it.each(['<!-- presets.dev:nextjs:end -->', '<!-- presets.dev:react:start -->'])('rejects content that carries its own markers (%s)', (marker) => {
    expect(() => updateSection('Personal\n', `Rules\n${marker}\n`, 'nextjs')).toThrow('contains presets.dev markers');
  });
});
