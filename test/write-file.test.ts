import fs, { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat, link, open, rename, chmod } from 'node:fs/promises';
import fsSync, { openSync, writeFile as writeFileCallback } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendExisting, readExisting, writeAtomic } from '../src/write-file.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), open: vi.fn(actual.open) };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync), writeFile: vi.fn(actual.writeFile) };
});

let root: string;
let target: string;
const content = Buffer.from('Synthetic export\r\n\u00e9\n');
beforeEach(async () => {
  vi.mocked(link).mockReset().mockImplementation(fs.link);
  vi.mocked(open).mockReset().mockImplementation(fs.open);
  vi.mocked(openSync).mockReset().mockImplementation(fsSync.openSync);
  vi.mocked(writeFileCallback).mockReset().mockImplementation(fsSync.writeFile);
  root = await mkdtemp(path.join(os.tmpdir(), 'presets-write-'));
  target = path.join(root, 'rules.md');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it.each(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'])('falls back to exclusive creation on %s', async (code) => {
  vi.mocked(link).mockRejectedValue(Object.assign(new Error('Unsupported hard link'), { code }));
  expect(await writeAtomic(target, content, false)).toBe(true);
  expect(await readFile(target)).toEqual(content);
  expect(await readdir(root)).toEqual(['rules.md']);
});

it('does not overwrite or delete a file that appears before fallback exclusive creation', async () => {
  vi.mocked(link).mockRejectedValue(Object.assign(new Error('No hard links'), { code: 'ENOTSUP' }));
  vi.mocked(openSync).mockImplementation((...args) => {
    if (args[0] === target) fsSync.writeFileSync(target, 'Other process');
    return fsSync.openSync(...args);
  });
  expect(await writeAtomic(target, content, false)).toBe(false);
  expect(await readFile(target, 'utf8')).toBe('Other process');
});

it('removes its partial fallback file and temporary file if writing fails', async () => {
  vi.mocked(link).mockRejectedValue(Object.assign(new Error('No hard links'), { code: 'ENOTSUP' }));
  vi.mocked(writeFileCallback).mockImplementationOnce((file, _data, callback) => {
    fsSync.writeFileSync(file, 'Partial');
    callback(new Error('Disk write failed'));
  });
  await expect(writeAtomic(target, content, false)).rejects.toThrow('Disk write failed');
  expect(await readdir(root)).toEqual([]);
});

it('does not fall back on unrelated disk errors', async () => {
  vi.mocked(link).mockRejectedValue(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }));
  await expect(writeAtomic(target, content, false)).rejects.toThrow('Disk full');
  expect(open).toHaveBeenCalledTimes(1);
  expect(await readdir(root)).toEqual([]);
});

it('preserves replacement data if a fallback write fails', async () => {
  vi.mocked(link).mockRejectedValue(Object.assign(new Error('No hard links'), { code: 'ENOTSUP' }));
  const replacement = path.join(root, 'replacement.md');
  vi.mocked(writeFileCallback).mockImplementationOnce((_file, _data, callback) => {
    fsSync.writeFileSync(replacement, 'Other process');
    fsSync.renameSync(replacement, target);
    callback(new Error('Disk write failed'));
  });
  const error: unknown = await writeAtomic(target, content, false).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  const code = (error as NodeJS.ErrnoException).code;
  if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
    // The exclusive open can prevent replacement. Cleanup removes only the
    // failed writer's files and leaves the other program's data in its temp.
    expect(await readFile(replacement, 'utf8')).toBe('Other process');
    expect(await readdir(root)).toEqual(['replacement.md']);
  } else {
    expect((error as Error).message).toContain('Disk write failed');
    expect(await readFile(target, 'utf8')).toBe('Other process');
  }
});

// Windows chmod cannot represent POSIX group permission bits.
it.skipIf(process.platform === 'win32')('preserves permission bits even when the creation mask would remove them', async () => {
  const previous = process.umask(0o022);
  try {
    await writeFile(target, 'Original');
    await chmod(target, 0o664);
    await writeAtomic(target, content, true, 0o664);
    expect((await stat(target)).mode & 0o777).toBe(0o664);
  } finally { process.umask(previous); }
});

it('refuses a file that changes between lstat and opening its handle', async () => {
  await writeFile(target, 'Original');
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const replacement = path.join(root, 'replacement.md');
    await writeFile(replacement, 'Other');
    await rename(replacement, target);
    return fs.open(...args);
  });
  await expect(readExisting(target)).rejects.toThrow('File changed while opening');
});

it('rejects directories where a regular file is expected', async () => {
  await mkdir(target);
  await expect(readExisting(target)).rejects.toThrow('not a regular file');
});

it('refuses to rename over a name that gained a hard link after its snapshot', async () => {
  await writeFile(target, 'Original');
  const snapshot = await readExisting(target);
  const other = path.join(root, 'other.md');
  await link(target, other);
  await expect(writeAtomic(target, content, true, snapshot?.mode, snapshot)).rejects.toThrow('hard-linked');
  expect(await readFile(other, 'utf8')).toBe('Original');
  expect((await stat(target)).nlink).toBe(2);
  expect((await readdir(root)).sort()).toEqual(['other.md', 'rules.md']);
});

it('preserves a partial append and reports that the file needs manual repair', async () => {
  await writeFile(target, 'Personal\n');
  const expected = (await readExisting(target))!;
  vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    handle.writeFile = (async (data: Buffer) => {
      await handle.write(data.subarray(0, 5));
      throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
    }) as typeof handle.writeFile;
    return handle;
  });
  await expect(appendExisting(target, Buffer.from('<!-- presets.dev:nextjs:start -->\nNew\n'), expected)).rejects.toThrow(/No space.*by hand/);
  expect(await readFile(target, 'utf8')).toBe('Personal\n<!-- ');
});

it('preserves an editor append during failed-append recovery', async () => {
  await writeFile(target, 'Personal\n');
  const expected = (await readExisting(target))!;
  let saved = false;
  const saveEditorLine = async () => {
    if (saved) return;
    saved = true;
    await fs.appendFile(target, 'Editor line\n');
  };
  vi.mocked(open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (typeof args[1] === 'number') {
      handle.writeFile = (async (data: Buffer) => {
        await handle.write(data.subarray(0, 5));
        throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
      }) as typeof handle.writeFile;
      const close = handle.close.bind(handle);
      handle.close = async () => { await saveEditorLine(); await close(); };
    }
    // Reproduce a save after the former rollback check, before truncation.
    const truncate = handle.truncate.bind(handle);
    handle.truncate = async (size) => { await saveEditorLine(); await truncate(size); };
    return handle;
  });
  await expect(appendExisting(target, Buffer.from('<!-- presets.dev:nextjs:start -->\nNew\n'), expected)).rejects.toThrow(/No space/);
  expect(saved).toBe(true);
  expect(await readFile(target, 'utf8')).toBe('Personal\n<!-- Editor line\n');
});

it('keeps text another program appended when an append fails, and asks for a manual fix', async () => {
  await writeFile(target, 'Personal\n');
  const expected = (await readExisting(target))!;
  vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    handle.writeFile = (async (data: Buffer) => {
      await fs.appendFile(target, 'Editor line\n');
      await handle.write(data.subarray(0, 5));
      throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
    }) as typeof handle.writeFile;
    return handle;
  });
  await expect(appendExisting(target, Buffer.from('<!-- presets.dev:nextjs:start -->\nNew\n'), expected)).rejects.toThrow('by hand');
  expect(await readFile(target, 'utf8')).toBe('Personal\nEditor line\n<!-- ');
});
