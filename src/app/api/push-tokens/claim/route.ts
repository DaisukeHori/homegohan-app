import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { PUSH_TOKEN_CLAIM_ERROR_CODES, isExpoPushToken } from '@/lib/push-tokens';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

const ROUTE_NAME = 'POST /api/push-tokens/claim';

function badRequest(message: string) {
  return NextResponse.json(
    { error: { code: PUSH_TOKEN_CLAIM_ERROR_CODES.INVALID_REQUEST, message } },
    { status: 400 },
  );
}

/**
 * この端末の push token を、呼び出した利用者だけのものにする (#1599)。
 *
 * アプリ (apps/mobile/src/lib/pushNotifications.ts の registerAndSaveExpoPushToken) が、
 * user_push_tokens への登録 (本人の行の upsert。RLS) のすぐあとに呼ぶ。
 * 同じトークンが別の利用者の行にも残っていれば (共有の端末で、前の利用者のログアウトの削除がオフラインなどで失敗したとき)、
 * その行を消す。同じトークンは、最後に登録した 1 人にだけ紐づく (src/lib/push-tokens.ts の説明)。
 *
 *   1. 認証 (未ログインは 401)
 *   2. 本文 { expo_push_token } の形を確かめる (違えば 400)
 *   3. 呼び出した利用者の行に、このトークンがあることを確かめる (本人のクライアント・RLS。無ければ 404)
 *      登録していないトークンで、ほかの利用者の行を消させない
 *   4. 同じトークンの、ほかの利用者の行を消す (RLS を越えるので service_role。認証と 3 のあとにだけ作る)
 *
 * 応答: 200 { released: 消した行の数 }。何度呼んでも同じ結果になる (やり直してよい)。
 */
export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('本文が JSON ではありません');
  }
  const token = (body as { expo_push_token?: unknown } | null)?.expo_push_token;
  if (!isExpoPushToken(token)) {
    return badRequest('expo_push_token が Expo の push token の形ではありません');
  }

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

  try {
    const { error: releaseError, count } = await getSupabaseAdmin()
      .from('user_push_tokens')
      .delete({ count: 'exact' })
      .eq('expo_push_token', token)
      .neq('user_id', user.id);
    if (releaseError) {
      return internalError(ROUTE_NAME, releaseError, { userId: user.id, step: 'release_others' });
    }
    return NextResponse.json({ released: count ?? 0 });
  } catch (error) {
    // service_role の環境変数が欠けている (MissingEnvError) など
    return internalError(ROUTE_NAME, error, { userId: user.id, step: 'release_others' });
  }
}
