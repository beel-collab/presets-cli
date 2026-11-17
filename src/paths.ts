import path from 'node:path';
import { lstat, stat } from 'node:fs/promises';
import { PresetsError } from './types.js';

// The single rule for every path that comes from the manifest:
// - 'safe': the CLI may download, write, and print it (plain ASCII segments).
// - 'unsupported': harmless but unusual (spaces, Unicode, '.', empty or
//   trailing segments); never written, reported as needing a newer CLI.
// - 'dangerous': escapes its base (leading slash or backslash, a drive
//   letter, any '..' segment) or would control the terminal when printed
//   (C0/C1 control characters, bidirectional overrides). It disables the stack.
// Invariant, tested: 'safe' and 'unsupported' strings never contain anything
// that makes a string 'dangerous', so both are safe to print.
export type PathClass = 'safe' | 'unsupported' | 'dangerous';

const SAFE_SEGMENT = /^[a-zA-Z0-9_.-]+$/;
// Matching control characters is the purpose of this pattern.
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export function classifyPath(value: string): PathClass {
  if (!value || /^[/\\]/.test(value) || /^[a-zA-Z]:/.test(value) || TERMINAL_CONTROL.test(value)
    || value.split(/[/\\]/).includes('..')) return 'dangerous';
  return value.split('/').every((part) => SAFE_SEGMENT.test(part) && part !== '.') ? 'safe' : 'unsupported';
}

export function isSafeRelative(value: string): boolean {
  return classifyPath(value) === 'safe';
}

export function safeRelative(value: string): string {
  if (!isSafeRelative(value)) throw new PresetsError(`Unsafe relative path: ${JSON.stringify(value)}`);
  return value;
}

// What blocks writing a project path: 'parent' when a folder on the way is a
// symlink (such as .claude linked to a dotfiles repo), 'target' when the file
// itself is, 'not-a-folder' when a folder on the way is a regular file (such
// as a .github file), 'not-a-file' when the target exists but is not a
// regular file (such as an AGENTS.md folder), 'denied' when a folder on the
// way cannot be searched, or undefined. A missing part ends the walk.
export type Blocker = 'parent' | 'target' | 'not-a-folder' | 'not-a-file' | 'denied';
export async function blockerOnPath(root: string, relative: string): Promise<Blocker | undefined> {
  destination(root, relative);
  const parts = relative.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (isAbsent(error)) return undefined;
      if (isPermissionError(error)) return 'denied';
      throw error;
    }
    if (info.isSymbolicLink()) return index === parts.length - 1 ? 'target' : 'parent';
    if (index < parts.length - 1 && !info.isDirectory()) return 'not-a-folder';
    if (index === parts.length - 1 && !info.isFile()) return 'not-a-file';
  }
  return undefined;
}

export function destination(root: string, relative: string): string {
  safeRelative(relative);
  const resolved = path.resolve(root, relative);
  const within = path.relative(path.resolve(root), resolved);
  if (!within || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new PresetsError(`Path escapes project root: ${relative}`);
  }
  return resolved;
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

// Missing, under something that isn't a folder, or behind a symlink loop.
export function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return isMissing(error) || code === 'ENOTDIR' || code === 'ELOOP';
}

// EACCES and EROFS always mean missing permission. EPERM does too for the
// planner's read-only checks, but Windows also reports a folder that is in use
// with it, so the writer passes { writing: true } for everything it does and
// stops the install on EPERM instead.
export function isPermissionError(error: unknown, { writing = false } = {}): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EROFS' || (!writing && code === 'EPERM');
}

// The one rule for read-only checks: a path that can't be seen (absent, a
// symlink loop, no search permission) counts as not there. Writes never rely
// on it; the blocker walk and the writer report such targets per file.
export function isUnseen(error: unknown): boolean {
  return isAbsent(error) || isPermissionError(error);
}

// Whether a project path resolves to a regular file. Read-only, so it may
// follow links.
export async function fileAt(root: string, relative: string): Promise<boolean> {
  try { return (await stat(destination(root, relative))).isFile(); }
  catch (error) { if (isUnseen(error)) return false; throw error; }
}

// A shared skill counts as present once its SKILL.md is a file. An empty or
// unsearchable folder (say, left by a failed write) doesn't, so the tool's
// own copy still installs.
export function sharedSkillPresent(root: string, skill: string): Promise<boolean> {
  return fileAt(root, `${skill}/SKILL.md`);
}
