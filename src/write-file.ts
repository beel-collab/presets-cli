import { link, lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, writeFile } from 'node:fs';
import { promisify } from 'node:util';
import { isMissing } from './paths.js';
import { PresetsError, SkipFileError } from './types.js';

export function sameFile(a: Pick<Stats, 'dev' | 'ino'>, b: Pick<Stats, 'dev' | 'ino'>): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

// Appending would change the file's other names too, and renaming over it
// would silently split them apart, so both are refused for that file.
const hardLinked = () => new SkipFileError('skipped (file is hard-linked)');

export interface FileSnapshot {
  bytes: Buffer;
  mode: number;
  links: number;
  identity: Pick<Stats, 'dev' | 'ino'>;
}

// The worker calls these operations with a basename in its pinned working
// directory. No write resolves the project directory path a second time.
export async function readExisting(file: string): Promise<FileSnapshot | undefined> {
  let before: Stats;
  try { before = await lstat(file); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  if (before.isSymbolicLink()) throw new PresetsError(`Refusing symlink: ${file}`);
  if (!before.isFile()) throw new SkipFileError('skipped (not a regular file)');
  const handle = await open(file, 'r');
  try {
    if (!sameFile(before, await handle.stat())) throw new PresetsError(`File changed while opening: ${file}`);
    return { bytes: await handle.readFile(), mode: before.mode & 0o7777, links: before.nlink, identity: { dev: before.dev, ino: before.ino } };
  } finally { await handle.close(); }
}

export async function appendExisting(file: string, bytes: Buffer, expected: FileSnapshot, onPublished?: () => void): Promise<boolean> {
  let handle;
  // No O_CREAT: a disappearing file must be re-read or created exclusively.
  try { handle = await open(file, constants.O_RDWR | constants.O_APPEND); }
  catch (error) { if (isMissing(error)) return false; throw error; }
  try {
    const opened = await handle.stat();
    if (!sameFile(opened, expected.identity) || !(await handle.readFile()).equals(expected.bytes)) return false;
    const named = await lstat(file).catch((error: unknown) => { if (isMissing(error)) return undefined; throw error; });
    if (!named || named.isSymbolicLink() || !sameFile(named, opened)) return false;
    if ((await handle.stat()).nlink > 1) throw hardLinked();
    // O_APPEND preserves text saved in place after the snapshot check.
    try { await handle.writeFile(bytes); }
    catch (error) {
      // External writers do not share our lock, so truncating a partial
      // append could remove their edits made during error recovery.
      throw new PresetsError(`${file}: ${(error as Error).message}. Inspect the file and remove any unfinished presets.dev section by hand before retrying.`);
    }
    onPublished?.();
    const current = await lstat(file).catch((error: unknown) => { if (isMissing(error)) return undefined; throw error; });
    return Boolean(current && !current.isSymbolicLink() && sameFile(current, opened));
  } finally { await handle.close(); }
}

const writeDescriptor = promisify(writeFile);

async function writeExclusive(file: string, bytes: Buffer, onPublished?: () => void): Promise<boolean> {
  let descriptor;
  try { descriptor = openSync(file, 'wx'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  let complete = false;
  let created: Stats | undefined;
  try {
    // Register ownership before yielding so signals can clean a partial write.
    created = fstatSync(descriptor);
    liveExclusiveFiles.set(file, created);
    await writeDescriptor(descriptor, bytes);
    complete = true;
    liveExclusiveFiles.delete(file);
    onPublished?.();
    return true;
  } finally {
    try { closeSync(descriptor); }
    finally {
      try {
        if (!complete && created) {
          const current = await lstat(file).catch((error: unknown) => { if (isMissing(error)) return undefined; throw error; });
          if (current && sameFile(current, created)) await unlink(file);
        }
      } finally { liveExclusiveFiles.delete(file); }
    }
  }
}

const TEMP_NAME = /^\.presets-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

// A crash between link() and unlink() in writeAtomic leaves our temp file as a
// second name for the target. Those names are ours, so they must not make the
// target count as hard-linked. Returns their paths inside folder.
export async function leftoverTemps(folder: string, target: Pick<Stats, 'dev' | 'ino'>): Promise<string[]> {
  const names = await readdir(folder).catch(() => [] as string[]);
  const found: string[] = [];
  for (const name of names.filter((entry) => TEMP_NAME.test(entry))) {
    const info = await lstat(path.join(folder, name)).catch(() => undefined);
    if (info?.isFile() && sameFile(info, target)) found.push(path.join(folder, name));
  }
  return found;
}

// The worker uses basenames here and keeps its cwd pinned until cleanup ends.
export const liveTemps = new Set<string>();
export const liveExclusiveFiles = new Map<string, Pick<Stats, 'dev' | 'ino'>>();

export async function writeAtomic(file: string, bytes: Buffer, replace: boolean, mode?: number, expected?: FileSnapshot, onPublished?: () => void): Promise<boolean> {
  const temp = path.join(path.dirname(file), `.presets-${randomUUID()}.tmp`);
  liveTemps.add(temp);
  try {
    const handle = await open(temp, 'wx', mode);
    try {
      await handle.writeFile(bytes);
      // Creation modes are filtered by umask; chmod restores the exact bits.
      if (mode !== undefined) await handle.chmod(mode);
    } finally { await handle.close(); }
    if (replace) {
      // Checked just before the rename so a link added meanwhile is refused.
      if (expected) {
        const current = await readExisting(file);
        if (current && current.links > 1) throw hardLinked();
        if (!current || !sameFile(current.identity, expected.identity) || !current.bytes.equals(expected.bytes) || current.mode !== expected.mode) {
          throw new PresetsError(`File changed during installation: ${file}. Retry when other editors have finished saving.`);
        }
      } else {
        const current = await lstat(file).catch((error: unknown) => { if (isMissing(error)) return undefined; throw error; });
        if (current?.isSymbolicLink()) throw new PresetsError(`Refusing symlink: ${file}`);
        if (current && current.nlink > 1) throw hardLinked();
      }
      // This detects observed edits; it is not compare-and-swap against editors.
      await rename(temp, file);
    }
    else {
      try { await link(temp, file); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') return false;
        if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes(code ?? '')) return await writeExclusive(file, bytes, onPublished);
        throw error;
      }
    }
    // Publication succeeded even if temporary-file cleanup subsequently fails.
    onPublished?.();
    return true;
  } finally {
    try { await unlink(temp).catch((error: unknown) => { if (!isMissing(error)) throw error; }); }
    finally { liveTemps.delete(temp); }
  }
}
