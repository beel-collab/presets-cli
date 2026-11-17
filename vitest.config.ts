import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { restoreMocks: true, maxWorkers: 2, globalSetup: ['test/build.ts'] } });
