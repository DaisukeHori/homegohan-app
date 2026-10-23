import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { PUSH_TOKEN_CLAIM_ERROR_CODES, isExpoPushToken } from '@/lib/push-tokens';
import { hashPushInstallSecret } from '@/lib/push-token-install-secret';
import { isPushInstallSecret, type PushTokenReleaseResponseBody } from '@homegohan/shared';

const ROUTE_NAME = 'POST /api/push-tokens/release';

/** user_id の形 (UUID)。形の違う値で DB を引かない */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(message: string) {
  return NextResponse.json(
    { error: { code: PUSH_TOKEN_CLAIM_ERROR_CODES.INVALID_REQUEST, message } },
    { status: 400 },
  );
}

/**
 * セッションが無いときに、この端末の push token の、サインアウトした利用者の行を消す (#1636)。
 *
 * アプリは、ログアウト (apps/mobile/src/lib/signOut.ts) を通らずにセッションが終わったとき (自動更新で refresh_token が
 * 失効と答えた SIGNED_OUT など) にこれを呼ぶ (apps/mobile/src/lib/pushTokenRelease.ts)。そのときはセッションが無く、
 * 本人の JWT (RLS) では消せない。そこで、端末の秘密の値 (claim で発行し、端末の保管庫に置いた値。
 * packages/shared/src/push-token-claim.ts) で認可する: 利用者 ID・トークン・秘密の値のハッシュの 3 つが合う行だけを消す。
 * 秘密の値はその端末にしか無いので、他人はほかの利用者の行を消せない。ハッシュの無い行 (古い版のアプリの行) は消さない
 * (所有を確かめられないため。次にこの端末でログインした利用者の claim が外す)。
 *
 * 認証は求めない (Authorization が付いていても見ない)。消すのは本文の user_id の行だけなので、
 * サインアウトのあとにすぐ別の利用者がログインして登録した行は巻き込まない。
 * メンテナンス中は middleware が 503 で止める (例外は claim だけ。src/lib/push-tokens.ts)。アプリは次の起動でやり直す。
 *
 * 応答: 200 { released: 消した行の数 }。何度呼んでも同じ結果になる (やり直してよい)。合う行が無くても 200 (0 件)。
 */
export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があれば、DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('本文が JSON ではありません');
  }
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const token = record.expo_push_token;
  const secret = record.install_secret;
  const userId = record.user_id;
  if (!isExpoPushToken(token)) {
    return badRequest('通知のトークン (expo_push_token) が Expo の通知のトークンの形ではありません');
  }
  if (!isPushInstallSecret(secret)) {
    return badRequest('端末の秘密の値 (install_secret) の形が正しくありません');
  }
  if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) {
    return badRequest('利用者の ID (user_id) が UUID の形ではありません');
  }

  try {
    const { error, count } = await getSupabaseAdmin()
      .from('user_push_tokens')
      .delete({ count: 'exact' })
      .eq('user_id', userId)
      .eq('expo_push_token', token)
      .eq('install_secret_hash', hashPushInstallSecret(secret));
    if (error) {
      return internalError(ROUTE_NAME, error, { step: 'release' });
    }
    const response: PushTokenReleaseResponseBody = { released: count ?? 0 };
    return NextResponse.json(response, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    // service_role の環境変数が欠けている (MissingEnvError) など
    return internalError(ROUTE_NAME, error, { step: 'release' });
  }
}
