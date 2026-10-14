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

// 1 件のテスト (it) とフック (beforeAll など) の時間切れの既定 (ミリ秒)。個別に時間切れを書いたテスト・フックはそちらが優先する。
// 結合テストは next dev (API ルートを最初のリクエストでコンパイルする) とローカル Supabase を叩くので、機械の負荷で所要が大きく揺れる。
// 2026-10-10〜11 に M2 で負荷が高いとき (load average 30〜80) に scripts/local-ci.sh を回すと、単独で回せば緑のテストが毎回違うところで
// 以前の既定の 30 秒を超えて落ちた (実行 9 回の赤のログで時間切れ 24 件。うち 21 件が既定の時間切れのテスト。
// 緑だった実行でも既定の時間切れのテストの所要は最大 20 秒台まで伸びていた)。その最大の 4 倍ほどの余裕を取る。
// 時間切れが効くのは遅いときだけで、速く終わるテストの所要は変わらない (止まったテストを見切るまでが長くなるだけ)。
// 機械に合わせて変えるときは環境変数 (INTEGRATION_TEST_TIMEOUT_MS / INTEGRATION_HOOK_TIMEOUT_MS) で上書きする
const DEFAULT_INTEGRATION_TEST_TIMEOUT_MS = 120_000;
const DEFAULT_INTEGRATION_HOOK_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_ENV = 'INTEGRATION_TEST_TIMEOUT_MS';
const HOOK_TIMEOUT_ENV = 'INTEGRATION_HOOK_TIMEOUT_MS';

/** 環境変数の時間切れ (正の整数のミリ秒)。無い・空なら既定。整数でなければ設定の誤りとして止める (黙って既定に戻さない) */
export function timeoutFromEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} は正の整数 (ミリ秒) にしてください: ${raw}`);
  }
  return value;
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
      // ローカル Supabase と next dev を叩くので長めに取る (上の DEFAULT_INTEGRATION_*_TIMEOUT_MS)。
      // 環境変数はシェルのもの (process.env) を .env.local より優先する
      testTimeout: timeoutFromEnv({ ...env, ...process.env }, TEST_TIMEOUT_ENV, DEFAULT_INTEGRATION_TEST_TIMEOUT_MS),
      hookTimeout: timeoutFromEnv({ ...env, ...process.env }, HOOK_TIMEOUT_ENV, DEFAULT_INTEGRATION_HOOK_TIMEOUT_MS),
      // 並列数は 1 (ファイルもテストも 1 本ずつ)。認証のレート制限と DB の取り合いを避けるため。
      // 負荷の下で落ちるのは並列のせいではない (すでに 1 本ずつ) ので、ここは変えない
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
