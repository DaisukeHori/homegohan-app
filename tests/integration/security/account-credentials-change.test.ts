/**
 * #1187 ログイン中のパスワード変更・メールアドレス変更 (結合テスト: ローカルの Supabase Auth だけを使う)
 *
 * 背景:
 *   Web に「アカウント」画面 (src/app/(main)/settings/account/page.tsx) を作り、ログイン中のユーザーが
 *   自分でパスワードとメールアドレスを変えられるようにした。画面は Supabase Auth (GoTrue) の次の挙動に頼っている。
 *   画面の呼び出し順・文言・エラーの見せ方は単体テスト src/__tests__/app/settings/account-page.test.ts が見る。
 *   ここでは、画面が頼っている GoTrue 側の挙動を、実物で固定する。
 *
 * 確かめること (GoTrue v2.183.0 で確認。scripts/supabase-local.sh は本番に合わせた版でローカルを立てる):
 *   A-1: 現在のパスワードが違う signInWithPassword は 400 invalid_credentials で、セッションは作られない
 *        (画面はこのエラーコードで「現在のパスワードが正しくありません」を出す)
 *   A-2: 画面と同じ流れ (同じクライアントで再認証 → updateUser({ password }) → signOut({ scope: 'others' })) の後は、
 *        再認証で作り直したこの端末のセッションだけが残る。再認証の前にこの端末が持っていたセッションも、
 *        ほかの端末のセッションも失効する。新しいパスワードでだけ入れる
 *   A-3: 今と同じパスワードへの updateUser は 422 same_password (画面はこのエラーコードで案内を出す)
 *   A-4: updateUser({ email }) は、確認が済むまでメールアドレスを変えない (email はそのまま、new_email に入る)。
 *        確認前は、これまでのメールアドレスでログインできて、新しいメールアドレスでは入れない
 *   A-5: すでに使われているメールアドレスへの updateUser({ email }) は 422 email_exists
 *
 * 判定が通信エラーやレート制限などで偶然「失効」に見えないよう、失効は GoTrue が返す具体的なエラー
 * (session_not_found / refresh_token_not_found) で判定し、それ以外のエラーはテストを落とす。
 * メールアドレスの変更は確認メールを送るので、1 ユーザーにつき 1 回だけ呼ぶ (同じユーザーが連続で呼ぶと送信間隔の制限に当たる)。
 *
 * 実行 (ローカル Supabase が必要。dev サーバは不要):
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/account-credentials-change.test.ts
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
const OLD_PASSWORD = 'OldPass!2026-sec1187';
const NEW_PASSWORD = 'NewPass!2026-sec1187';
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
  const email = `sec-1187-${label}-${TS}@homegohan.test`;
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
async function accessTokenState(accessToken: string, userId: string): Promise<'alive' | 'revoked'> {
  const { data, error } = await client(anonKey).auth.getUser(accessToken);
  if (!error && data.user?.id === userId) return 'alive';
  if (isAuthSessionMissingError(error)) return 'revoked';
  throw new Error(`getUser が想定外の結果です: ${error?.name} ${error?.message}`);
}

/**
 * リフレッシュトークンで新しいトークンをもらえるか (= 端末がログインを保てるか)。
 * 生きているセッションで呼ぶとトークンが回る (ローテーション) ので、失効の確認にだけ使う。
 */
async function refreshTokenState(refreshToken: string): Promise<'alive' | 'revoked'> {
  const { data, error } = await client(anonKey).auth.refreshSession({ refresh_token: refreshToken });
  if (!error && data.session) return 'alive';
  if (error && (error as { code?: string }).code === 'refresh_token_not_found') return 'revoked';
  throw new Error(`refreshSession が想定外の結果です: ${error?.name} ${error?.message}`);
}

afterAll(async () => {
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 30_000);

describe('#1187 ログイン中のパスワード変更 (GoTrue)', () => {
  it('A-1: 現在のパスワードが違う signInWithPassword は 400 invalid_credentials で、セッションは作られない', async () => {
    const user = await createUser('a1');

    const { data, error } = await client(anonKey).auth.signInWithPassword({
      email: user.email,
      password: 'WrongPass!2026-sec1187',
    });
    expect(data.session).toBeNull();
    expect(error?.status).toBe(400);
    expect(error?.code).toBe('invalid_credentials');

    // 元のパスワードは変わっていない
    const device = await signIn(user.email, OLD_PASSWORD);
    expect(await accessTokenState(device.accessToken, user.id)).toBe('alive');
  });

  it('A-2: 再認証 → updateUser → signOut({ scope: "others" }) の後は、この端末の新しいセッションだけが残る。新しいパスワードでだけ入れる', async () => {
    const user = await createUser('a2');
    const existing = await signIn(user.email, OLD_PASSWORD); // ブラウザが元から持っていたセッション
    const other = await signIn(user.email, OLD_PASSWORD); // ほかの端末 (古い端末・第三者が持つセッション)

    // 更新前はどちらも有効 (ここが有効でないと、下の「失効した」に意味がない)
    expect(await accessTokenState(existing.accessToken, user.id)).toBe('alive');
    expect(await accessTokenState(other.accessToken, user.id)).toBe('alive');

    // 画面と同じ呼び出し: 同じクライアントで、本人のメールアドレスと現在のパスワードで再認証する。
    // この端末のセッションは新しいものに入れ替わる
    const { data: reauth, error: reauthError } = await existing.client.auth.signInWithPassword({
      email: user.email,
      password: OLD_PASSWORD,
    });
    expect(reauthError).toBeNull();
    expect(reauth.session).not.toBeNull();
    const reauthToken = reauth.session!.access_token;
    expect(reauthToken).not.toBe(existing.accessToken);

    const { error: updateError } = await existing.client.auth.updateUser({ password: NEW_PASSWORD });
    expect(updateError).toBeNull();
    const { error: signOutError } = await existing.client.auth.signOut({ scope: 'others' });
    expect(signOutError).toBeNull();

    // この端末: 再認証で作り直したセッションがローカルにもサーバーにも残る (ログインしたまま)
    const current = (await existing.client.auth.getSession()).data.session;
    expect(current).not.toBeNull();
    expect(current!.access_token).toBe(reauthToken);
    expect(await accessTokenState(current!.access_token, user.id)).toBe('alive');
    // 再認証の前にこの端末が持っていたセッションと、ほかの端末のセッションは失効する
    expect(await accessTokenState(existing.accessToken, user.id)).toBe('revoked');
    expect(await refreshTokenState(existing.refreshToken)).toBe('revoked');
    expect(await accessTokenState(other.accessToken, user.id)).toBe('revoked');
    expect(await refreshTokenState(other.refreshToken)).toBe('revoked');

    // 新しいパスワードで入れて、古いパスワードでは入れない
    const fresh = await signIn(user.email, NEW_PASSWORD);
    expect(await accessTokenState(fresh.accessToken, user.id)).toBe('alive');
    const oldPassword = await client(anonKey).auth.signInWithPassword({
      email: user.email,
      password: OLD_PASSWORD,
    });
    expect(oldPassword.data.session).toBeNull();
    expect(oldPassword.error?.code).toBe('invalid_credentials');
  });

  it('A-3: 今と同じパスワードへの updateUser は 422 same_password', async () => {
    const user = await createUser('a3');
    const device = await signIn(user.email, OLD_PASSWORD);

    const { error } = await device.client.auth.updateUser({ password: OLD_PASSWORD });
    expect(error?.status).toBe(422);
    expect(error?.code).toBe('same_password');
    // 失敗したので何も変わらない: 元のパスワードで入れる
    expect(await accessTokenState(device.accessToken, user.id)).toBe('alive');
  });
});

describe('#1187 ログイン中のメールアドレス変更 (GoTrue)', () => {
  it('A-4: updateUser({ email }) は確認が済むまでメールアドレスを変えない (email はそのまま、new_email に入る)', async () => {
    const user = await createUser('a4');
    const device = await signIn(user.email, OLD_PASSWORD);
    const newEmail = `sec-1187-a4-new-${TS}@homegohan.test`;

    const { data, error } = await device.client.auth.updateUser(
      { email: newEmail },
      { emailRedirectTo: 'http://127.0.0.1:3000/auth/callback' },
    );
    expect(error).toBeNull();
    // 画面が確認前に「変更しました」と言わない根拠: 返ってくるユーザーも、サーバー上のユーザーも、メールアドレスはまだ元のまま
    expect(data.user?.email).toBe(user.email);
    expect(data.user?.new_email).toBe(newEmail);

    const { data: server, error: serverError } = await srAdmin.auth.admin.getUserById(user.id);
    expect(serverError).toBeNull();
    expect(server.user?.email).toBe(user.email);
    expect(server.user?.new_email).toBe(newEmail);

    // 確認前は、これまでのメールアドレスでログインできて、新しいメールアドレスでは入れない
    const viaOld = await signIn(user.email, OLD_PASSWORD);
    expect(await accessTokenState(viaOld.accessToken, user.id)).toBe('alive');
    const viaNew = await client(anonKey).auth.signInWithPassword({ email: newEmail, password: OLD_PASSWORD });
    expect(viaNew.data.session).toBeNull();
    expect(viaNew.error?.code).toBe('invalid_credentials');
  });

  it('A-5: すでに使われているメールアドレスへの updateUser({ email }) は 422 email_exists で、何も変わらない', async () => {
    const user = await createUser('a5');
    const taken = await createUser('a5-taken');
    const device = await signIn(user.email, OLD_PASSWORD);

    const { error } = await device.client.auth.updateUser({ email: taken.email });
    expect(error?.status).toBe(422);
    expect(error?.code).toBe('email_exists');

    const { data: server } = await srAdmin.auth.admin.getUserById(user.id);
    expect(server.user?.email).toBe(user.email);
    expect(server.user?.new_email).toBeFalsy();
  });
});
