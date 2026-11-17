import { describe, expect, it } from 'vitest';
import { classifyPath, isSafeRelative } from '../src/paths.js';

// Matching control characters is the purpose of this pattern.
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const pieces = ['a', 'b.md', '..', '.', '', 'x y', 'caf\u00e9', '+', 'C:', '\\', '/', '\n', '\u001b[31m', '\u202e', '\u0085', '%2e', '~', '@'];

// Every combination of up to four pieces, plus the pieces joined by '/'.
function* corpus(): Generator<string> {
  for (const a of pieces) for (const b of pieces) for (const c of pieces) {
    yield a + b + c;
    yield [a, b, c].join('/');
    for (const d of pieces) yield [a, b, c, d].join('/');
  }
}

describe('classifyPath', () => {
  it.each([
    ['release/x/native/cursor/.cursor/rules/a.mdc', 'safe'],
    ['a/b/c.md', 'safe'],
    ['a/x y.md', 'unsupported'],
    ['a/caf\u00e9.md', 'unsupported'],
    ['a//b.md', 'unsupported'],
    ['a/b/', 'unsupported'],
    ['a/./b.md', 'unsupported'],
    ['a\\b.md', 'unsupported'],
    ['https://evil.test/x', 'unsupported'],
    ['', 'dangerous'],
    ['/etc/passwd', 'dangerous'],
    ['\\\\server\\share', 'dangerous'],
    ['C:\\x.md', 'dangerous'],
    ['a/../b.md', 'dangerous'],
    ['a\\..\\b.md', 'dangerous'],
    ['a/b.md\ncreated evil', 'dangerous'],
    ['a/\u001b[31mred.md', 'dangerous'],
    ['a/\u202eevil.md', 'dangerous'],
  ])('classifies %j as %s', (value, kind) => {
    expect(classifyPath(value)).toBe(kind);
  });

  it('never lets a printable class contain traversal or terminal control', () => {
    let checked = 0;
    for (const value of corpus()) {
      const kind = classifyPath(value);
      checked++;
      if (kind === 'dangerous') continue;
      expect(TERMINAL_CONTROL.test(value), value).toBe(false);
      expect(value.split(/[/\\]/).includes('..'), value).toBe(false);
      expect(/^([/\\]|[a-zA-Z]:)/.test(value), value).toBe(false);
      if (kind === 'safe') {
        expect(isSafeRelative(value)).toBe(true);
        expect(value.split('/').every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..'), value).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(100_000);
  });
});
