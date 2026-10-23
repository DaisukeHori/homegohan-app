import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { generateRequestId } from '@/lib/db-logger';
import { internalError } from '@/lib/api/errors';
import { accountDeletionHttp, deleteAccount, isAccountDeletionFailure } from '@/lib/account-deletion';
import { NextResponse } from 'next/server';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';

// Storage のファイル削除に時間がかかることがある (src/lib/account-deletion-storage.ts の上限 45 秒より長くしておく)
export const maxDuration = 60;

/** 構造化ログの function_name */
const ROUTE_NAME = 'POST /api/account/delete';

/** 400: 削除の確認 (confirm) が無い */
const CONFIRM_REQUIRED_MESSAGE = 'アカウントの削除の確認が必要です';

/**
 * POST /api/account/delete
 * ログイン中の本人のアカウントを削除する (即時削除。取り消せない)。
 * 本体は src/lib/account-deletion.ts (#1175)。ここは入口の確認 (401 / 400) と、結果の HTTP への変換だけを行う。
 * 500 は #1172 の規則どおり internalError (汎用メッセージだけ。原因・段階・request_id は本文に出さず、ログに残す) で返す。
 */
export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  if (!body?.confirm) {
    return NextResponse.json({ error: CONFIRM_REQUIRED_MESSAGE }, { status: 400 });
  }

  const requestId = generateRequestId();

  let admin: ReturnType<typeof getSupabaseAdmin>;
  try {
    // 本人をログインセッションで確認したあとにだけ service_role の client を作る
    admin = getSupabaseAdmin();
  } catch (error) {
    return internalError(ROUTE_NAME, error, { userId: user.id, requestId, step: 'init' });
  }

  const result = await deleteAccount({ userId: user.id, admin, requestId });
  if (isAccountDeletionFailure(result)) {
    // 原因 (DB・Storage・Auth のエラー) は deleteAccount が同じ request_id で app_logs に残している。
    // ここでは 500 を返したことと段階だけを残す。userId は付けない
    // (deleteUser の段階の失敗では auth.users の行がもう無いことがあり、app_logs.user_id の外部キーで記録が保存できないため)
    return internalError(ROUTE_NAME, new Error(`account deletion failed at step: ${result.step}`), {
      requestId: result.request_id,
      step: result.step,
    });
  }

  const { status, body: responseBody } = accountDeletionHttp(result);
  return NextResponse.json(responseBody, { status });
}
