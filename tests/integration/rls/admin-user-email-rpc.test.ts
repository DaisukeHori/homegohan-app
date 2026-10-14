/**
 * #1145 管理画面のユーザー一覧・詳細でメールアドレスを出すための RPC (auth.users の読み取り) の権限・挙動テスト
 *
 * 背景: GET /api/admin/users と /api/admin/users/[id] は email を常に null で返していた。
 * auth.users は PostgREST に公開されていないため、メールを引くには service_role 専用の関数が要る。
 *   - admin_user_emails(p_ids uuid[])                 : 渡した user_id のメールだけを返す (一覧の 1 ページ分 / 詳細 1 件)
 *   - admin_find_user_ids_by_email(p_q text, p_limit) : メールの部分一致 (大文字小文字を区別しない) で user_id を返す
 *
 * 期待する認可:
 *   - service_role: 呼べる (正当な経路。API ルートが requireRole を通したあとにだけ呼ぶ)
 *   - anon / authenticated: EXECUTE 不可 (permission denied, SQLSTATE 42501)。
 *     開いていると、ログインユーザーなら誰でも他人のメールアドレスを引ける
 *
 * 期待する挙動:
 *   - admin_user_emails は「渡した id」のメールだけを返す (渡していない id は返さない。存在しない id は黙って捨てる)
 *   - admin_find_user_ids_by_email は LIKE のワイルドカード (% _) を文字どおりに扱う。空の検索語では何も返さない (全件ダンプしない)
 *
 * PostgREST を supabase-js で直接叩いて検証する (アプリ層のガードを経由しない経路が攻撃面のため)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/admin-user-email-rpc.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

// ---------------------------------------------------------------
// 環境変数
// ---------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

// ---------------------------------------------------------------
// クライアントファクトリ (is-inactive-user-rpc.test.ts と同型)
// ---------------------------------------------------------------
function anonClient(): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

function serviceRoleClient(): SupabaseClient {
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

function authedClient(accessToken: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

const srAdmin = serviceRoleClient();

// ---------------------------------------------------------------
// テストユーザー
//   a / b : 通常のメール (検索語 "rls-1145-" を共有する)
//   under : メールに "_" を含む (LIKE のワイルドカードとして扱われないことの確認用)
//   attacker : 一般ユーザー (呼び出し元)
// ---------------------------------------------------------------
interface TestUser {
  userId: string;
  email: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = 'TestPass!2026-rls';
// 実在しない UUID (v4 形式。auth.users に無い)
const MISSING_USER_ID = '00000000-0000-4000-8000-000000001145';

let userA: TestUser;
let userB: TestUser;
let userUnder: TestUser;
let attacker: TestUser;

async function createTestUser(email: string): Promise<TestUser> {
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`Failed to create auth user ${email}: ${error?.message}`);
  const userId = data.user.id;

  const signIn = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in ${email}: ${signIn.error?.message}`);
  }
  return { userId, email, jwt: signIn.data.session.access_token };
}

beforeAll(async () => {
  userA = await createTestUser(`rls-1145-a-${TS}@homegohan.test`);
  userB = await createTestUser(`rls-1145-b-${TS}@homegohan.test`);
  userUnder = await createTestUser(`rls-1145_u-${TS}@homegohan.test`);
  attacker = await createTestUser(`rls-1145-attacker-${TS}@homegohan.test`);
}, 90_000);

afterAll(async () => {
  for (const u of [userA, userB, userUnder, attacker]) {
    if (u?.userId) await srAdmin.auth.admin.deleteUser(u.userId);
  }
}, 30_000);

interface EmailRow {
  user_id: string;
  email: string | null;
}

// ================================================================
// admin_user_emails: service_role
// ================================================================
describe('#1145 admin_user_emails: service_role は渡した id のメールだけを引ける', () => {
  it('E-1: 渡した 2 件のメールが user_id 付きで返る', async () => {
    const { data, error } = await srAdmin.rpc('admin_user_emails', { p_ids: [userA.userId, userB.userId] });
    expect(error).toBeNull();
    const rows = (data ?? []) as EmailRow[];
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.user_id, r.email]));
    expect(byId.get(userA.userId)).toBe(userA.email);
    expect(byId.get(userB.userId)).toBe(userB.email);
  });

  it('E-2: 渡していない id のメールは返さない (1 件だけ渡せば 1 件だけ)', async () => {
    const { data, error } = await srAdmin.rpc('admin_user_emails', { p_ids: [userA.userId] });
    expect(error).toBeNull();
    const rows = (data ?? []) as EmailRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(userA.userId);
    expect(rows[0].email).toBe(userA.email);
  });

  it('E-3: 存在しない id は黙って捨てる (エラーにならず、行も返らない)', async () => {
    const { data, error } = await srAdmin.rpc('admin_user_emails', { p_ids: [MISSING_USER_ID, userB.userId] });
    expect(error).toBeNull();
    const rows = (data ?? []) as EmailRow[];
    expect(rows.map((r) => r.user_id)).toEqual([userB.userId]);
  });

  it('E-4: 空配列は空の結果 (全ユーザーのメールを返さない)', async () => {
    const { data, error } = await srAdmin.rpc('admin_user_emails', { p_ids: [] });
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });

  it('E-5: 返す列は user_id と email だけ (auth.users のほかの列を漏らさない)', async () => {
    const { data, error } = await srAdmin.rpc('admin_user_emails', { p_ids: [userA.userId] });
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['email', 'user_id']);
  });
});

// ================================================================
// admin_user_emails: authenticated / anon
// ================================================================
describe('#1145 admin_user_emails: authenticated / anon は呼べない', () => {
  it('E-6: authenticated (一般ユーザー) は他人のメールを引けない (permission denied)', async () => {
    const { data, error } = await authedClient(attacker.jwt).rpc('admin_user_emails', {
      p_ids: [userA.userId],
    });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });

  it('E-7: authenticated は自分のメールでも引けない (正当な利用経路が無いため全員閉じる)', async () => {
    const { data, error } = await authedClient(attacker.jwt).rpc('admin_user_emails', {
      p_ids: [attacker.userId],
    });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });

  it('E-8: anon は permission denied', async () => {
    const { data, error } = await anonClient().rpc('admin_user_emails', { p_ids: [userA.userId] });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });
});

// ================================================================
// admin_find_user_ids_by_email: service_role
// ================================================================
describe('#1145 admin_find_user_ids_by_email: service_role はメールの部分一致で user_id を引ける', () => {
  it('F-1: 一意な部分文字列でその 1 件だけが見つかる', async () => {
    const { data, error } = await srAdmin.rpc('admin_find_user_ids_by_email', {
      p_q: `rls-1145-a-${TS}`,
      p_limit: 100,
    });
    expect(error).toBeNull();
    expect(data).toEqual([userA.userId]);
  });

  it('F-2: 大文字小文字を区別しない', async () => {
    const { data, error } = await srAdmin.rpc('admin_find_user_ids_by_email', {
      p_q: `RLS-1145-B-${TS}@HOMEGOHAN`,
      p_limit: 100,
    });
    expect(error).toBeNull();
    expect(data).toEqual([userB.userId]);
  });

  it('F-3: 前後の空白は無視する', async () => {
    const { data, error } = await srAdmin.rpc('admin_find_user_ids_by_email', {
      p_q: `  rls-1145-a-${TS}  `,
      p_limit: 100,
    });
    expect(error).toBeNull();
    expect(data).toEqual([userA.userId]);
  });

  it('F-4: 共通の部分文字列では複数件見つかる (a / b / attacker。新しい順)', async () => {
    const { data, error } = await srAdmin.rpc('admin_find_user_ids_by_email', {
      p_q: `-${TS}@homegohan.test`,
      p_limit: 100,
    });
    expect(error).toBeNull();
    const ids = (data ?? []) as string[];
    for (const u of [userA, userB, userUnder, attacker]) {
      expect(ids).toContain(u.userId);
    }
    // 新しく作ったユーザーほど前に来る (created_at DESC)
    expect(ids.indexOf(attacker.userId)).toBeLessThan(ids.indexOf(userA.userId));
  });

  it('F-5: p_limit で件数が絞られる (1 を渡せば 1 件。0 や負数でも最低 1 件)', async () => {
    for (const limit of [1, 0, -5]) {
      const { data, error } = await srAdmin.rpc('admin_find_user_ids_by_email', {
        p_q: `-${TS}@homegohan.test`,
        p_limit: limit,
      });
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    }
  });

  it('F-6: "_" は LIKE のワイルドカードではなく文字どおりに一致する', async () => {
    // "1145_u" はアンダースコア入りのユーザーだけ。ワイルドカード扱いなら "1145-a" "1145-b" にも一致してしまう
    const { data, error } = await srAdmin.rpc('admin_find_user_ids_by_email', {
      p_q: `1145_`,
      p_limit: 100,
    });
    expect(error).toBeNull();
    const ids = (data ?? []) as string[];
    expect(ids).toContain(userUnder.userId);
    expect(ids).not.toContain(userA.userId);
    expect(ids).not.toContain(userB.userId);
  });

  it('F-7: "%" は LIKE のワイルドカードではない (全件に一致しない)', async () => {
    const { data, error } = await srAdmin.rpc('admin_find_user_ids_by_email', { p_q: '%', p_limit: 100 });
    expect(error).toBeNull();
    const ids = (data ?? []) as string[];
    expect(ids).not.toContain(userA.userId);
    expect(ids).not.toContain(userB.userId);
  });

  it('F-8: 空・空白だけ・NULL の検索語では何も返さない (全ユーザーをダンプしない)', async () => {
    for (const q of ['', '   ', null]) {
      const { data, error } = await srAdmin.rpc('admin_find_user_ids_by_email', { p_q: q, p_limit: 100 });
      expect(error).toBeNull();
      expect(data ?? []).toEqual([]);
    }
  });

  it('F-9: 一致しない検索語は空の結果', async () => {
    const { data, error } = await srAdmin.rpc('admin_find_user_ids_by_email', {
      p_q: `no-such-address-${TS}`,
      p_limit: 100,
    });
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });
});

// ================================================================
// admin_find_user_ids_by_email: authenticated / anon
// ================================================================
describe('#1145 admin_find_user_ids_by_email: authenticated / anon は呼べない', () => {
  it('F-10: authenticated は permission denied (メールの部分一致でアカウントの実在を調べられない)', async () => {
    const { data, error } = await authedClient(attacker.jwt).rpc('admin_find_user_ids_by_email', {
      p_q: userA.email,
      p_limit: 100,
    });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });

  it('F-11: anon は permission denied', async () => {
    const { data, error } = await anonClient().rpc('admin_find_user_ids_by_email', {
      p_q: userA.email,
      p_limit: 100,
    });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });
});
