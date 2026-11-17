import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { vi } from 'vitest';

// Loads writer-hooks.mjs into the writer process with the given hook.
export function hookWriter(hook: object): void {
  const preload = new URL('./writer-hooks.mjs', import.meta.url).href;
  vi.stubEnv('NODE_OPTIONS', `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`);
  vi.stubEnv('PRESETS_TEST_WRITER_HOOK', JSON.stringify(hook));
}

// A shared skill counts as present once its SKILL.md exists.
export async function addSkill(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'SKILL.md'), 'Shared skill');
}
