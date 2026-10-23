// src/app/api/meals/paste/route.ts
// (設計書 membership/02-flow-spec.md §12, 03-ui-spec.md §6)
// POST /api/meals/paste — 食事を家族メンバにペースト

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { PasteMealBodySchema } from '@/schemas/membership/meal-paste';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

/**
 * paste_meal_to_family が RAISE EXCEPTION で投げる語 (PostgREST の error.message)。
 * 確認の順は DB の定義のとおり 持ち主 (NOT_MEAL_OWNER) → 隠した食事 (MEAL_HIDDEN) → お試しの記録 (MEAL_SANDBOX)
 * → 家族への所属 (NOT_IN_FAMILY) → 貼り付けの先 (TARGET_NOT_IN_FAMILY)。
 * 元の行が無いときも NOT_MEAL_OWNER (#1634。持ち主でない人に、その id の行が在るかどうかを教えない)。
 */
const PASTE_DB_WORDS = ['NOT_MEAL_OWNER', 'MEAL_HIDDEN', 'MEAL_SANDBOX', 'NOT_IN_FAMILY', 'TARGET_NOT_IN_FAMILY'] as const;
type PasteDbWord = (typeof PASTE_DB_WORDS)[number];

function isPasteDbWord(word: string): word is PasteDbWord {
  return (PASTE_DB_WORDS as readonly string[]).includes(word);
}

/** 例外の文の中の語 (英大文字・数字・`_` の並びを最長で切り出す。'TARGET_NOT_IN_FAMILY' から 'NOT_IN_FAMILY' は切り出さない) */
const DB_ERROR_WORD = /[A-Z][A-Z0-9_]*/g;

/**
 * 例外の文から、PASTE_DB_WORDS と完全に一致する最初の語を引く。無ければ null。
 * #1634: 部分一致 (includes) だと、短い語が長い語の一部に当たって取り違える
 * (例: 'TARGET_NOT_IN_FAMILY' に 'NOT_IN_FAMILY' が当たり、本来の 400 USER_NOT_IN_FAMILY でなく 403 NOT_IN_FAMILY が返っていた)
 */
function pasteDbWordOf(message: string): PasteDbWord | null {
  for (const word of message.match(DB_ERROR_WORD) ?? []) {
    if (isPasteDbWord(word)) return word;
  }
  return null;
}

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
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
    // DB が投げた語を語の完全一致で引く (#1634)。本文はこちらで決めた固定の文だけ (DB の文面は入れない)
    switch (pasteDbWordOf(message)) {
      case 'NOT_MEAL_OWNER':
        return NextResponse.json(
          { error: { code: MembershipErrorCode.INSUFFICIENT_PERMISSION, message: '自分の食事のみペースト可能です' } },
          { status: 403 },
        );
      // #1101: 運営が隠した食事は貼り付けられない (隠した内容を家族に見せ直させない)。持ち主の確認 (NOT_MEAL_OWNER) のあとに DB が判定する
      case 'MEAL_HIDDEN':
        return NextResponse.json(
          { error: { code: MembershipErrorCode.MEAL_HIDDEN, message: 'この食事は運営により非表示になっているため、ペーストできません' } },
          { status: 403 },
        );
      // #1627: ハンズオンのお試しの記録は貼り付けられない (写した行は家族の側で本物の記録になってしまう)。持ち主の確認と隠した食事の確認のあとに DB が判定する
      case 'MEAL_SANDBOX':
        return NextResponse.json(
          { error: { code: MembershipErrorCode.MEAL_SANDBOX, message: 'この食事はお試しの記録のため、ペーストできません' } },
          { status: 403 },
        );
      case 'NOT_IN_FAMILY':
        return NextResponse.json(
          { error: { code: MembershipErrorCode.NOT_IN_FAMILY, message: '家族グループに所属していません' } },
          { status: 403 },
        );
      case 'TARGET_NOT_IN_FAMILY':
        return NextResponse.json(
          { error: { code: MembershipErrorCode.USER_NOT_IN_FAMILY, message: 'ペースト先が同じ家族グループにいません' } },
          { status: 400 },
        );
      case null:
        break;
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
