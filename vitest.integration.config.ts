/**
 * Vitest integration test config (PR #839 + #840 統合版)
 * Run with: npx vitest run --config vitest.integration.config.ts
 *
 * 用途: Supabase 接続が必要な integration test 専用 config
 *   - tests/integration/handson-tour/ (PR #839 由来)
 *   - tests/integration/operator/ (PR #840 由来)
 *   接続先はローカル Supabase (bash scripts/supabase-local.sh start / env .env.local)。本番には向けない。
 *   手順は CONTRIBUTING.md の「Vitest — インテグレーションテスト」を参照。
 *
 * 実行前提:
 *   SUPABASE_INTEGRATION_TEST=1
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   INTEGRATION_BASE_URL or NEXT_PUBLIC_APP_URL (default: http://localhost:3000。tests/integration/helpers/api.ts が参照)
 */
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  // .env.local を明示的に読み込む (prefix '' = 全変数対象)
  const env = loadEnv(mode ?? 'test', process.cwd(), '');
  return {
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
        ...env,
      },
      setupFiles: ['./tests/integration/setup.ts'],
    },
  };
});
