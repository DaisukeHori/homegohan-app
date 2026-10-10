/**
 * #1165 ログイン失敗のロックの記録 (supabase/migrations/20261010130000_auth_login_failures.sql) の結合テスト
 * (ローカルの Supabase の DB と Auth だけを使う。Next の開発サーバーは要らない)
 *
 * 確かめること:
 *   L-1: 権限。anon / authenticated はテーブルを読めず、6 つの関数をどれも呼べない (42501)。service_role は呼べる
 *   L-2: 回数の加算は、同時に呼んでも数え漏れない (INSERT ... ON CONFLICT の 1 文)。大文字・前後の空白は同じアドレス
 *   L-3: 期限は延ばすだけで縮めない (GREATEST)。記録を消すと 0 行
 *   L-4: メールアドレスそのものは残さない (email_hash は SHA-256 の 16 進 64 文字で、アドレスの文字列を含まない)
 *   L-5: auth_login_account_user_id は、登録済みのアドレスなら user_id、無ければ NULL
 *   L-6: 本物の Supabase Auth と組み合わせた流れ (src/lib/auth/guarded-login.ts):
 *        5 回のパスワード違いでロック → ロック中は正しいパスワードでも断る (Supabase を呼ばない) → 記録を消すと入れる
 *   L-7: パスワードの再設定のメールのリンク (token_hash を verifyOtp) で作ったセッションの JWT の amr は otp で、
 *        パスワードのログインは password だけ (POST /api/auth/login-lock/clear が、メールのリンクのセッションだけに
 *        ロックを外させる根拠。route の EMAIL_LINK_AMR_METHODS = recovery / otp / magiclink)
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
import { readLoginLockState, type LoginLockRpcClient } from '@/lib/auth/login-lock';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

// ユーザーを作り、ロックの記録を書き換えるテストなので、ローカルのスタックだけを対象にする
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
const lockStore: LoginLockRpcClient = { rpc: (fn, args) => srAdmin.rpc(fn, args) };

const RUN = `${Date.now()}-${randomBytes(4).toString('hex')}`;
const PASSWORD = `Lock-${randomBytes(9).toString('base64url')}1a`;
const WRONG_PASSWORD = `${PASSWORD}-wrong`;

const FUNCTIONS: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'auth_login_email_hash', args: { p_email: 'x@example.com' } },
  { name: 'auth_login_lock_status', args: { p_email: 'x@example.com' } },
  { name: 'auth_login_record_failure', args: { p_email: 'x@example.com' } },
  { name: 'auth_login_apply_lock', args: { p_email: 'x@example.com', p_locked_until: new Date().toISOString() } },
  { name: 'auth_login_clear_failures', args: { p_email: 'x@example.com' } },
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

  it('service_role は呼べる', async () => {
    const email = emailFor('sr');
    expect(await rpc('auth_login_lock_status', { p_email: email })).toEqual([]);
  });
});

describe('L-2〜L-4 記録の規則', () => {
  it('同時に 6 回呼んでも 6 回と数える。大文字・前後の空白は同じアドレス', async () => {
    const email = emailFor('parallel');
    const variants = [email, email.toUpperCase(), `  ${email}  `, email, email, email];
    await Promise.all(variants.map((v) => rpc('auth_login_record_failure', { p_email: v })));
    expect(await rpc('auth_login_lock_status', { p_email: email })).toEqual([{ failure_count: 6, locked_until: null }]);
  });

  it('期限は延ばすだけで縮めない。消すと 0 行', async () => {
    const email = emailFor('greatest');
    await rpc('auth_login_record_failure', { p_email: email });
    const later = new Date(Date.now() + 3_600_000);
    const sooner = new Date(Date.now() + 900_000);
    await rpc('auth_login_apply_lock', { p_email: email, p_locked_until: later.toISOString() });
    await rpc('auth_login_apply_lock', { p_email: email, p_locked_until: sooner.toISOString() });
    const [row] = (await rpc('auth_login_lock_status', { p_email: email })) as Array<{ locked_until: string }>;
    expect(new Date(row.locked_until).getTime()).toBe(later.getTime());

    await rpc('auth_login_clear_failures', { p_email: email });
    expect(await rpc('auth_login_lock_status', { p_email: email })).toEqual([]);
  });

  it('記録はハッシュだけで、メールアドレスの文字列を残さない', async () => {
    const email = emailFor('hash');
    await rpc('auth_login_record_failure', { p_email: email });
    const hash = (await rpc('auth_login_email_hash', { p_email: email })) as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const { data, error } = await srAdmin.from('auth_login_failures').select('*').eq('email_hash', hash);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain(email.split('@')[0]);
  });
});

describe('L-5 auth_login_account_user_id', () => {
  it('登録済みなら user_id (大文字でも)、無ければ NULL', async () => {
    const user = await createUser('lookup');
    expect(await rpc('auth_login_account_user_id', { p_email: user.email.toUpperCase() })).toBe(user.id);
    expect(await rpc('auth_login_account_user_id', { p_email: emailFor('nobody') })).toBeNull();
  });
});

describe('L-6 本物の Supabase Auth と組み合わせた流れ', () => {
  it('5 回のパスワード違いでロック → ロック中は正しいパスワードでも断る → 記録を消すと入れる', async () => {
    const user = await createUser('flow');
    const anon = client(anonKey);
    let signInCalls = 0;
    const deps: GuardedLoginDeps = {
      lockStore,
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
      notify: () => {},
      onClearFailed: (error) => {
        throw error;
      },
      now: () => new Date(),
    };

    for (let i = 1; i <= 4; i += 1) {
      const result = await performGuardedLogin({ email: user.email, password: WRONG_PASSWORD }, deps);
      expect(result).toEqual({ kind: 'invalid-credentials', captchaRequired: i >= 3 });
    }
    const fifth = await performGuardedLogin({ email: user.email, password: WRONG_PASSWORD }, deps);
    expect(fifth.kind).toBe('locked');

    const callsBefore = signInCalls;
    const whileLocked = await performGuardedLogin({ email: user.email, password: PASSWORD }, deps);
    expect(whileLocked.kind).toBe('locked');
    expect(signInCalls).toBe(callsBefore);
    expect((await readLoginLockState(lockStore, user.email, new Date())).failureCount).toBe(5);

    await rpc('auth_login_clear_failures', { p_email: user.email });
    expect(await performGuardedLogin({ email: user.email, password: PASSWORD }, deps)).toEqual({ kind: 'signed-in' });
  });
});

/** POST /api/auth/login-lock/clear (src/app/api/auth/login-lock/clear/route.ts) が、ロックを外してよいとみなす amr */
const EMAIL_LINK_AMR_METHODS = ['recovery', 'otp', 'magiclink'];

describe('L-7 再設定のセッションの amr', () => {
  function amrMethods(claims: Record<string, unknown> | undefined): string[] {
    const amr = claims?.amr;
    if (!Array.isArray(amr)) return [];
    return amr.map((entry: unknown) =>
      typeof entry === 'string' ? entry : String((entry as { method?: unknown }).method),
    );
  }

  it('再設定のメールのリンクで作ったセッションはメールのリンクの印 (otp) を持ち、パスワードのログインは持たない', async () => {
    const user = await createUser('recovery');

    const { data: link, error: linkError } = await srAdmin.auth.admin.generateLink({ type: 'recovery', email: user.email });
    if (linkError || !link.properties) throw new Error(`generateLink 失敗: ${linkError?.message}`);
    const recoveryClient = client(anonKey);
    const { data: verified, error: verifyError } = await recoveryClient.auth.verifyOtp({
      type: 'recovery',
      token_hash: link.properties.hashed_token,
    });
    if (verifyError || !verified.session) throw new Error(`verifyOtp 失敗: ${verifyError?.message}`);
    const recoveryClaims = await recoveryClient.auth.getClaims(verified.session.access_token);
    const recoveryMethods = amrMethods(recoveryClaims.data?.claims as Record<string, unknown> | undefined);
    // GoTrue は token_hash の verifyOtp で作ったセッションに otp を付ける (PKCE で受けたときは recovery)
    expect(recoveryMethods).toContain('otp');
    expect(recoveryMethods.some((m) => EMAIL_LINK_AMR_METHODS.includes(m))).toBe(true);

    const passwordClient = client(anonKey);
    const { data: signedIn, error: signInError } = await passwordClient.auth.signInWithPassword({
      email: user.email,
      password: PASSWORD,
    });
    if (signInError || !signedIn.session) throw new Error(`signInWithPassword 失敗: ${signInError?.message}`);
    const passwordClaims = await passwordClient.auth.getClaims(signedIn.session.access_token);
    const methods = amrMethods(passwordClaims.data?.claims as Record<string, unknown> | undefined);
    expect(methods).toContain('password');
    expect(methods.some((m) => EMAIL_LINK_AMR_METHODS.includes(m))).toBe(false);
  });
});
