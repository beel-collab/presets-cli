import { defineConfig } from 'tsup';

// Shared by `npm run build` and the test setup, so tests run what ships.
export default defineConfig({ entry: ['src/cli.ts', 'src/writer.ts'], format: ['esm'], target: 'node22', clean: true });
