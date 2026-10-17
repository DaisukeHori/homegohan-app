/**
 * #1864 パスワードの長さの上限 (bcrypt の 72 バイト) を、実物の GoTrue と pgcrypto で確かめる結合テスト (ローカル Supabase)。
 *
 * 背景: アプリの API の Zod は 1024 文字まで受け付けるが、GoTrue はパスワードを bcrypt でハッシュする。
 *   GoTrue v2.183.0 は 72 バイトを超えるパスワードを、新規登録 (POST /auth/v1/signup) と更新 (PUT /auth/v1/user) の入口
 *   (internal/api/password.go の checkPasswordStrength。MaxPasswordLength = 72。Go の len はバイト数) で
 *   400 validation_failed で断る。アプリの performPasswordChange はこれを upstream-error (500) にしてしまうので、
 *   packages/shared の validatePassword に同じ上限 (PASSWORD_MAX_BYTES) を足して、画面と route で先に止める。
 *   この結合テストは、その上限が GoTrue の境目と一致していること (72 バイトは通り、73 バイト・日本語 26 文字は断られる) を実物で固定する。
 *
 * 確かめること:
 *   M-1 signUp: 72 バイトは登録でき、73 バイト・日本語 26 文字 (74 バイト)・絵文字 19 個 + 英数字 (78 バイト) は 400 validation_failed
 *   M-2 PUT /auth/v1/user (updatePasswordWithAccessToken。段 C の route が使う口): 同じ境目
 *   M-3 validatePassword が通す / 止めるの判定は、M-1・M-2 の GoTrue の判定とすべての試料で一致する
 *   M-4 pgcrypto の crypt (auth_password_check §11.5) も bcrypt なので、72 バイトより後ろだけが違うパスワードを区別しない
 *       (現在のパスワードの照合が通る・履歴の照合で reused になる)。新しいパスワードを 72 バイトまでにすれば、この取り違えは起きない
 *   M-5 72 バイトを超える既存のパスワード (上限の前に別の経路で作られた bcrypt。GoTrue の既定のコスト 10) の利用者は、
 *       そのパスワードでログインでき (GoTrue の照合は 72 バイトで切って比べる)、現在のパスワードとして渡して 72 バイト以内の
 *       新しいパスワードに変えられる。だからログインと現在のパスワードには上限を付けない
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない。本番には接続しない。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/password-max-bytes.test.ts
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { PASSWORD_MAX_BYTES, utf8ByteLength, validatePassword } from '@homegohan/shared';
import { updatePasswordWithAccessToken } from '@/lib/auth/password/gotrue-user';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}
// ユーザーを作ってパスワードを書き換えるテストなので、ローカルのスタックだけを対象にする
const supabaseHost = new URL(url).hostname;
if (supabaseHost !== 'localhost' && supabaseHost !== '127.0.0.1') {
  throw new Error(`NEXT_PUBLIC_SUPABASE_URL はローカルの Supabase を指してください (現在のホスト: ${supabaseHost})`);
}

/** GoTrue が 72 バイト超を断るときの HTTP の status と error code (internal/api/password.go の NewBadRequestError(ErrorCodeValidationFailed)) */
const GOTRUE_TOO_LONG_STATUS = 400;
const GOTRUE_TOO_LONG_CODE = 'validation_failed';
/** auth_password_check に渡す世代数 (一般の利用者の既定 = passwordHistoryGenerationsFor([]) と同じ値) */
const PASSWORD_GENERATIONS_USER = 3;
/** GoTrue が新しく作る bcrypt のコスト (x/crypto/bcrypt の DefaultCost)。ログインの後に作り直さない値にそろえる (M-5) */
const GOTRUE_BCRYPT_DEFAULT_COST = 10;

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}
const srAdmin = client(serviceKey);

/** ローカルスタックの postgres-meta で SQL を実行する (ローカルだけ。上でホストを確かめている) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

const TS = Date.now();
const BASE_PASSWORD = 'MaxBytes1864Base1';
const createdUserIds: string[] = [];
let userSeq = 0;

const nextEmail = (label: string) => {
  userSeq += 1;
  return `sec-1864-${label}-${userSeq}-${TS}@homegohan.test`;
};

/** 半角だけで、ちょうど bytes バイト (= 文字数) のパスワード (英字・数字を含む) */
function asciiPassword(bytes: number, fill = 'x'): string {
  const head = 'Ab1';
  return head + fill.repeat(bytes - head.length);
}

/** 試料: 名前とパスワード。GoTrue が受け付けるはずかは utf8ByteLength(password) <= PASSWORD_MAX_BYTES で決まる */
const SAMPLES: ReadonlyArray<{ label: string; password: string }> = [
  { label: '半角 72 バイト', password: asciiPassword(PASSWORD_MAX_BYTES) },
  { label: '半角 73 バイト', password: asciiPassword(PASSWORD_MAX_BYTES + 1) },
  { label: '日本語 23 文字 + 英数字 (71 バイト)', password: `a1${'あ'.repeat(23)}` },
  { label: '日本語 24 文字 + 英数字 (74 バイト・26 文字)', password: `a1${'あ'.repeat(24)}` },
  { label: '絵文字 19 個 + 英数字 (78 バイト・40 UTF-16 単位)', password: `a1${'😀'.repeat(19)}` },
];

async function createUser(label: string, password: string = BASE_PASSWORD): Promise<{ id: string; email: string }> {
  const email = nextEmail(label);
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email };
}

async function signIn(email: string, password: string): Promise<{ accessToken: string } | { status: number | undefined; code: string | undefined }> {
  const { data, error } = await client(anonKey).auth.signInWithPassword({ email, password });
  if (error || !data.session) return { status: error?.status, code: error?.code };
  return { accessToken: data.session.access_token };
}

async function accessTokenOf(email: string, password: string): Promise<string> {
  const result = await signIn(email, password);
  if (!('accessToken' in result)) throw new Error(`signIn ${email}: ${result.status} ${result.code}`);
  return result.accessToken;
}

/** signUp の結果を { accepted } / { status, code } にそろえる。作られた利用者は後で消す */
async function trySignUp(label: string, password: string): Promise<{ accepted: true } | { accepted: false; status: number | undefined; code: string | undefined }> {
  const { data, error } = await client(anonKey).auth.signUp({ email: nextEmail(label), password });
  if (data.user?.id) createdUserIds.push(data.user.id);
  if (error) return { accepted: false, status: error.status, code: error.code };
  return { accepted: true };
}

const checkPassword = (userId: string, current: string | null, next: string) =>
  srAdmin.rpc('auth_password_check', {
    p_user_id: userId,
    p_current_password: current,
    p_new_password: next,
    p_generations: PASSWORD_GENERATIONS_USER,
  });

afterAll(async () => {
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

describe('#1864 試料のバイト数 (前提)', () => {
  it('試料は 72 バイトの両側にある (72・73・71・74・78 バイト)', () => {
    expect(SAMPLES.map((sample) => utf8ByteLength(sample.password))).toEqual([72, 73, 71, 74, 78]);
    for (const sample of SAMPLES) {
      expect(utf8ByteLength(sample.password), sample.label).toBe(Buffer.byteLength(sample.password, 'utf8'));
    }
  });
});

describe('#1864 GoTrue のパスワードの長さの上限 (bcrypt の 72 バイト)', () => {
  it('M-1 signUp: 72 バイト以下は登録でき、72 バイトを超えると 400 validation_failed (文字数ではなくバイト数で数える)', async () => {
    for (const sample of SAMPLES) {
      const result = await trySignUp('signup', sample.password);
      if (utf8ByteLength(sample.password) <= PASSWORD_MAX_BYTES) {
        expect(result, sample.label).toEqual({ accepted: true });
      } else {
        expect(result, sample.label).toEqual({ accepted: false, status: GOTRUE_TOO_LONG_STATUS, code: GOTRUE_TOO_LONG_CODE });
      }
    }
  });

  it('M-2 PUT /auth/v1/user (updatePasswordWithAccessToken): 72 バイト以下は更新でき、72 バイトを超えると 400 validation_failed', async () => {
    const user = await createUser('update');
    let current = BASE_PASSWORD;
    for (const sample of SAMPLES) {
      const token = await accessTokenOf(user.email, current);
      const result = await updatePasswordWithAccessToken(token, sample.password, current);
      if (utf8ByteLength(sample.password) <= PASSWORD_MAX_BYTES) {
        expect(result, sample.label).toEqual({ error: null });
        current = sample.password;
      } else {
        expect(result, sample.label).toEqual({ error: { code: GOTRUE_TOO_LONG_CODE, status: GOTRUE_TOO_LONG_STATUS } });
      }
    }
    // 断られた更新ではパスワードは変わっていない (最後に通った試料で入れる)
    expect('accessToken' in (await signIn(user.email, current))).toBe(true);
  });

  it('M-3 validatePassword (packages/shared) は、GoTrue が断る試料をすべて止め、受け付ける試料をすべて通す (境目が一致する)', async () => {
    for (const sample of SAMPLES) {
      const result = await trySignUp('rule', sample.password);
      const ruleAccepts = validatePassword(sample.password) === null;
      expect(ruleAccepts, sample.label).toBe(result.accepted);
    }
  });
});

describe('#1864 pgcrypto (auth_password_check §11.5) と 72 バイトより後ろ', () => {
  it('M-4 先頭 72 バイトが同じなら、後ろが違っても現在のパスワードの照合が通り、履歴の照合では reused になる', async () => {
    const password72 = asciiPassword(PASSWORD_MAX_BYTES);
    const user = await createUser('pgcrypto', password72);
    const differentTail = `${password72}DifferentTail9`;

    // 現在のパスワードとして、後ろだけ違うものを渡しても current_mismatch にならない (bcrypt は 72 バイトで切る)
    expect((await checkPassword(user.id, differentTail, 'Another1864pass')).data).toBe('ok');
    // 先頭が違えば current_mismatch (照合そのものは効いている)
    expect((await checkPassword(user.id, `X${password72.slice(1)}`, 'Another1864pass')).data).toBe('current_mismatch');
    // 新しいパスワードとして、後ろだけ違うものは「同じ」と判定される (再設定でも変更でも)
    expect((await checkPassword(user.id, null, differentTail)).data).toBe('reused');
    expect((await checkPassword(user.id, password72, differentTail)).data).toBe('reused');
    // validatePassword は 72 バイトを超える新しいパスワードを止めるので、この取り違えは新しいパスワードでは起きない
    expect(validatePassword(differentTail)).not.toBeNull();
  });

  it('M-5 72 バイトを超える既存のパスワードの利用者は、そのパスワードでログインでき、現在のパスワードとして渡して 72 バイト以内に変えられる', async () => {
    const user = await createUser('existing-long');
    const longPassword = asciiPassword(PASSWORD_MAX_BYTES + PASSWORD_MAX_BYTES);
    // GoTrue は 72 バイト超のハッシュを作らないので、上限の前に別の経路で作られた bcrypt を pgcrypto で作って入れる (英数字だけ = SQL に安全)
    await pgQuery(
      `UPDATE auth.users SET encrypted_password = extensions.crypt('${longPassword}', extensions.gen_salt('bf', ${GOTRUE_BCRYPT_DEFAULT_COST})) WHERE id = '${user.id}'`,
    );

    // ログイン: そのパスワードで入れる (ログインの側には上限を付けない)
    const token = await accessTokenOf(user.email, longPassword);
    // 変更の照合 (RPC) と GoTrue の更新: 現在のパスワードが 72 バイトを超えていても通る
    const next = asciiPassword(PASSWORD_MAX_BYTES, 'z');
    expect((await checkPassword(user.id, longPassword, next)).data).toBe('ok');
    expect(await updatePasswordWithAccessToken(token, next, longPassword)).toEqual({ error: null });
    expect('accessToken' in (await signIn(user.email, next))).toBe(true);
  });
});
