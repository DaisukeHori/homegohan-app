/**
 * Vitest integration test config (PR #839 + #840 統合版)
 * Run with: npx vitest run --config vitest.integration.config.ts
 *
 * 用途: 実 Supabase 接続が必要な integration test 専用 config
 *   - tests/integration/handson-tour/ (PR #839 由来)
 *   - tests/integration/operator/ (PR #840 由来)
 *
 * 実行前提:
 *   SUPABASE_INTEGRATION_TEST=1
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   API_BASE_URL or PLAYWRIGHT_BASE_URL (default: http://localhost:3000)
 */
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      'tests/e2e/**',
      'homegohan-app/**',
      '.claude/**',
    ],
    // Integration tests hit real Supabase — allow longer timeouts
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run sequentially to avoid auth rate limits and DB conflicts
    pool: 'forks',
    maxConcurrency: 1,
    maxWorkers: 1,
    env: {
      NODE_ENV: 'test',
    },
  },
});
