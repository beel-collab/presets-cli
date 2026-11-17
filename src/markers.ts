import { PresetsError, SkipFileError } from './types.js';

export function sectionMarkers(stack: string): { start: string; end: string } {
  return { start: `<!-- presets.dev:${stack}:start -->`, end: `<!-- presets.dev:${stack}:end -->` };
}

// Any stack's marker inside downloaded content would leave a file that later
// installs reject as malformed, and --force could not repair it.
export function containsMarkers(content: string): boolean {
  return /<!-- presets\.dev:[^\s:]+:(?:start|end) -->/.test(content);
}

function hasMalformedMarkers(existing: string, stack: string): boolean {
  const { start, end } = sectionMarkers(stack);
  const from = existing.indexOf(start);
  const to = existing.indexOf(end);
  return (from >= 0 || to >= 0) && (from < 0 || to < from || existing.indexOf(start, from + start.length) >= 0
    || existing.indexOf(end, to + end.length) >= 0);
}

// Sections are spliced in as ASCII bytes, which is only valid in UTF-8 (or
// ASCII-compatible) text. UTF-16 and UTF-32 files start with a byte-order mark
// or contain NUL bytes; appending to them would corrupt the file.
const WIDE_TEXT = /^(?:\xff\xfe|\xfe\xff)|\0/;

// existing is the file decoded as latin1, so each code unit is one byte.
export function updateSection(existing: string, content: string, stack: string, force = false): { text: string; skipped: boolean; append?: string } {
  if (containsMarkers(content)) throw new PresetsError(`Preset content for ${stack} contains presets.dev markers.`);
  if (WIDE_TEXT.test(existing)) throw new SkipFileError('skipped (unsupported text encoding)');
  // Stray marker text is the user's to repair; it skips only this file.
  if (hasMalformedMarkers(existing, stack)) throw new SkipFileError('skipped (malformed presets.dev markers)');
  const { start, end } = sectionMarkers(stack);
  const from = existing.indexOf(start);
  const to = existing.indexOf(end);
  if (from >= 0 && !force) return { text: existing, skipped: true };
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const normalized = content.replace(/\r\n|\r|\n/g, eol).replace(/(?:\r?\n)+$/, '');
  if (from >= 0) {
    const replaced = existing.slice(0, from + start.length) + eol + normalized + eol + existing.slice(to);
    return { text: replaced.endsWith('\n') ? replaced : replaced + eol, skipped: false };
  }
  let separator = '';
  if (existing && !/(?:\r?\n){2}$/.test(existing)) separator = existing.endsWith('\n') ? eol : eol + eol;
  const append = `${separator}${start}${eol}${normalized}${eol}${end}${eol}`;
  return { text: existing + append, skipped: false, append };
}
