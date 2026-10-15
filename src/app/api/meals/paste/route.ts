// src/app/api/meals/paste/route.ts
// (設計書 membership/02-flow-spec.md §12, 03-ui-spec.md §6)
// POST /api/meals/paste — 食事を家族メンバにペースト

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { PasteMealBodySchema } from '@/schemas/membership/meal-paste';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';

/** paste_meal_to_family が RAISE EXCEPTION で投げる語と、この API が返す応答 */
interface PasteDbError {
  code: MembershipErrorCode;
  status: number;
  message: string;
}

/**
 * paste_meal_to_family が投げる語 (RAISE EXCEPTION の文。PostgREST の error.message) → 応答。
 * 確認の順は DB の定義のとおり 持ち主 (NOT_MEAL_OWNER) → 隠した食事 (MEAL_HIDDEN) → お試しの記録 (MEAL_SANDBOX)
 * → 家族への所属 (NOT_IN_FAMILY) → 貼り付けの先 (TARGET_NOT_IN_FAMILY)。
 * 元の行が無いときも NOT_MEAL_OWNER (#1634。持ち主でない人に、その id の行が在るかどうかを教えない)。
 */
const PASTE_DB_ERRORS: Readonly<Record<string, PasteDbError>> = {
  NOT_MEAL_OWNER: {
    code: MembershipErrorCode.INSUFFICIENT_PERMISSION,
    status: 403,
    message: '自分の食事のみペースト可能です',
  },
  // #1101: 運営が隠した食事は貼り付けられない (隠した内容を家族に見せ直させない)。持ち主の確認 (NOT_MEAL_OWNER) のあとに DB が判定する
  [MembershipErrorCode.MEAL_HIDDEN]: {
    code: MembershipErrorCode.MEAL_HIDDEN,
    status: 403,
    message: 'この食事は運営により非表示になっているため、ペーストできません',
  },
  // #1627: ハンズオンのお試しの記録は貼り付けられない (写した行は家族の側で本物の記録になってしまう)。持ち主の確認と隠した食事の確認のあとに DB が判定する
  [MembershipErrorCode.MEAL_SANDBOX]: {
    code: MembershipErrorCode.MEAL_SANDBOX,
    status: 403,
    message: 'この食事はお試しの記録のため、ペーストできません',
  },
  [MembershipErrorCode.NOT_IN_FAMILY]: {
    code: MembershipErrorCode.NOT_IN_FAMILY,
    status: 403,
    message: '家族グループに所属していません',
  },
  TARGET_NOT_IN_FAMILY: {
    code: MembershipErrorCode.USER_NOT_IN_FAMILY,
    status: 400,
    message: 'ペースト先が同じ家族グループにいません',
  },
};

/** 例外の文の中の語 (英大文字・数字・`_` の並びを最長で切り出す。'TARGET_NOT_IN_FAMILY' から 'NOT_IN_FAMILY' は切り出さない) */
const DB_ERROR_WORD = /[A-Z][A-Z0-9_]*/g;

/** 例外の文から、PASTE_DB_ERRORS の語と完全に一致する最初の語の応答を引く。無ければ null */
function findPasteDbError(message: string): PasteDbError | null {
  for (const word of message.match(DB_ERROR_WORD) ?? []) {
    if (Object.prototype.hasOwnProperty.call(PASTE_DB_ERRORS, word)) return PASTE_DB_ERRORS[word];
  }
  return null;
}

export async function POST(request: Request) {
  const supabase = await createClient();

  // 認証チェック
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  // リクエスト検証
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parsed = PasteMealBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: '入力値が不正です',
          details: parsed.error.flatten().fieldErrors,
        },
      },
      { status: 400 },
    );
  }

  const { source_meal_id, target_user_ids } = parsed.data;

  // RPC: paste_meal_to_family
  // シグネチャ: (p_source_meal_id UUID, p_target_user_ids UUID[]) RETURNS UUID (paste_group_id)
  const { data: paste_group_id, error: rpcError } = await supabase.rpc(
    'paste_meal_to_family',
    {
      p_source_meal_id: source_meal_id,
      p_target_user_ids: target_user_ids,
    },
  );

  if (rpcError) {
    const message = rpcError.message ?? '';
    // #1634: DB が投げた語を、部分一致 (includes) でなく語の完全一致で引く。
    // 部分一致だと、短い語が長い語の一部に当たって取り違える (例: 'TARGET_NOT_IN_FAMILY' に 'NOT_IN_FAMILY' が当たり、
    // 本来の 400 USER_NOT_IN_FAMILY でなく 403 NOT_IN_FAMILY が返っていた)
    const known = findPasteDbError(message);
    if (known) {
      return NextResponse.json({ error: { code: known.code, message: known.message } }, { status: known.status });
    }

    const { code, status } = mapPgErrorToHttp(message);
    console.error('[api/meals/paste] RPC error:', rpcError);
    return NextResponse.json(
      { error: { code: code === 'UNKNOWN' ? MembershipErrorCode.RPC_FAILED : code, message: 'ペーストに失敗しました' } },
      { status },
    );
  }

  return NextResponse.json({
    data: {
      paste_group_id,
      inserted_count: target_user_ids.length,
    },
  });
}
