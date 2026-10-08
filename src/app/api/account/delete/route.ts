import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { accountDeletionFailure, accountDeletionHttp, deleteAccount } from '@/lib/account-deletion';
import { NextResponse } from 'next/server';

// Storage のファイル削除に時間がかかることがある (src/lib/account-deletion-storage.ts の上限 45 秒より長くしておく)
export const maxDuration = 60;

/**
 * POST /api/account/delete
 * ログイン中の本人のアカウントを削除する (即時削除。取り消せない)。
 * 本体は src/lib/account-deletion.ts (#1175)。ここは入口の確認 (401 / 400) と、結果の HTTP への変換だけを行う。
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  if (!body?.confirm) {
    return NextResponse.json({ error: 'confirm is required' }, { status: 400 });
  }

  const requestId = generateRequestId();

  let admin: ReturnType<typeof getSupabaseAdmin>;
  try {
    // 本人をログインセッションで確認したあとにだけ service_role の client を作る
    admin = getSupabaseAdmin();
  } catch (error) {
    createLogger('POST /api/account/delete', requestId)
      .withUser(user.id)
      .error('account deletion failed: service role client is not configured', error, { step: 'init', request_id: requestId });
    const { status, body: failureBody } = accountDeletionHttp(accountDeletionFailure(requestId, 'init'));
    return NextResponse.json(failureBody, { status });
  }

  const result = await deleteAccount({ userId: user.id, admin, requestId });
  const { status, body: responseBody } = accountDeletionHttp(result);
  return NextResponse.json(responseBody, { status });
}
