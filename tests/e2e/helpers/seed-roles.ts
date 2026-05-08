/**
 * tests/e2e/helpers/seed-roles.ts
 *
 * T14 E2E 用: admin / super-admin ユーザーのロール付与を SUPABASE_SERVICE_ROLE_KEY 経由で行うヘルパー。
 *
 * 使い方:
 *   - このファイルは E2E テスト内から import して使う (test.beforeAll 等)
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.local で設定済みであること
 *   - 付与したロールは afterAll でクリーンアップすることを推奨
 *
 * 対象テーブル:
 *   - user_profiles.roles: string[] カラムに RBAC ロール名を格納する設計
 */

export interface SeedRoleOptions {
  /** Supabase プロジェクト URL。省略時は NEXT_PUBLIC_SUPABASE_URL env から取得 */
  supabaseUrl?: string;
  /** Service Role Key。省略時は SUPABASE_SERVICE_ROLE_KEY env から取得 */
  serviceRoleKey?: string;
}

interface UserProfile {
  id: string;
  roles: string[];
}

/**
 * Supabase Management API (service_role) 経由で user_profiles.roles を更新する。
 *
 * @param userId - 対象ユーザーの UUID (auth.users.id)
 * @param roles  - 付与するロール名の配列 (例: ['admin'])
 * @param opts   - Supabase 接続情報 (省略時は env から取得)
 */
export async function grantRoles(
  userId: string,
  roles: string[],
  opts: SeedRoleOptions = {},
): Promise<void> {
  const url = opts.supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = opts.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      '[seed-roles] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。' +
      '.env.local に追加してください。',
    );
  }

  const resp = await fetch(`${url}/rest/v1/user_profiles?id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ roles }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`[seed-roles] grantRoles 失敗 (${resp.status}): ${body}`);
  }
}

/**
 * Supabase Auth API (service_role) 経由でユーザーを作成する。
 * 既にメールアドレスが存在する場合はそのユーザーを返す。
 *
 * @param email    - メールアドレス
 * @param password - パスワード
 * @param roles    - 付与するロール名の配列
 * @param opts     - Supabase 接続情報
 * @returns 作成 or 取得した user_id
 */
export async function createUserWithRoles(
  email: string,
  password: string,
  roles: string[],
  opts: SeedRoleOptions = {},
): Promise<string> {
  const url = opts.supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = opts.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      '[seed-roles] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
    );
  }

  // 1. Auth Admin API でユーザー作成 (重複時は 422 でエラー)
  const createResp = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
    }),
  });

  let userId: string;

  if (createResp.ok) {
    const created = await createResp.json() as { id: string };
    userId = created.id;
  } else if (createResp.status === 422) {
    // 既存ユーザーを検索
    const listResp = await fetch(
      `${url}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      },
    );
    if (!listResp.ok) {
      const body = await listResp.text();
      throw new Error(`[seed-roles] 既存ユーザー検索失敗 (${listResp.status}): ${body}`);
    }
    const list = await listResp.json() as { users: Array<{ id: string; email: string }> };
    const existing = list.users?.find((u) => u.email === email);
    if (!existing) {
      throw new Error(`[seed-roles] ユーザーが見つかりません: ${email}`);
    }
    userId = existing.id;
  } else {
    const body = await createResp.text();
    throw new Error(`[seed-roles] ユーザー作成失敗 (${createResp.status}): ${body}`);
  }

  // 2. user_profiles にロールを付与
  await grantRoles(userId, roles, opts);

  return userId;
}

/**
 * Supabase Auth API 経由でユーザーを削除する。
 * テスト後のクリーンアップ用。
 *
 * @param userId - 削除する user_id
 * @param opts   - Supabase 接続情報
 */
export async function deleteUser(
  userId: string,
  opts: SeedRoleOptions = {},
): Promise<void> {
  const url = opts.supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = opts.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('[seed-roles] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
  }

  const resp = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });

  if (!resp.ok && resp.status !== 404) {
    const body = await resp.text();
    throw new Error(`[seed-roles] ユーザー削除失敗 (${resp.status}): ${body}`);
  }
}

/**
 * Supabase Auth API 経由で特定ユーザーのセッショントークンを取得する。
 * E2E テスト内でそのユーザーとして API を叩く場合に使う。
 *
 * @param email    - メールアドレス
 * @param password - パスワード
 * @param opts     - Supabase 接続情報
 * @returns アクセストークン
 */
export async function getSessionToken(
  email: string,
  password: string,
  opts: SeedRoleOptions = {},
): Promise<string> {
  const url = opts.supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey =
    opts.serviceRoleKey ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('[seed-roles] Supabase 接続情報が未設定です。');
  }

  const resp = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
    },
    body: JSON.stringify({ email, password }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`[seed-roles] ログイン失敗 (${resp.status}): ${body}`);
  }

  const data = await resp.json() as { access_token: string };
  if (!data.access_token) {
    throw new Error('[seed-roles] access_token が取得できませんでした');
  }

  return data.access_token;
}
