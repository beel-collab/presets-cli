import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PresetsError } from './types.js';
import type { InstallResult } from './install.js';
import type { FileAction } from './plan.js';

export interface WriteRequest {
  root: string;
  identity: { dev: number; ino: number };
  force: boolean;
  files: { file: FileAction; content: string }[];
}

export interface WriteResponse {
  results: InstallResult[];
  error?: { message: string; exitCode: number };
}

// The worker failed after writing some files; `results` lists what it did.
export class PartialInstallError extends PresetsError {
  constructor(message: string, exitCode: number, public readonly results: InstallResult[]) {
    super(message, exitCode);
  }
}

export function commitFiles(request: WriteRequest): Promise<InstallResult[]> {
  return new Promise((resolve, reject) => {
    // Source modules and bundled modules both resolve the shipped dist worker.
    const worker = fileURLToPath(new URL('../dist/writer.js', import.meta.url));
    const child = spawn(process.execPath, [worker], { cwd: request.root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    // An early worker failure is reported by close/error, rather than EPIPE.
    child.stdin.on('error', () => {});
    child.once('close', (code) => {
      try {
        // The response is the last line; a NODE_OPTIONS preload may print first.
        const response = JSON.parse(stdout.trimEnd().split('\n').pop() ?? '') as WriteResponse;
        if (response.error) reject(new PartialInstallError(response.error.message, response.error.exitCode, response.results));
        else if (code !== 0) reject(new PresetsError(`Preset writer failed: ${stderr || code}`));
        else resolve(response.results);
      } catch { reject(new PresetsError(`Preset writer failed: ${stderr || `exit ${code}`}`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
