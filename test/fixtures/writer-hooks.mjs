import fs from 'node:fs/promises';
import fsSync, { renameSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { constants } from 'node:fs';

// Loaded only by test child processes through Node's standard --import flag.
if (process.argv[1]?.endsWith('writer.js') && process.env.PRESETS_TEST_WRITER_HOOK) {
  const hook = JSON.parse(process.env.PRESETS_TEST_WRITER_HOOK);
  const originalOpen = fs.open;
  let swapped = false;
  let edited = false;
  const edit = async () => {
    if (edited) return;
    edited = true;
    if (hook.style === 'atomic') {
      await fs.writeFile('editor-save.tmp', hook.content);
      await fs.rename('editor-save.tmp', 'AGENTS.md');
    } else await fs.writeFile('AGENTS.md', hook.content);
  };
  if (hook.kind === 'stdout-noise') process.stdout.write('Debugger preload says hello\n');
  if (hook.kind === 'shared-after-first-link') {
    const originalLink = fs.link;
    let done = false;
    fs.link = async (...args) => {
      await originalLink(...args);
      if (!done) { done = true; await fs.mkdir(path.dirname(hook.shared), { recursive: true }); await fs.writeFile(hook.shared, 'Shared skill'); }
    };
  }
  if (hook.kind === 'fast-timeout') {
    let now = Date.now();
    Date.now = () => { now += 6_000; return now; };
  }
  if (hook.kind === 'swap-on-chdir') {
    const chdir = process.chdir.bind(process);
    process.chdir = (directory) => {
      if (!swapped && directory === path.basename(hook.parent)) {
        swapped = true;
        renameSync(hook.parent, hook.moved);
        symlinkSync(hook.outside, hook.parent, 'dir');
      }
      chdir(directory);
    };
  }
  if (hook.kind === 'signal-after-link' || hook.kind === 'signal-after-swap') {
    const originalLink = fs.link;
    fs.link = async (...args) => {
      await originalLink(...args);
      if (hook.kind === 'signal-after-swap') {
        await fs.rename(hook.parent, hook.moved);
        await fs.symlink(hook.outside, hook.parent, 'dir');
        await fs.writeFile(path.join(hook.outside, path.basename(args[0])), 'Unrelated outside file');
        if (hook.section) await fs.mkdir(path.join(hook.outside, '.presets-AGENTS.md.lock'));
      }
      process.kill(process.pid, 'SIGINT');
      await delay(5_000);
    };
  }
  if (hook.kind === 'cleanup-failure') {
    const originalUnlink = fs.unlink;
    fs.unlink = async (file) => {
      if (String(file).endsWith('.tmp')) throw Object.assign(new Error('Temporary cleanup denied'), { code: 'EACCES' });
      return originalUnlink(file);
    };
    if (hook.fallback) fs.link = async () => { throw Object.assign(new Error('No hard links'), { code: 'ENOTSUP' }); };
  }
  if (hook.kind === 'publish-failure') {
    fs.link = async () => { throw Object.assign(new Error('Publication failed'), { code: 'ENOSPC' }); };
  }
  if (hook.kind === 'signal-during-exclusive' || hook.kind === 'signal-after-exclusive-open') {
    fs.link = async () => { throw Object.assign(new Error('No hard links'), { code: 'ENOTSUP' }); };
    const originalOpenSync = fsSync.openSync;
    let exclusiveDescriptor;
    fsSync.openSync = (file, ...args) => {
      const descriptor = originalOpenSync(file, ...args);
      if (file === hook.target && args[0] === 'wx') {
        exclusiveDescriptor = descriptor;
        if (hook.kind === 'signal-after-exclusive-open') process.kill(process.pid, hook.signal);
      }
      return descriptor;
    };
    const originalWriteFile = fsSync.writeFile;
    fsSync.writeFile = (file, bytes, callback) => {
      if (file !== exclusiveDescriptor) return originalWriteFile(file, bytes, callback);
      // The signal handler runs on a later event-loop turn; hold the write so
      // a fast write cannot finish first and leave a complete file behind.
      if (hook.kind === 'signal-after-exclusive-open') {
        delay(5_000).then(() => originalWriteFile(file, bytes, callback));
        return;
      }
      originalWriteFile(file, bytes.subarray(0, 5), async (error) => {
        if (error) { callback(error); return; }
        if (hook.replace) {
          await fs.rename(hook.target, `${hook.target}.interrupted`);
          await fs.writeFile(hook.target, 'Other process');
        }
        process.kill(process.pid, hook.signal);
        await delay(5_000);
      });
    };
  }
  fs.open = async (file, ...args) => {
    const appending = file === 'AGENTS.md' && typeof args[0] === 'number' && Boolean(args[0] & constants.O_APPEND);
    if (hook.kind === 'edit-on-append-open' && appending) await edit();
    if (hook.kind === 'edit-on-temp' && path.basename(file).startsWith('.presets-') && String(file).endsWith('.tmp')) await edit();
    if (hook.kind === 'swap-on-write' && !swapped && path.basename(file).startsWith('.presets-') && String(file).endsWith('.tmp')) {
      swapped = true;
      await fs.rename(hook.parent, hook.moved);
      await fs.symlink(hook.outside, hook.parent, 'dir');
    }
    // A write that fails with the given code, only inside folders matching hook.match.
    if (hook.kind === 'temp-error' && path.basename(file).startsWith('.presets-') && String(file).endsWith('.tmp') && process.cwd().includes(hook.match)) {
      throw Object.assign(new Error(`${hook.code}: injected write failure`), { code: hook.code });
    }
    if (hook.kind === 'signal-on-temp' && path.basename(file).startsWith('.presets-') && String(file).endsWith('.tmp')) {
      process.kill(process.pid, hook.signal);
      await delay(5_000);
    }
    const handle = await originalOpen(file, ...args);
    if (hook.kind === 'append-close-failure' && appending) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); throw new Error('Append close failed'); };
    }
    if (hook.kind === 'edit-on-append-write' && appending) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...options) => { await edit(); return write(...options); };
    }
    if (hook.kind === 'pause-read' && file === 'AGENTS.md' && args[0] === 'r') {
      const read = handle.readFile.bind(handle);
      handle.readFile = async (...options) => {
        const snapshot = await read(...options);
        await delay(100);
        return snapshot;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
}
