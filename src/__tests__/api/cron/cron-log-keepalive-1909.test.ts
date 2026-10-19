// @vitest-environment node
/**
 * cron の 4 本の route で、1 秒の延命 (LOG_FLUSH_GRACE_MS) を外しても、ログの保存が待たれること (#1909 の後片付け)
 *
 * 以前は push-outbox・email-outbox・app-log-alerts・backup-freshness が、応答のあとに 1 秒だけ関数を延命していた
 * (`waitUntil(new Promise((r) => setTimeout(r, 1000)))`)。ログの保存が 1 秒を超えると、その行は失われうる回避策だった。
 * #1913 から createLogger (src/lib/db-logger.ts) が、1 行ごとに保存の Promise を waitUntil に渡すので、route の延命は外した。
 *
 * ここでは本物の createLogger を通して、各 route の「ログを 1 行書いて返す」経路を動かし、次を確かめる。
 *   - waitUntil に渡された Promise は、app_logs への insert が返るまで終わらない (時間がたっても終わらない = 時間の延命ではない)
 *   - waitUntil の呼び出しは、ログの保存 (insert) と同じ回数だけ (route が自分で時間の延命を足していない)
 *   - 保存が終わったあと、タイマーが残らない
 *   - 認証で断った要求は、ログも延命も無い
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  insert: vi.fn(),
  waitUntil: vi.fn(),
  cleanup: vi.fn(),
  isMaintenanceFlagOn: vi.fn(),
}));

// app_logs への保存の送り先 (本物の createLogger が使う)
vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: mocks.waitUntil,
}));

// ここで動かす経路は DB の本体に触れない。触れたら失敗させる
vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => {
    throw new Error('この経路では getSupabaseAdmin を呼ばない');
  },
}));

vi.mock('@/lib/maintenance-mode', () => ({
  isMaintenanceFlagOn: mocks.isMaintenanceFlagOn,
}));

vi.mock('@/lib/push/outbox-store', () => ({
  createOutboxStore: () => ({ cleanup: mocks.cleanup }),
}));

const SECRET = 'dummy-cron-secret-1909-followup-0123456789';
const TEST_SUPABASE_URL = 'http://127.0.0.1:54321';
const TEST_SERVICE_ROLE_KEY = 'service-role-key-for-test';
/** 以前の route の延命 (LOG_FLUSH_GRACE_MS) と同じ長さ。これだけ時間がたっても、保存が返るまでは延命が終わらないことを確かめる */
const FORMER_GRACE_MS = 1000;
/** マイクロタスクを流す回数 (認証のダイジェスト → 本体 → ログ → 保存 → race → finally の連鎖が流れきるのに足りる回数) */
const MICROTASK_DRAIN_ROUNDS = 50;

const ROUTE_FILES = [
  'src/app/api/cron/push-outbox/route.ts',
  'src/app/api/cron/email-outbox/route.ts',
  'src/app/api/cron/app-log-alerts/route.ts',
  'src/app/api/cron/backup-freshness/route.ts',
] as const;

type RouteCase = {
  name: string;
  load: () => Promise<{ GET: (req: Request) => Promise<Response> }>;
  /** その経路を通すための環境変数 (undefined は消す) */
  env: Record<string, string | undefined>;
  expectedBody: Record<string, unknown>;
};

const CASES: RouteCase[] = [
  {
    name: 'cron/push-outbox (EXPO_ACCESS_TOKEN が未設定 → 掃除だけして warn)',
    load: () => import('@/app/api/cron/push-outbox/route'),
    env: { EXPO_ACCESS_TOKEN: undefined },
    expectedBody: { status: 'not_configured', cleaned_expired: 0, cleaned_sent: 0, cleaned_dead: 0 },
  },
  {
    name: 'cron/email-outbox (RESEND_API_KEY が未設定 → warn)',
    load: () => import('@/app/api/cron/email-outbox/route'),
    env: { RESEND_API_KEY: undefined },
    expectedBody: { status: 'not_configured' },
  },
  {
    name: 'cron/app-log-alerts (OPS_ALERT_EMAIL が未設定 → info)',
    load: () => import('@/app/api/cron/app-log-alerts/route'),
    env: { OPS_ALERT_EMAIL: undefined },
    expectedBody: { status: 'disabled' },
  },
  {
    name: 'cron/backup-freshness (OPS_ALERT_EMAIL が未設定 → info)',
    load: () => import('@/app/api/cron/backup-freshness/route'),
    env: { OPS_ALERT_EMAIL: undefined },
    expectedBody: { status: 'disabled' },
  },
];

/** 外から resolve できる Promise (insert の応答を手で返す) */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Promise が終わったかどうかを、待たずに見られるようにする */
function track(promise: Promise<unknown>) {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < MICROTASK_DRAIN_ROUNDS; i += 1) {
    await Promise.resolve();
  }
}

function keptAlive(): Promise<unknown>[] {
  return mocks.waitUntil.mock.calls.map(([arg]: unknown[], index) => {
    if (!(arg instanceof Promise)) throw new Error(`waitUntil の ${index} 番目の引数が Promise ではない`);
    return arg;
  });
}

function authed(path: string): Request {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${SECRET}` } });
}

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('CRON_SECRET_PREVIOUS', undefined);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', TEST_SUPABASE_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', TEST_SERVICE_ROLE_KEY);
  mocks.createClient.mockReturnValue({ from: () => ({ insert: mocks.insert }) });
  mocks.cleanup.mockResolvedValue({ expired: 0, sent: 0, dead: 0 });
  mocks.isMaintenanceFlagOn.mockResolvedValue(false);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.createClient.mockReset();
  mocks.insert.mockReset();
  mocks.waitUntil.mockReset();
  mocks.cleanup.mockReset();
  mocks.isMaintenanceFlagOn.mockReset();
});

describe('cron の route: 1 秒の延命を外しても、ログの保存は終わるまで待たれる (#1909)', () => {
  it.each(CASES)('$name', async ({ load, env, expectedBody, name }) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const pendingInserts: Array<ReturnType<typeof deferred<{ error: null }>>> = [];
    mocks.insert.mockImplementation(() => {
      const d = deferred<{ error: null }>();
      pendingInserts.push(d);
      return d.promise;
    });
    const { GET } = await load();
    // 延命のタイマー (setTimeout) だけを偽にする (認証のダイジェストなどのマイクロタスクはそのまま流れる)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const res = await GET(authed(`/api/${name.split(' ')[0]}`));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(expectedBody);
    await drainMicrotasks();

    // ログを 1 行以上書き、その保存ごとに 1 回だけ waitUntil に渡す (route が時間の延命を足していない)
    expect(mocks.insert.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(mocks.insert.mock.calls.length);
    const states = keptAlive().map(track);

    // 以前の延命と同じ時間がたっても、保存が返っていなければ延命は終わらない
    await vi.advanceTimersByTimeAsync(FORMER_GRACE_MS);
    expect(states.every((s) => !s.settled)).toBe(true);

    // 保存が返ったら延命は終わり、タイマーも残らない
    for (const d of pendingInserts) d.resolve({ error: null });
    await drainMicrotasks();
    expect(states.every((s) => s.settled)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(CASES)('$name: 認証で断った要求は、ログも延命も無い', async ({ load, env, name }) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const { GET } = await load();

    const res = await GET(new Request(`http://localhost/api/${name.split(' ')[0]}`));
    expect(res.status).toBe(401);
    await drainMicrotasks();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it.each(ROUTE_FILES)('%s は自分で関数を延命しない (延命は createLogger だけが行う)', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source).not.toContain('LOG_FLUSH_GRACE_MS');
    expect(source).not.toContain('@vercel/functions');
    expect(source).not.toMatch(/\bwaitUntil\s*\(/);
    // ログは本物の保存を待つ createLogger を通す
    expect(source).toContain("from '@/lib/db-logger'");
  });
});
