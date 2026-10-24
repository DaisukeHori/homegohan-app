import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { PUSH_TOKEN_CLAIM_ERROR_CODES, isExpoPushToken } from '@/lib/push-tokens';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { generatePushInstallSecret, hashPushInstallSecret } from '@/lib/push-token-install-secret';
import { isPushInstallSecret, type PushTokenClaimResponseBody } from '@homegohan/shared';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';

const ROUTE_NAME = 'POST /api/push-tokens/claim';

/** 応答 (発行した端末の秘密の値を含むことがある) を、途中の置き場に残させない */
const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' } as const;

function badRequest(message: string) {
  return NextResponse.json(
    { error: { code: PUSH_TOKEN_CLAIM_ERROR_CODES.INVALID_REQUEST, message } },
    { status: 400 },
  );
}

/**
 * 端末の秘密の値の扱い (本文で決まる。packages/shared/src/push-token-claim.ts の PushTokenClaimRequestBody)
 *   - provided: 端末が値を送ってきた
 *   - issue:    端末に値がまだ無い。ここで作って返す
 *   - none:     どちらも無い (古い版のアプリ・保管庫を読めなかった)。本人の行のハッシュには触れない
 */
type SecretMode = { kind: 'provided'; secret: string } | { kind: 'issue' } | { kind: 'none' };

/** 本文から、トークンと端末の秘密の値の扱いを取り出す。形が違えば 400 の応答を返す */
function parseClaimBody(body: unknown): { token: string; mode: SecretMode } | { error: NextResponse } {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const token = record.expo_push_token;
  if (!isExpoPushToken(token)) {
    return { error: badRequest('通知のトークン (expo_push_token) が Expo の通知のトークンの形ではありません') };
  }
  const secret = record.install_secret;
  const issue = record.issue_install_secret;
  if (issue !== undefined && issue !== true) {
    return { error: badRequest('端末の秘密の値の発行 (issue_install_secret) は true だけを受け付けます') };
  }
  if (secret !== undefined && issue === true) {
    return { error: badRequest('端末の秘密の値 (install_secret) と端末の秘密の値の発行 (issue_install_secret) は同時に送れません') };
  }
  if (secret !== undefined) {
    if (!isPushInstallSecret(secret)) {
      return { error: badRequest('端末の秘密の値 (install_secret) の形が正しくありません') };
    }
    return { token, mode: { kind: 'provided', secret } };
  }
  return { token, mode: issue === true ? { kind: 'issue' } : { kind: 'none' } };
}

/**
 * この端末の push token を、呼び出した利用者だけのものにする (#1599)。外すのは同じ端末の前の利用者の行だけ (#1636)。
 *
 * アプリ (apps/mobile/src/lib/pushNotifications.ts の registerAndSaveExpoPushToken) が、
 * user_push_tokens への登録 (本人の行の upsert。RLS) のすぐあとに呼ぶ。
 * 同じトークンが別の利用者の行にも残っていれば (共有の端末で、前の利用者のログアウトの削除がオフラインなどで失敗したとき)、
 * その行を消す。同じトークンは、最後に登録した 1 人にだけ紐づく (src/lib/push-tokens.ts の説明)。
 *
 * 所有の証明 (#1636): トークンの値を知っているだけの他人が、自分の行として登録して claim すると、持ち主の行を消せた。
 * いまは、端末の秘密の値 (端末ごとに 1 つ。サーバーは SHA-256 のハッシュだけを行に持つ。packages/shared/src/push-token-claim.ts)
 * が合う行だけを外す。同じ端末でログインした利用者はみな同じ値を持つので、同じ端末の前の利用者の行は外せ、他人の端末の行は外せない。
 * ハッシュの無い行 (#1636 より前の版のアプリが登録し、まだ新しい版で claim していない行) は、移行のあいだ今までどおり外す
 * (新しい版のアプリは起動のたびに claim して自分の行にハッシュを書くので、新しい版の利用者の行は守られる)。
 *
 *   1. 認証 (未ログインは 401)
 *   2. 本文 { expo_push_token, install_secret? | issue_install_secret? } の形を確かめる (違えば 400)
 *   3. 呼び出した利用者の行に、このトークンがあることを確かめる (本人のクライアント・RLS。無ければ 404)
 *      登録していないトークンで、ほかの利用者の行を消させない
 *   4. 端末の秘密の値があれば (送られてきた・ここで作った)、本人の行にそのハッシュを書く (service_role)
 *   5. 同じトークンの、ほかの利用者の行のうち、ハッシュが同じ行とハッシュの無い行を消す (RLS を越えるので service_role。
 *      service_role のクライアントは認証と 3 のあとにだけ作る)
 *
 * 応答: 200 { released: 消した行の数, install_secret?: 作った値 (issue_install_secret のときだけ) }。
 * 何度呼んでも同じ結果になる (やり直してよい。issue_install_secret のやり直しは、値を作り直して本人の行のハッシュを書き換える)。
 * メンテナンス中・凍結中でも middleware は止めない (src/lib/push-tokens.ts の isPushTokenClaimApiPath)。
 */
export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('本文が JSON ではありません');
  }
  const parsed = parseClaimBody(body);
  if ('error' in parsed) return parsed.error;
  const { token, mode } = parsed;

  const { data: own, error: ownError } = await supabase
    .from('user_push_tokens')
    .select('id')
    .eq('user_id', user.id)
    .eq('expo_push_token', token)
    .maybeSingle();
  if (ownError) {
    return internalError(ROUTE_NAME, ownError, { userId: user.id, step: 'select_own' });
  }
  if (!own) {
    return NextResponse.json(
      {
        error: {
          code: PUSH_TOKEN_CLAIM_ERROR_CODES.NOT_REGISTERED,
          message: 'このトークンは登録されていません。先に登録してください',
        },
      },
      { status: 404 },
    );
  }

  const issuedSecret = mode.kind === 'issue' ? generatePushInstallSecret() : null;
  const secret = mode.kind === 'provided' ? mode.secret : issuedSecret;
  const secretHash = secret === null ? null : hashPushInstallSecret(secret);

  try {
    const admin = getSupabaseAdmin();

    if (secretHash !== null) {
      const { error: markError } = await admin
        .from('user_push_tokens')
        .update({ install_secret_hash: secretHash })
        .eq('user_id', user.id)
        .eq('expo_push_token', token);
      if (markError) {
        return internalError(ROUTE_NAME, markError, { userId: user.id, step: 'mark_own' });
      }
    }

    // ほかの利用者の行のうち、同じ端末のもの (ハッシュが同じ) と、移行のあいだのハッシュの無いものだけを消す。
    // secretHash は SHA-256 の 16 進 (英数字だけ) なので、or の絞り込みの文字列に埋めても区切りの文字は入らない
    const others = admin
      .from('user_push_tokens')
      .delete({ count: 'exact' })
      .eq('expo_push_token', token)
      .neq('user_id', user.id);
    const { error: releaseError, count } = await (secretHash === null
      ? others.is('install_secret_hash', null)
      : others.or(`install_secret_hash.is.null,install_secret_hash.eq.${secretHash}`));
    if (releaseError) {
      return internalError(ROUTE_NAME, releaseError, { userId: user.id, step: 'release_others' });
    }

    const response: PushTokenClaimResponseBody = { released: count ?? 0 };
    if (issuedSecret !== null) response.install_secret = issuedSecret;
    return NextResponse.json(response, { headers: NO_STORE_HEADERS });
  } catch (error) {
    // service_role の環境変数が欠けている (MissingEnvError) など
    return internalError(ROUTE_NAME, error, { userId: user.id, step: 'release_others' });
  }
}
