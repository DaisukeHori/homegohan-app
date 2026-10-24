// src/app/api/family/menu/route.ts
// GET /api/family/menu — 週間献立の「家族の表示」で、家族のメンバーの献立を読み取り専用で返す (#1584 の 1)。
// 設計書: docs/design/family/10-family-menu-view.md §15。
//
// 認可: 見てよい相手の判定は DB の関数 family_menu_visible_members() の 1 か所 (同じ active な家族・相手が active で
// アカウントを持ち share_menu = TRUE・自分以外)。献立は family_menu_planned_meals(p_start_date, p_end_date) が
// 画面に要る鍵だけの jsonb の配列 1 つで返す (行の集合は PostgREST の max_rows で黙って打ち切られるため)。
// どちらも SECURITY DEFINER で、ログイン中の利用者のクライアントの rpc で呼ぶ (service_role は使わない・RLS は広げない)。
// 凍結・メンテナンス・規約の同意は route より前に lib/supabase/middleware.ts が止めるので、ここでは判定しない。
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';
import { isCalendarDate } from '@/lib/date-utils';
import { CALENDAR_DATE_RANGE_PARAMS_LABEL, invalidCalendarDateMessage } from '@/lib/api/user-api-error-messages';
import { groupFamilyMenuRows, isFamilyMenuRangeAllowed, FAMILY_MENU_RANGE_MAX_DAYS } from '@/lib/membership/family-menu';
import { FamilyMenuRpcRowsSchema, type FamilyMenuData } from '@/schemas/membership/family-menu';

const FAILED_MESSAGE = '家族の献立の取得に失敗しました';

export async function GET(request: Request) {
  const logger = createLogger('GET /api/family/menu', generateRequestId());
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } }, { status: 401 });
  }
  const log = logger.withUser(user.id);

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate') ?? '';
  const endDate = searchParams.get('endDate') ?? '';
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate)) {
    return NextResponse.json({ error: { code: MembershipErrorCode.INVALID_REQUEST, message: invalidCalendarDateMessage(CALENDAR_DATE_RANGE_PARAMS_LABEL) } }, { status: 400 });
  }
  if (!isFamilyMenuRangeAllowed(startDate, endDate)) {
    return NextResponse.json({ error: { code: MembershipErrorCode.INVALID_REQUEST, message: `範囲は開始日 (startDate) 以上、終了日 (endDate) 以下で、${FAMILY_MENU_RANGE_MAX_DAYS} 日以内にしてください` } }, { status: 400 });
  }

  const { data: profile, error: profileError } = await supabase.from('user_profiles').select('family_id').eq('id', user.id).maybeSingle();
  if (profileError) {
    log.error('家族の献立: プロフィールの取得に失敗', profileError);
    return NextResponse.json({ error: { code: MembershipErrorCode.RPC_FAILED, message: FAILED_MESSAGE } }, { status: 500 });
  }
  const familyId = profile?.family_id ?? null;
  if (!familyId) {
    const empty: FamilyMenuData = { family_id: null, start_date: startDate, end_date: endDate, members: [] };
    return NextResponse.json({ data: empty }, { status: 200 });
  }

  const { data: members, error: membersError } = await supabase.rpc('family_menu_visible_members');
  if (membersError) {
    log.error('家族の献立: 見てよいメンバーの取得に失敗', membersError, { familyId });
    return NextResponse.json({ error: { code: MembershipErrorCode.RPC_FAILED, message: FAILED_MESSAGE } }, { status: 500 });
  }
  const { data: rows, error: rowsError } = await supabase.rpc('family_menu_planned_meals', { p_start_date: startDate, p_end_date: endDate });
  if (rowsError) {
    log.error('家族の献立: 献立の取得に失敗', rowsError, { familyId });
    return NextResponse.json({ error: { code: MembershipErrorCode.RPC_FAILED, message: FAILED_MESSAGE } }, { status: 500 });
  }
  // 献立は jsonb の配列 1 つ (生成型は Json)。形が違えば 500 にして記録する (黙って空にすると全員が「この日はありません」になる)
  const parsedRows = FamilyMenuRpcRowsSchema.safeParse(rows);
  if (!parsedRows.success) {
    log.error('家族の献立: 献立の形が想定と違う', new Error(parsedRows.error.message), { familyId });
    return NextResponse.json({ error: { code: MembershipErrorCode.RPC_FAILED, message: FAILED_MESSAGE } }, { status: 500 });
  }
  const data = groupFamilyMenuRows(members ?? [], parsedRows.data, { family_id: familyId, start_date: startDate, end_date: endDate });
  return NextResponse.json({ data }, { status: 200 });
}
