import { safeRelative } from './paths.js';
import { PresetsError } from './types.js';

export const RAW_BASE = 'https://raw.githubusercontent.com/beel-collab/presets.dev/';
export const MANIFEST_PATH = 'release/original-2026-11/stacks.json';

function validateRef(ref: string): void {
  const invalidPart = ref.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'));
  const control = [...ref].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127);
  const forbidden = ['~', '^', ':', '?', '*', '[', '\\'].some((char) => ref.includes(char));
  if (!ref || invalidPart || control || ref === '@' || ref.endsWith('.') || ref.includes('..')
    || ref.includes('@{') || forbidden) throw new PresetsError(`Invalid Git ref: ${ref}`);
}

export class ContentClient {
  constructor(private readonly ref = 'main', private readonly request: typeof fetch = fetch) {
    validateRef(ref);
  }

  url(file: string): string {
    safeRelative(file);
    return `${RAW_BASE}${this.ref.split('/').map(encodeURIComponent).join('/')}/${file}`;
  }

  async download(file: string): Promise<Buffer> {
    const url = this.url(file);
    try {
      const response = await this.request(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        // An unread body keeps the connection busy and can delay exit.
        await response.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new PresetsError(`Failed to fetch ${url}: ${(error as Error).message}`, 2);
    }
  }
}
