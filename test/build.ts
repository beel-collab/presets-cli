import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function setup() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  await promisify(execFile)(process.execPath, [path.join(root, 'node_modules/tsup/dist/cli-default.js')], { cwd: root });
}
