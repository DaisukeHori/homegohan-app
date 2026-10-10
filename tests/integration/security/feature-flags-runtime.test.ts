/**
 * #1148 機能フラグの実サーバーでの確認 (Next dev サーバ + ローカル Supabase)
 *
 * feature_flags の 2 つのフラグを DB で切り替えて、実際のミドルウェア (Edge) と API route (Node) がそれに従うことを確かめる。
 *   - maintenance_mode = ON:
 *       一般ユーザー・未ログインの API は 503 MAINTENANCE_MODE (Retry-After 付き)、ページは 503 の HTML。
 *       運営 (admin) は通る。死活監視 (/api/health)・フラグの取得 (/api/feature-flags)・/login・/terms は止まらない。
 *   - ai_chat_enabled = OFF:
 *       AI 相談の「新しい相談の開始」(POST /api/ai/consultation/sessions) は 503 AI_CHAT_DISABLED とやさしい文面。
 *       過去の相談の閲覧 (GET) は止まらない。
 *   - GET /api/feature-flags: 未ログインでも、ログイン済みでも答える。運営には maintenance_mode = false
 *   - GET /api/super-admin/flags の active_user_count: 以前は常に 0。実際の判定で数えた人数
 *
 * フラグの値は、ミドルウェアも API route もメモリに最大 30 秒覚える。そのため、切り替えたあとは、
 * 反映されるまで (最大 30 秒強) 繰り返し確かめる。テストの終わりに必ずフラグを元に戻し、反映されるまで待つ
 * (戻ったことを確かめずに終わると、あとのテストが 503 を受け取る)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/feature-flags-runtime.test.ts
 *   (dev サーバが 3000 以外のとき: INTEGRATION_BASE_URL=http://localhost:3414 を付ける)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth, type ApiResponse } from '../helpers/api';
import { createTestUserWithRoles, cleanupTestUser, cleanupAuditLogs, testEmail, type TestUser } from '../helpers/users';

const BASE_URL = process.env.INTEGRATION_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const TS = Date.now();

/** フラグのメモリのキャッシュは 30 秒。切り替えの反映を待つ上限 */
const PROPAGATION_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_500;

const KEYS = ['ai_chat_enabled', 'maintenance_mode'] as const;
type Key = (typeof KEYS)[number];

let normalUser: TestUser;
let adminUser: TestUser;
let superAdminUser: TestUser;
let originalEnabled: Record<Key, boolean> | null = null;
const tempFlagKey = `integration_test_flag_${TS}`;

interface FlagsBody {
  data: { flags: Record<string, boolean> };
}
interface ErrorBody {
  error?: { code?: string; message?: string } | string;
  code?: string;
  retryAfter?: number;
}

async function setFlag(key: Key, enabled: boolean): Promise<void> {
  const { error } = await supabaseAdmin.from('feature_flags').update({ enabled }).eq('key', key);
  expect(error, `${key} の更新`).toBeNull();
}

async function readFlags(): Promise<Record<Key, boolean>> {
  const { data, error } = await supabaseAdmin.from('feature_flags').select('key, enabled').in('key', [...KEYS]);
  expect(error, 'feature_flags の SELECT').toBeNull();
  const map = new Map((data ?? []).map((row) => [row.key as string, row.enabled as boolean]));
  for (const key of KEYS) expect(map.has(key), `feature_flags に ${key} の行が無い (migration 20261010120000)`).toBe(true);
  return { ai_chat_enabled: map.get('ai_chat_enabled')!, maintenance_mode: map.get('maintenance_mode')! };
}

async function waitFor<T>(label: string, fetchValue: () => Promise<T>, isDone: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + PROPAGATION_TIMEOUT_MS;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fetchValue();
    if (isDone(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`${label}: ${PROPAGATION_TIMEOUT_MS / 1000} 秒待っても反映されなかった。最後の値: ${JSON.stringify(last)}`);
}

function codeOf(body: unknown): string | undefined {
  const b = body as ErrorBody;
  if (b && typeof b === 'object') {
    if (b.error && typeof b.error === 'object') return b.error.code;
    return b.code;
  }
  return undefined;
}

/** ページ (HTML) を、リダイレクトを追わずに取る */
async function getPage(pathname: string, jwt?: string): Promise<{ status: number; contentType: string; retryAfter: string | null; text: string }> {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    redirect: 'manual',
    headers: jwt ? { Authorization: `Bearer ${jwt}`, Cookie: `sb-access-token=${jwt}` } : undefined,
  });
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    retryAfter: res.headers.get('retry-after'),
    text: await res.text(),
  };
}

const createSession = (jwt: string) => apiCall<ErrorBody & { session?: { id: string } }>('POST', '/api/ai/consultation/sessions', jwt, { title: 'AI相談' });

/**
 * next dev は、ルートを最初に呼ばれたときにコンパイルする。CI の初回は 1 本あたり数十秒かかることがあり、
 * 最初のいくつかのテストの既定のタイムアウト (30 秒) に収まらないことがある。
 * そのため、テストの前に、認証なしで 1 回ずつ呼んで先にコンパイルさせておく
 * (認証で 401 になるだけで、副作用は無い。結果は見ない。AI は呼ばれない)。
 */
const WARM_UP_ROUTES = [
  ['GET', '/api/feature-flags'],
  ['GET', '/api/super-admin/flags'],
  ['GET', '/api/pantry'],
  ['POST', '/api/ai/consultation/sessions'],
] as const;

beforeAll(async () => {
  for (const [method, path] of WARM_UP_ROUTES) {
    try {
      await apiCallNoAuth(method, path);
    } catch {
      // 温めるだけ。dev サーバーに届かないときは、あとのテストが失敗して知らせる
    }
  }
}, 240_000);

beforeAll(async () => {
  originalEnabled = await readFlags();
  [normalUser, adminUser, superAdminUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('flagrt-user', TS), roles: [] }),
    createTestUserWithRoles({ email: testEmail('flagrt-admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('flagrt-sa', TS), roles: ['super_admin'] }),
  ]);
}, 60_000);

afterAll(async () => {
  // どこで失敗しても、フラグを元に戻し、反映されるまで待つ (戻ったことを確かめずに終わると、あとのテストが 503 になる)
  if (originalEnabled) {
    try {
      await setFlag('maintenance_mode', originalEnabled.maintenance_mode);
      await setFlag('ai_chat_enabled', originalEnabled.ai_chat_enabled);
      if (!originalEnabled.maintenance_mode) {
        await waitFor(
          '未ログインの API がメンテナンス中でなくなる',
          () => apiCallNoAuth('GET', '/api/pantry'),
          (res) => res.status !== 503,
        );
      }
    } catch (error) {
      console.error('フラグを元に戻したあとの反映待ちに失敗しました:', error);
    }
  }
  await supabaseAdmin.from('feature_flags').delete().eq('key', tempFlagKey);
  for (const user of [normalUser, adminUser, superAdminUser]) {
    if (!user) continue;
    await supabaseAdmin.from('ai_consultation_sessions').delete().eq('user_id', user.userId);
    await cleanupAuditLogs(user.userId);
    await cleanupTestUser(user.userId);
  }
}, 120_000);

describe('GET /api/feature-flags', () => {
  it('未ログインでも 200。許可リストの 2 つの boolean だけを返し、キャッシュさせない', async () => {
    const res = await apiCallNoAuth<FlagsBody>('GET', '/api/feature-flags');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(Object.keys(res.body.data.flags).sort()).toEqual(['ai_chat_enabled', 'maintenance_mode']);
    expect(typeof res.body.data.flags.ai_chat_enabled).toBe('boolean');
    expect(typeof res.body.data.flags.maintenance_mode).toBe('boolean');
  });

  it('通常の状態 (停止もメンテナンスもしていない) では ai_chat_enabled = true / maintenance_mode = false', async () => {
    // 開発者がローカルで切り替えたままのときは、この検査はスキップできないので失敗させて気づかせる
    expect(originalEnabled).toEqual({ ai_chat_enabled: true, maintenance_mode: false });
    const res = await apiCall<FlagsBody>('GET', '/api/feature-flags', normalUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body.data.flags).toEqual({ ai_chat_enabled: true, maintenance_mode: false });
  });
});

describe('GET /api/super-admin/flags — active_user_count', () => {
  it('以前の 0 固定ではなく、実際の判定で数えた人数を返す', async () => {
    const { count: totalUsers } = await supabaseAdmin.from('user_profiles').select('id', { count: 'exact', head: true });
    const { count: superAdmins } = await supabaseAdmin
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .contains('roles', ['super_admin']);
    expect(totalUsers).toBeGreaterThanOrEqual(3);
    expect(superAdmins).toBeGreaterThanOrEqual(1);

    const created = await supabaseAdmin.from('feature_flags').insert([
      { key: tempFlagKey, description: 'integration test', enabled: true, rollout_strategy: { type: 'role', roles: ['super_admin'] } },
    ]);
    expect(created.error).toBeNull();

    const res = await apiCall<{ data: Array<{ key: string; enabled: boolean; active_user_count: number | null }> }>(
      'GET',
      '/api/super-admin/flags',
      superAdminUser.jwt,
    );

    expect(res.status).toBe(200);
    const byKey = new Map(res.body.data.map((flag) => [flag.key, flag]));

    // 全員が対象で条件の無いフラグ (ON) は、ユーザー総数
    expect(byKey.get('ai_chat_enabled')?.active_user_count).toBe(totalUsers);
    expect(byKey.get('menu_generation_v5_wrapped')?.enabled).toBe(true);
    // OFF のフラグは 0
    expect(byKey.get('maintenance_mode')?.enabled).toBe(false);
    expect(byKey.get('maintenance_mode')?.active_user_count).toBe(0);
    // role の段階公開は、そのロールのユーザーの数
    expect(byKey.get(tempFlagKey)?.active_user_count).toBe(superAdmins);
  });
});

describe('メンテナンスモードと AI 相談の緊急停止 (実サーバー)', () => {
  it(
    'ON にすると、一般ユーザーと未ログインは 503、運営は通る。止めないものは止まらない。OFF に戻すと元に戻る',
    async () => {
      await setFlag('maintenance_mode', true);
      await setFlag('ai_chat_enabled', false);

      // ── 反映を待つ (ミドルウェアと API route は別々にメモリへ覚えている) ──
      const blocked = await waitFor(
        '一般ユーザーの API がメンテナンス中になる',
        () => apiCall<ErrorBody>('GET', '/api/pantry', normalUser.jwt),
        (res) => res.status === 503,
      );
      const stopped = await waitFor(
        '運営の AI 相談の開始が緊急停止になる',
        () => createSession(adminUser.jwt),
        (res) => res.status === 503,
      );

      // ── 一般ユーザー: メンテナンス中 (ミドルウェアが先に返す) ──
      expect(codeOf(blocked.body)).toBe('MAINTENANCE_MODE');
      expect(blocked.headers['retry-after']).toBe('300');
      expect(blocked.headers['cache-control']).toContain('no-store');
      const normalSession = await createSession(normalUser.jwt);
      expect(normalSession.status).toBe(503);
      expect(codeOf(normalSession.body)).toBe('MAINTENANCE_MODE');

      // ── 運営: メンテナンスを通り抜け、AI 相談の緊急停止には従う ──
      expect(stopped.status).toBe(503);
      expect(codeOf(stopped.body)).toBe('AI_CHAT_DISABLED');
      expect((stopped.body as ErrorBody).error).toBe('AI相談は現在、一時的にご利用いただけません。しばらくしてから、もう一度お試しください。');
      expect(stopped.headers['retry-after']).toBe('60');
      const adminPantry = await apiCall('GET', '/api/pantry', adminUser.jwt);
      expect(adminPantry.status).not.toBe(503);
      // 過去の相談の閲覧は、AI を呼ばないので止まらない
      const adminSessions = await apiCall('GET', '/api/ai/consultation/sessions?status=all', adminUser.jwt);
      expect(adminSessions.status).toBe(200);
      // 運営の API (super-admin) も、メンテナンス中に使える
      const flagsApi = await apiCall('GET', '/api/super-admin/flags', superAdminUser.jwt);
      expect(flagsApi.status).toBe(200);

      // ── 未ログイン ──
      const anonApi = await apiCallNoAuth<ErrorBody>('GET', '/api/pantry');
      expect(anonApi.status).toBe(503);
      expect(codeOf(anonApi.body)).toBe('MAINTENANCE_MODE');

      // ── 止めないもの ──
      const health = await apiCallNoAuth('GET', '/api/health');
      expect(health.status).toBe(200);

      const clientFlags = await apiCallNoAuth<FlagsBody>('GET', '/api/feature-flags');
      expect(clientFlags.status).toBe(200);
      expect(clientFlags.body.data.flags).toEqual({ ai_chat_enabled: false, maintenance_mode: true });
      const normalFlags = await apiCall<FlagsBody>('GET', '/api/feature-flags', normalUser.jwt);
      expect(normalFlags.body.data.flags).toEqual({ ai_chat_enabled: false, maintenance_mode: true });
      // 運営には maintenance_mode = false (クライアントがメンテナンス中の画面を出さない)
      const adminFlags = await apiCall<FlagsBody>('GET', '/api/feature-flags', adminUser.jwt);
      expect(adminFlags.body.data.flags).toEqual({ ai_chat_enabled: false, maintenance_mode: false });

      // ── ページ ──
      const home = await getPage('/');
      expect(home.status).toBe(503);
      expect(home.contentType).toContain('text/html');
      expect(home.retryAfter).toBe('300');
      expect(home.text).toContain('メンテナンス中');
      expect(home.text).not.toMatch(/https?:\/\//);
      const homeForUser = await getPage('/home', normalUser.jwt);
      expect(homeForUser.status).toBe(503);
      expect((await getPage('/login')).status).toBe(200);
      expect((await getPage('/terms')).status).toBe(200);
      expect((await getPage('/privacy')).status).toBe(200);
      expect((await getPage('/admin', adminUser.jwt)).status).not.toBe(503);

      // ── 元に戻す ──
      await setFlag('maintenance_mode', false);
      await setFlag('ai_chat_enabled', true);

      await waitFor(
        '一般ユーザーの API がメンテナンス中でなくなる',
        () => apiCall('GET', '/api/pantry', normalUser.jwt),
        (res: ApiResponse) => res.status !== 503,
      );
      const resumed = await waitFor(
        '運営の AI 相談の開始が再開する',
        () => createSession(adminUser.jwt),
        (res) => res.status !== 503,
      );
      expect(resumed.status).toBe(200);
      expect(resumed.body.session?.id).toBeTruthy();
      const homeAfter = await getPage('/');
      expect(homeAfter.status).toBe(200);
      const flagsAfter = await apiCallNoAuth<FlagsBody>('GET', '/api/feature-flags');
      expect(flagsAfter.body.data.flags).toEqual({ ai_chat_enabled: true, maintenance_mode: false });
    },
    240_000,
  );
});
