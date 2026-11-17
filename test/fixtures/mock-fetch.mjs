import { readFileSync } from 'node:fs';
import process from 'node:process';

const { Response } = globalThis;

const fixture = JSON.parse(readFileSync(process.env.PRESETS_TEST_FIXTURE, 'utf8'));
globalThis.fetch = async (url) => {
  const base = 'https://raw.githubusercontent.com/beel-collab/presets.dev/';
  if (!url.startsWith(base + fixture.ref + '/')) throw new Error('Unexpected URL: ' + url);
  const file = url.slice((base + fixture.ref + '/').length);
  if (file === fixture.manifestPath) return new Response(JSON.stringify(fixture.manifest));
  if (file === fixture.fail) return new Response('unavailable', { status: 503 });
  if (!fixture.manifest.stacks.some((stack) => stack.entries.some((entry) => entry.exports.includes(file)))) {
    return new Response('not found', { status: 404 });
  }
  return new Response('Synthetic native export\n');
};
