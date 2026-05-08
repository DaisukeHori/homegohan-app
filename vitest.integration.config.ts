import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // Integration tests hit real Supabase — allow longer timeouts
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run sequentially to avoid auth rate limits
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
