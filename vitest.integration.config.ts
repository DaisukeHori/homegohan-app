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
import fs from 'node:fs';

// tsconfig.json の paths (`@/*` → `./src/*` と `./*`) と同じ解決をする。vitest.config.ts と同じ作り。
// `@` を src だけに向けると、ルート直下の lib/ (lib/supabase/server.ts など) を import するアプリのモジュールを、
// 結合テストから読めない (T15: 同意を記録するモジュールを実 DB に対してテストするために揃えた)。
// Vite の alias は 1 つのキーに複数の行き先を持てないので、src → ルートの順に探す resolver にしている。
function atAliasPlugin() {
  const root = __dirname;
  return {
    name: 'at-alias',
    resolveId(id: string) {
      if (!id.startsWith('@/')) return undefined;
      const rel = id.slice(2); // "@/" を外す
      for (const base of ['src', '.']) {
        for (const ext of ['', '.ts', '.tsx', '.js', '.jsx']) {
          const candidate = path.join(root, base, rel + ext);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        }
        for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
          const candidate = path.join(root, base, rel, 'index' + ext);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
      return undefined;
    },
  };
}

export default defineConfig(({ mode }) => {
  // .env.local を明示的に読み込む (prefix '' = 全変数対象)
  const env = loadEnv(mode ?? 'test', process.cwd(), '');
  return {
    plugins: [atAliasPlugin()],
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
