/**
 * Vitest integration test config
 * Run with: npx vitest run --config vitest.integration.config.ts
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      'tests/e2e/**',
      'homegohan-app/**',
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Integration tests run sequentially to avoid DB conflicts
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
    },
  },
});
