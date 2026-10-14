/**
 * smoke test の本体 (#1181)。CLI の入口は scripts/smoke.mjs。
 *
 * 単体テスト (tests/smoke-script.test.ts) から fetch を差し替えて検証できるよう、
 * ネットワークと終了コードに触れる処理は runSmoke() / main() に閉じ込めてある。
 *
 * 守っていること:
 *   - データを書き換えるリクエストは送らない (GET と、--with-auth 時のログインだけ)
 *   - パスワード・トークン・API キーは出力に含めない (ステータスコードと成否だけ出す)
 *   - .env.local は読まない (確認したい環境と別の環境の値が混ざるのを避けるため)
 */

export const DEFAULT_BASE_URL = 'http://localhost:3000';
export const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 600_000;

/** --with-auth のときだけ必要な環境変数 (値は出力しない。足りないものの名前だけ出す) */
export const AUTH_ENV_NAMES = [
  'E2E_USER_EMAIL',
  'E2E_USER_PASSWORD',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
];

export const USAGE = `デプロイ後 / DR 復元後の smoke test (#1181)

使い方:
  npm run test:smoke -- --base-url=https://staging.homegohan.app
  PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:smoke
  npm run test:smoke        (既定: ${DEFAULT_BASE_URL}。ローカルの dev サーバ)

確認する項目 (未ログインで叩ける範囲。データは書き換えない):
  1. GET /api/health?deep=1       200 かつ status=ok / database=ok (アプリ + DB 疎通)
  2. GET /login                   200 (認証前のページが表示できる)
  3. GET /faq                     200 (公開ページが表示できる)
  4. GET /api/profile (未認証)    401 (500 ではなく認証エラーで弾く = API と認証の入口が生きている)

オプション:
  --base-url=<URL>   確認先。省略時は環境変数 PLAYWRIGHT_BASE_URL、それも無ければ ${DEFAULT_BASE_URL}
  --with-auth        テストユーザーでログインし、GET /api/profile が 200 になることも確認する。
                     次の環境変数を、確認したい環境の値で渡す (.env.local は読まない):
                     ${AUTH_ENV_NAMES.join(' / ')}
  --timeout-ms=<ms>  1 リクエストの待ち時間 (既定 ${DEFAULT_TIMEOUT_MS}。コールドスタートが遅いときに延ばす)
  -h, --help         この説明を表示する

終了コード: 0 = 全項目 OK / 1 = 失敗あり / 2 = 引数・設定の誤り
`;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** 確認先 URL を origin に正規化する。http(s) 以外・認証情報つき URL は拒否する */
export function normalizeBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`確認先 URL として読めません: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`確認先 URL は http:// か https:// で始めてください: ${url.protocol}`);
  }
  if (url.username || url.password) {
    // 出力にそのまま出るため、URL にパスワードを埋め込ませない
    throw new UsageError('確認先 URL に認証情報 (user:pass@) を含めないでください');
  }
  return url.origin;
}

function parseTimeoutMs(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new UsageError(`--timeout-ms は 1 〜 ${MAX_TIMEOUT_MS} の整数で指定してください: ${JSON.stringify(raw)}`);
  }
  return value;
}

export function parseArgs(argv, env = process.env) {
  let baseUrlRaw = null;
  let withAuth = false;
  let help = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--with-auth') {
      withAuth = true;
    } else if (arg === '--base-url') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new UsageError('--base-url には URL を指定してください (例: --base-url=https://staging.homegohan.app)');
      }
      baseUrlRaw = next;
      i++;
    } else if (arg.startsWith('--base-url=')) {
      baseUrlRaw = arg.slice('--base-url='.length);
    } else if (arg.startsWith('--timeout-ms=')) {
      timeoutMs = parseTimeoutMs(arg.slice('--timeout-ms='.length));
    } else {
      throw new UsageError(`不明な引数です: ${arg}`);
    }
  }

  const raw = baseUrlRaw ?? (env.PLAYWRIGHT_BASE_URL || DEFAULT_BASE_URL);
  return { baseUrl: normalizeBaseUrl(raw), withAuth, help, timeoutMs };
}

/** --with-auth に必要で、まだ設定されていない環境変数の名前 */
function missingAuthEnv(env) {
  return AUTH_ENV_NAMES.filter((name) => !env[name]);
}

const pass = (detail) => ({ ok: true, detail });
const fail = (detail) => ({ ok: false, detail });

/** 本文は使わないが、読み捨てて接続を解放する (未読のままだとプロセスの終了が遅れることがある) */
async function drain(res) {
  try {
    await res.arrayBuffer();
  } catch {
    // 判定には影響しない
  }
}

function describeError(error, timeoutMs) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return `${timeoutMs}ms 以内に応答がありませんでした`;
  }
  // fetch の失敗は message が "fetch failed" だけで、原因 (ECONNREFUSED / ENOTFOUND など) は cause にある
  const cause = error?.cause;
  const reason = cause?.code ?? cause?.errors?.[0]?.code ?? cause?.message;
  return `${error?.message ?? String(error)}${reason ? ` (${reason})` : ''}`;
}

/** 応答のバージョン表記を出力に出してよい形か (端末へ制御文字を流さないため、英数字と . - _ + だけ許す) */
function safeVersion(value) {
  return typeof value === 'string' && /^[\w.+-]{1,40}$/.test(value) ? value : null;
}

function buildChecks({ baseUrl, fetchImpl, timeoutMs, env, withAuth }) {
  // リダイレクトは追わない。エイリアス URL へ飛ばされているときに、気づかず別の場所を確認するのを避ける
  const send = (url, init = {}) =>
    fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), ...init });

  /** 指定パスへの未ログインの GET が、期待するステータスで返ること */
  const expectStatus = ({ name, path, expected, hint = '' }) => ({
    name,
    run: async () => {
      const res = await send(`${baseUrl}${path}`);
      await drain(res);
      return res.status === expected
        ? pass(`HTTP ${res.status}`)
        : fail(`HTTP ${res.status} (期待: ${expected}${hint})`);
    },
  });

  const healthCheck = {
    name: 'GET /api/health?deep=1',
    run: async () => {
      const res = await send(`${baseUrl}/api/health?deep=1`);
      if (res.status !== 200) {
        await drain(res);
        const hint =
          res.status === 503
            ? '。DB に届いていない可能性があります'
            : res.status === 404
              ? '。このデプロイにはヘルスチェックがありません'
              : '';
        return fail(`HTTP ${res.status} (期待: 200${hint})`);
      }
      let body = null;
      try {
        body = await res.json();
      } catch {
        return fail('HTTP 200 だが JSON として読めません');
      }
      if (body?.status !== 'ok') return fail('HTTP 200 だが status が ok ではありません');
      if (body?.checks?.database !== 'ok') {
        return fail('HTTP 200 だが DB 疎通 (checks.database) が ok ではありません');
      }
      const version = safeVersion(body.version);
      return pass(`HTTP 200 status=ok database=ok${version ? ` version=${version}` : ''}`);
    },
  };

  const authCheck = {
    name: 'ログイン → GET /api/profile (--with-auth)',
    run: async () => {
      const missing = missingAuthEnv(env);
      if (missing.length > 0) return fail(`環境変数が足りません: ${missing.join(', ')}`);

      const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, '');
      // どの環境にログインしたか分かるよう、ホスト名だけ出す (鍵は出さない)
      let host = 'Supabase';
      try {
        host = new URL(supabaseUrl).host;
      } catch {
        // URL として読めなければ、そのままリクエストが失敗して報告される
      }

      const loginRes = await send(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: env.E2E_USER_EMAIL, password: env.E2E_USER_PASSWORD }),
      });
      if (loginRes.status !== 200) {
        await drain(loginRes);
        return fail(`ログインに失敗しました (${host}): HTTP ${loginRes.status}`);
      }
      let session = null;
      try {
        session = await loginRes.json();
      } catch {
        // 下で access_token が無いものとして扱う
      }
      const accessToken = session?.access_token;
      if (typeof accessToken !== 'string' || !accessToken) {
        return fail(`ログイン応答に access_token がありません (${host})`);
      }

      const res = await send(`${baseUrl}/api/profile`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      await drain(res);
      return res.status === 200
        ? pass(`ログイン OK (${host}) → HTTP 200`)
        : fail(`ログイン OK (${host}) だが GET /api/profile は HTTP ${res.status} (期待: 200)`);
    },
  };

  return [
    healthCheck,
    expectStatus({ name: 'GET /login', path: '/login', expected: 200 }),
    expectStatus({ name: 'GET /faq', path: '/faq', expected: 200 }),
    expectStatus({
      name: 'GET /api/profile (未認証)',
      path: '/api/profile',
      expected: 401,
      hint: '。500 なら API か認証基盤が壊れています',
    }),
    ...(withAuth ? [authCheck] : []),
  ];
}

/** 全項目を順に実行し、結果の配列 [{ name, ok, detail, ms }] を返す。例外は投げない */
export async function runSmoke({
  baseUrl,
  withAuth = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const results = [];
  for (const check of buildChecks({ baseUrl, fetchImpl, timeoutMs, env, withAuth })) {
    const startedAt = Date.now();
    let outcome;
    try {
      outcome = await check.run();
    } catch (error) {
      outcome = fail(`リクエストに失敗しました: ${describeError(error, timeoutMs)}`);
    }
    results.push({ name: check.name, ...outcome, ms: Date.now() - startedAt });
  }
  return results;
}

/** CLI の本体。終了コードを返す (process.exit はここでは呼ばない) */
export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  { log = console.log, errorLog = console.error, fetchImpl } = {},
) {
  let args;
  try {
    args = parseArgs(argv, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    errorLog(`smoke: ${error.message}`);
    errorLog('smoke: 使い方は --help を参照してください');
    return 2;
  }

  if (args.help) {
    log(USAGE);
    return 0;
  }

  if (args.withAuth) {
    const missing = missingAuthEnv(env);
    if (missing.length > 0) {
      errorLog(`smoke: --with-auth には次の環境変数が必要です: ${missing.join(', ')}`);
      return 2;
    }
  }

  log(`smoke test: ${args.baseUrl}`);
  const results = await runSmoke({
    baseUrl: args.baseUrl,
    withAuth: args.withAuth,
    env,
    timeoutMs: args.timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  for (const result of results) {
    log(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.name} - ${result.detail} (${result.ms}ms)`);
  }

  const failed = results.filter((result) => !result.ok).length;
  if (failed === 0) {
    log(`smoke test OK (${results.length}/${results.length})`);
    return 0;
  }
  log(`smoke test FAILED (${failed}/${results.length} 件が失敗)`);
  return 1;
}
