/**
 * #1165 ログインの連続失敗の記録の結合テスト (ローカルの Supabase の DB と Auth だけを使う。Next の開発サーバーは要らない)
 *   - supabase/migrations/20261010130000_auth_login_failures.sql (テーブル・ハッシュ・記録の消去)
 *   - supabase/migrations/20261010160000_auth_login_failure_window.sql (時間で戻る数え方)
 *
 * ログインに続けて失敗しても、アカウントはロックしない (docs/operations/auth-protection.md §1)。
 * 回数は、ボットの確認を求めるかどうかにだけ使う。
 * (ファイル名は、20261010130000 の migration のコメントが指しているため、ロックがあったころのまま)
 *
 * 確かめること:
 *   L-1: 権限。anon / authenticated はテーブルを読めず、関数をどれも呼べない (42501)。service_role は呼べる
 *        (使わなくなったロックの関数も残っているので、権限が開いていないことを確かめ続ける)
 *   L-2: 回数の加算は、同時に呼んでも数え漏れない (INSERT ... ON CONFLICT の 1 文)。大文字・前後の空白は同じアドレス
 *   L-3: 時間で戻る。最後の失敗から指定の分数が経っていれば、回数は 0・次の失敗は 1 から。経っていなければ数え続ける。
 *        分数が 1 未満・NULL なら 22023
 *   L-4: メールアドレスそのものは残さない (email_hash は SHA-256 の 16 進 64 文字で、アドレスの文字列を含まない)。記録を消すと 0
 *   L-6: 本物の Supabase Auth と組み合わせた流れ (src/lib/auth/guarded-login.ts):
 *        25 回のパスワード違いでもロックしない (毎回パスワードを確かめる) → 正しいパスワードで入れる → 回数は 0
 *
 * 実行:
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/auth-login-lock.test.ts
 */
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';

import { performGuardedLogin, type GuardedLoginDeps } from '@/lib/auth/guarded-login';
import { readLoginFailureState, type LoginFailureRpcClient } from '@/lib/auth/login-failures';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

// ユーザーを作り、失敗の記録を書き換えるテストなので、ローカルのスタックだけを対象にする
const supabaseHost = new URL(url).hostname;
if (supabaseHost !== 'localhost' && supabaseHost !== '127.0.0.1') {
  throw new Error(`NEXT_PUBLIC_SUPABASE_URL はローカルの Supabase を指してください (現在のホスト: ${supabaseHost})`);
}

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);
const failureStore: LoginFailureRpcClient = { rpc: (fn, args) => srAdmin.rpc(fn, args) };

const RUN = `${Date.now()}-${randomBytes(4).toString('hex')}`;
const PASSWORD = `Lock-${randomBytes(9).toString('base64url')}1a`;
const WRONG_PASSWORD = `${PASSWORD}-wrong`;

/** テストで使う「回数を 0 に戻すまでの時間」(分) */
const RESET_MINUTES = 60;
const MS_PER_MINUTE = 60_000;
/** ロックがあったころの最後の段 (20 回) を超える回数 */
const MANY_FAILURES = 25;

const FUNCTIONS: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'auth_login_email_hash', args: { p_email: 'x@example.com' } },
  { name: 'auth_login_failure_count', args: { p_email: 'x@example.com', p_reset_after_minutes: RESET_MINUTES } },
  { name: 'auth_login_count_failure', args: { p_email: 'x@example.com', p_reset_after_minutes: RESET_MINUTES } },
  { name: 'auth_login_clear_failures', args: { p_email: 'x@example.com' } },
  // 使わなくなったロックの関数 (DB には残っている)
  { name: 'auth_login_lock_status', args: { p_email: 'x@example.com' } },
  { name: 'auth_login_record_failure', args: { p_email: 'x@example.com' } },
  { name: 'auth_login_apply_lock', args: { p_email: 'x@example.com', p_locked_until: new Date().toISOString() } },
  { name: 'auth_login_account_user_id', args: { p_email: 'x@example.com' } },
];

const createdUserIds: string[] = [];
const usedEmails: string[] = [];

function emailFor(label: string): string {
  const email = `login-lock-${label}-${RUN}@example.test`;
  usedEmails.push(email);
  return email;
}

async function createUser(label: string): Promise<{ id: string; email: string }> {
  const email = emailFor(label);
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser 失敗: ${error?.message}`);
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email };
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const { data, error } = await srAdmin.rpc(fn, args);
  if (error) throw new Error(`${fn} 失敗: ${error.message}`);
  return data as unknown;
}

const count = (email: string) => rpc('auth_login_failure_count', { p_email: email, p_reset_after_minutes: RESET_MINUTES });
const countFailure = (email: string) =>
  rpc('auth_login_count_failure', { p_email: email, p_reset_after_minutes: RESET_MINUTES });

/** 最後の失敗の時刻を、いまから minutesAgo 分前に書き換える (時間で戻ることを確かめる用) */
async function setLastFailedMinutesAgo(email: string, minutesAgo: number): Promise<void> {
  const hash = (await rpc('auth_login_email_hash', { p_email: email })) as string;
  const { error } = await srAdmin
    .from('auth_login_failures')
    .update({ last_failed_at: new Date(Date.now() - minutesAgo * MS_PER_MINUTE).toISOString() })
    .eq('email_hash', hash);
  if (error) throw new Error(`last_failed_at の書き換えに失敗: ${error.message}`);
}

let authedToken = '';

beforeAll(async () => {
  const user = await createUser('authed');
  const { data, error } = await client(anonKey).auth.signInWithPassword({ email: user.email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signInWithPassword 失敗: ${error?.message}`);
  authedToken = data.session.access_token;
});

afterAll(async () => {
  for (const email of usedEmails) {
    await srAdmin.rpc('auth_login_clear_failures', { p_email: email });
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
});

describe('L-1 権限', () => {
  it.each(FUNCTIONS)('anon / authenticated は $name を呼べない (42501)', async ({ name, args }) => {
    for (const caller of [client(anonKey), client(anonKey, authedToken)]) {
      const { error } = await caller.rpc(name, args);
      expect(error, `${name} が呼べてしまった`).not.toBeNull();
      expect(error?.code).toBe('42501');
    }
  });

  it('anon / authenticated はテーブルを読めず、書けない', async () => {
    for (const caller of [client(anonKey), client(anonKey, authedToken)]) {
      const read = await caller.from('auth_login_failures').select('email_hash').limit(1);
      expect(read.error?.code).toBe('42501');
      const write = await caller
        .from('auth_login_failures')
        .insert({ email_hash: 'a'.repeat(64), failure_count: 0 });
      expect(write.error?.code).toBe('42501');
    }
  });

  it('service_role は呼べる (記録が無ければ 0 回)', async () => {
    expect(await count(emailFor('sr'))).toBe(0);
  });
});

describe('L-2 同時の加算', () => {
  it('同時に 6 回呼んでも 6 回と数える。大文字・前後の空白は同じアドレス', async () => {
    const email = emailFor('parallel');
    const variants = [email, email.toUpperCase(), `  ${email}  `, email, email, email];
    const results = (await Promise.all(variants.map((v) => countFailure(v)))) as number[];
    expect([...results].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await count(email)).toBe(6);
  });
});

describe('L-3 時間で戻る', () => {
  it('最後の失敗から指定の分数が経っていれば 0 回で、次の失敗は 1 から数え直す', async () => {
    const email = emailFor('expire');
    for (let i = 0; i < 5; i += 1) await countFailure(email);
    await setLastFailedMinutesAgo(email, RESET_MINUTES + 1);

    expect(await count(email)).toBe(0);
    expect(await countFailure(email)).toBe(1);
    expect(await count(email)).toBe(1);
  });

  it('指定の分数が経つ前なら、数え続ける', async () => {
    const email = emailFor('within');
    for (let i = 0; i < 5; i += 1) await countFailure(email);
    await setLastFailedMinutesAgo(email, RESET_MINUTES - 1);

    expect(await count(email)).toBe(5);
    expect(await countFailure(email)).toBe(6);
  });

  it.each([0, -1, null])('分数が %s なら 22023 で断る (どちらの関数も)', async (minutes) => {
    for (const name of ['auth_login_failure_count', 'auth_login_count_failure']) {
      const { error } = await srAdmin.rpc(name, { p_email: emailFor('invalid'), p_reset_after_minutes: minutes });
      expect(error?.code, name).toBe('22023');
    }
  });
});

describe('L-4 記録の規則', () => {
  it('記録はハッシュだけで、メールアドレスの文字列を残さない', async () => {
    const email = emailFor('hash');
    await countFailure(email);
    const hash = (await rpc('auth_login_email_hash', { p_email: email })) as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const { data, error } = await srAdmin.from('auth_login_failures').select('*').eq('email_hash', hash);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain(email.split('@')[0]);
  });

  it('記録を消すと 0 回', async () => {
    const email = emailFor('clear');
    await countFailure(email);
    await rpc('auth_login_clear_failures', { p_email: email });
    expect(await count(email)).toBe(0);
  });
});

describe('L-6 本物の Supabase Auth と組み合わせた流れ (ロックしない)', () => {
  it(`${MANY_FAILURES} 回のパスワード違いでもロックせず毎回パスワードを確かめ、正しいパスワードで入れる。回数は 0 に戻る`, async () => {
    const user = await createUser('flow');
    const anon = client(anonKey);
    let signInCalls = 0;
    const deps: GuardedLoginDeps = {
      failureStore,
      resetAfterMinutes: RESET_MINUTES,
      signIn: async ({ email, password, captchaToken }) => {
        signInCalls += 1;
        const { error } = await anon.auth.signInWithPassword({
          email,
          password,
          ...(captchaToken ? { options: { captchaToken } } : {}),
        });
        return { error: error ? { code: error.code, status: error.status, message: error.message } : null };
      },
      verifyCaptcha: async () => ({ status: 'disabled' }),
      onClearFailed: (error) => {
        throw error;
      },
    };

    for (let i = 1; i <= MANY_FAILURES; i += 1) {
      const result = await performGuardedLogin({ email: user.email, password: WRONG_PASSWORD }, deps);
      expect(result).toEqual({ kind: 'invalid-credentials', captchaRequired: i >= 3 });
    }
    expect(signInCalls).toBe(MANY_FAILURES);
    expect((await readLoginFailureState(failureStore, user.email, RESET_MINUTES)).failureCount).toBe(MANY_FAILURES);

    expect(await performGuardedLogin({ email: user.email, password: PASSWORD }, deps)).toEqual({ kind: 'signed-in' });
    expect(signInCalls).toBe(MANY_FAILURES + 1);
    expect(await readLoginFailureState(failureStore, user.email, RESET_MINUTES)).toEqual({
      failureCount: 0,
      captchaRequired: false,
    });
  });
});
