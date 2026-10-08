/**
 * #1188 パスワードを更新したとき、どのセッションが失効するか (結合テスト: ローカルの Supabase Auth だけを使う)
 *
 * 背景:
 *   Web の /auth/reset-password は updateUser({ password }) の後に signOut を呼ばず、3 秒後に /login へ
 *   push するだけだった。「パスワードを変えても他の端末のログインが残るのでは」という指摘 (#1188) に対し、
 *   Supabase Auth (GoTrue) 側の挙動はリポジトリのコードにも設定にもテストにも書かれておらず、確かめられていなかった。
 *   ここで挙動を固定する。ページの呼び出し順 (clear → signOut → 通知) は単体テスト
 *   tests/auth/reset-password-session-revoke.test.ts が見る。
 *
 * 確かめること (GoTrue v2.183.0 で確認。scripts/supabase-local.sh は本番に合わせた版でローカルを立てる):
 *   P-1: updateUser({ password }) をした端末以外のセッションは、GoTrue が自動で失効させる
 *        (アクセストークンは session_not_found、リフレッシュトークンは refresh_token_not_found)
 *   P-2: 更新をした端末自身のセッション (リセットメールのリンクで作られたもの) は残る。
 *        だから Web のページは、更新後に自分で signOut({ scope: 'global' }) を呼んで、この端末のセッションも消す
 *   P-3: ページと同じ流れ (updateUser → signOut global) の後は、どの端末のセッションも残らず、
 *        新しいパスワードでは入れて、古いパスワードでは入れない
 *   P-4: signOut({ scope: 'others' }) は今のセッションを残して、他のセッションだけを失効させる
 *        (ログイン中のパスワード変更 #1187 を作るときの前提。リセットでは今のセッションも消したいので使わない)
 *
 * 判定が通信エラーやレート制限などで偶然「失効」に見えないよう、失効は GoTrue が返す具体的なエラー
 * (session_not_found / refresh_token_not_found) で判定し、それ以外のエラーはテストを落とす。
 *
 * 実行 (ローカル Supabase が必要。dev サーバは不要):
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/password-update-revokes-sessions.test.ts
 */

import { createClient, isAuthSessionMissingError, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

// ユーザーを作ってパスワードを書き換えるテストなので、本番や共有環境へ誤って向けない (ローカルのスタックだけを対象にする)
const supabaseHost = new URL(url).hostname;
if (supabaseHost !== 'localhost' && supabaseHost !== '127.0.0.1') {
  throw new Error(
    `NEXT_PUBLIC_SUPABASE_URL はローカルの Supabase を指してください (現在のホスト: ${supabaseHost})`,
  );
}

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const srAdmin = client(serviceKey);

const TS = Date.now();
const OLD_PASSWORD = 'OldPass!2026-sec1188';
const NEW_PASSWORD = 'NewPass!2026-sec1188';
const createdUserIds: string[] = [];

interface TestUser {
  id: string;
  email: string;
}

/** 1 つの端末 = 1 つのクライアント = 1 つのセッション (メモリ上にだけ持つ。Web ではブラウザのクライアントに当たる) */
interface Device {
  client: SupabaseClient;
  accessToken: string;
  refreshToken: string;
}

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-1188-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({
    email,
    password: OLD_PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email };
}

/** 端末を 1 つ増やす = 同じユーザーで別のクライアントからサインインする (セッションが 1 つ増える) */
async function signIn(email: string, password: string): Promise<Device> {
  const c = client(anonKey);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`signIn ${email}: ${error?.message}`);
  return { client: c, accessToken: data.session.access_token, refreshToken: data.session.refresh_token };
}

/**
 * アクセストークンのセッションが GoTrue に残っているか。
 * GET /user は JWT の署名と期限だけでなく、session_id のセッションが存在するかまで確かめる
 * (消えていれば session_not_found。supabase-js はこれを AuthSessionMissingError にする)。
 * Web のミドルウェアと API ルートが使う getUser() と同じ確認。
 */
async function accessTokenState(device: Device, userId: string): Promise<'alive' | 'revoked'> {
  const { data, error } = await client(anonKey).auth.getUser(device.accessToken);
  if (!error && data.user?.id === userId) return 'alive';
  if (isAuthSessionMissingError(error)) return 'revoked';
  throw new Error(`getUser が想定外の結果です: ${error?.name} ${error?.message}`);
}

/**
 * リフレッシュトークンで新しいトークンをもらえるか (= 端末がログインを保てるか)。
 * 生きているセッションで呼ぶとトークンが回る (ローテーション) ので、端末ごとに最後に 1 回だけ呼ぶ。
 */
async function refreshTokenState(device: Device): Promise<'alive' | 'revoked'> {
  const { data, error } = await client(anonKey).auth.refreshSession({ refresh_token: device.refreshToken });
  if (!error && data.session) return 'alive';
  if (error && (error as { code?: string }).code === 'refresh_token_not_found') return 'revoked';
  throw new Error(`refreshSession が想定外の結果です: ${error?.name} ${error?.message}`);
}

afterAll(async () => {
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 30_000);

describe('#1188 パスワード更新と各端末のセッション (GoTrue)', () => {
  it('P-1: updateUser({ password }) をした端末以外のセッションは、GoTrue が自動で失効させる', async () => {
    const user = await createUser('p1');
    const resetDevice = await signIn(user.email, OLD_PASSWORD); // リセットメールのリンクを開いた端末
    const otherDevice = await signIn(user.email, OLD_PASSWORD); // ほかの端末 (古い端末・第三者が持つセッション)

    // 更新前はどちらも有効 (ここが有効でないと、下の「失効した」に意味がない)
    expect(await accessTokenState(resetDevice, user.id)).toBe('alive');
    expect(await accessTokenState(otherDevice, user.id)).toBe('alive');

    const { error } = await resetDevice.client.auth.updateUser({ password: NEW_PASSWORD });
    expect(error).toBeNull();

    expect(await accessTokenState(otherDevice, user.id)).toBe('revoked');
    expect(await refreshTokenState(otherDevice)).toBe('revoked');
  });

  it('P-2: 更新をした端末自身のセッションは残る (だから Web のページは更新後に自分で signOut する)', async () => {
    const user = await createUser('p2');
    const resetDevice = await signIn(user.email, OLD_PASSWORD);

    const { error } = await resetDevice.client.auth.updateUser({ password: NEW_PASSWORD });
    expect(error).toBeNull();

    expect(await accessTokenState(resetDevice, user.id)).toBe('alive');
    expect(await refreshTokenState(resetDevice)).toBe('alive');
  });

  it('P-3: updateUser → signOut({ scope: "global" }) の後は、どの端末のセッションも残らない。新しいパスワードでだけ入れる', async () => {
    const user = await createUser('p3');
    const resetDevice = await signIn(user.email, OLD_PASSWORD);
    const otherDevice = await signIn(user.email, OLD_PASSWORD);

    // Web の /auth/reset-password と同じ呼び出し
    const { error: updateError } = await resetDevice.client.auth.updateUser({ password: NEW_PASSWORD });
    expect(updateError).toBeNull();
    const { error: signOutError } = await resetDevice.client.auth.signOut({ scope: 'global' });
    expect(signOutError).toBeNull();

    // この端末: ローカルのセッションが消え、サーバー側のセッションも残っていない
    expect((await resetDevice.client.auth.getSession()).data.session).toBeNull();
    expect(await accessTokenState(resetDevice, user.id)).toBe('revoked');
    expect(await refreshTokenState(resetDevice)).toBe('revoked');
    // ほかの端末
    expect(await accessTokenState(otherDevice, user.id)).toBe('revoked');
    expect(await refreshTokenState(otherDevice)).toBe('revoked');

    // 新しいパスワードで入れて、古いパスワードでは入れない
    const fresh = await signIn(user.email, NEW_PASSWORD);
    expect(await accessTokenState(fresh, user.id)).toBe('alive');
    const oldPassword = await client(anonKey).auth.signInWithPassword({
      email: user.email,
      password: OLD_PASSWORD,
    });
    expect(oldPassword.data.session).toBeNull();
    expect(oldPassword.error?.code).toBe('invalid_credentials');
  });

  it('P-4: signOut({ scope: "others" }) は今のセッションを残して、他のセッションだけを失効させる', async () => {
    const user = await createUser('p4');
    const current = await signIn(user.email, OLD_PASSWORD);
    const other = await signIn(user.email, OLD_PASSWORD);

    const { error } = await current.client.auth.signOut({ scope: 'others' });
    expect(error).toBeNull();

    // 今のセッションは、ローカルにもサーバーにも残る
    expect((await current.client.auth.getSession()).data.session).not.toBeNull();
    expect(await accessTokenState(current, user.id)).toBe('alive');
    expect(await refreshTokenState(current)).toBe('alive');
    // ほかの端末は消える
    expect(await accessTokenState(other, user.id)).toBe('revoked');
    expect(await refreshTokenState(other)).toBe('revoked');
  });
});
