import { NextResponse } from 'next/server';
import { jstToday } from '@/lib/jst-day-ranges';
import { jstDayStartTimestamp } from '@/lib/date-utils';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { getSupabaseAdmin } from '@/lib/supabase/server';

/**
 * 500 の本文は汎用メッセージだけにする (#1172: Supabase / Postgres の生のエラー文を返さない)。
 * 詳細は db-logger (app_logs) にだけ残す。
 */
function internalError(err: unknown, metadata?: Record<string, unknown>) {
  createLogger('GET /api/support/stats', generateRequestId()).error('サポート統計の取得に失敗しました', err, metadata);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** 「自分が対応した件数（今週）」の日数 */
const RECENT_RESOLVED_DAYS = 7;
/** 1 日のミリ秒 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// サポート統計取得
// 権限: support / admin / super_admin (共通の requireRole()、#1161)
export async function GET(_request: Request) {
  try {
    const actor = await requireRole(['support', 'admin', 'super_admin']);

    // 認可を通したあとだけ service_role で読む (認可の前に使うと権限昇格になる)。
    // user_profiles は RLS で本人の行しか見えないため、問い合わせ者のニックネームは service_role でないと引けない。
    // admin_audit_logs も、SELECT できるのは admin / super_admin だけで、support は自分の行も読めない。
    const supabase = getSupabaseAdmin();

    // 「今日解決した件数」は JST の今日の 0 時から数える (#1433)。resolved_at は timestamptz なので、
    // 日付の文字列 (UTC の暦日) をそのまま渡すと UTC の 0 時 (= JST 9 時) からになり、JST 0:00〜8:59 は前日の分を数えていた
    const todayStart = jstDayStartTimestamp(jstToday());
    // 「今週」= 今から 7 日 (7 × 24 時間) 前まで。ローカル時刻の setDate を使わず、実行環境のタイムゾーンに左右されないようにする
    const sevenDaysAgo = new Date(Date.now() - RECENT_RESOLVED_DAYS * MS_PER_DAY);

    const [
      pendingRes,
      inProgressRes,
      resolvedTodayRes,
      totalRes,
      pendingTypesRes,
      recentRes,
      myResolvedRes,
    ] = await Promise.all([
      // 問い合わせ統計
      supabase
        .from('inquiries')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending'),
      supabase
        .from('inquiries')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'in_progress'),
      supabase
        .from('inquiries')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'resolved')
        .gte('resolved_at', todayStart),
      supabase
        .from('inquiries')
        .select('*', { count: 'exact', head: true }),
      // 問い合わせ種別統計
      supabase
        .from('inquiries')
        .select('inquiry_type')
        .eq('status', 'pending'),
      // 最近の問い合わせ。inquiries.user_id の外部キーは auth.users 宛で user_profiles とは繋がっていないため、
      // user_profiles(nickname) の埋め込みは PostgREST が解決できない。ニックネームは下で別に引く
      supabase
        .from('inquiries')
        .select('id, inquiry_type, subject, status, created_at, user_id')
        .order('created_at', { ascending: false })
        .limit(10),
      // 自分が対応した件数（今週）。admin_audit_logs に admin_id 列は無く、操作した人は actor_id
      supabase
        .from('admin_audit_logs')
        .select('*', { count: 'exact', head: true })
        .eq('actor_id', actor.id)
        .eq('action_type', 'resolve_inquiry')
        .gte('created_at', sevenDaysAgo.toISOString()),
    ]);

    // 取得に失敗したまま続けると、0 件や空の一覧として黙って返してしまう (以前はそうなっていた)。
    // 握りつぶさず、失敗したクエリ名をログに残して 500 にする
    const failures = [
      { query: 'inquiries (pending count)', error: pendingRes.error },
      { query: 'inquiries (in_progress count)', error: inProgressRes.error },
      { query: 'inquiries (resolved today count)', error: resolvedTodayRes.error },
      { query: 'inquiries (total count)', error: totalRes.error },
      { query: 'inquiries (pending types)', error: pendingTypesRes.error },
      { query: 'inquiries (recent)', error: recentRes.error },
      { query: 'admin_audit_logs (my resolved count)', error: myResolvedRes.error },
    ].filter((f) => f.error);
    if (failures.length > 0) {
      return internalError(new Error(failures[0].error!.message), {
        failed_queries: failures.map((f) => f.query),
        error_code: failures[0].error!.code,
      });
    }

    const typeCount: Record<string, number> = {};
    (pendingTypesRes.data || []).forEach((i: any) => {
      typeCount[i.inquiry_type] = (typeCount[i.inquiry_type] || 0) + 1;
    });

    // 最近の問い合わせの投稿者名 (ログイン外の問い合わせは user_id が無く Guest)
    const recentInquiries = recentRes.data || [];
    const userIds = Array.from(
      new Set(recentInquiries.map((i: any) => i.user_id).filter((id: unknown): id is string => !!id)),
    );
    const nicknameById = new Map<string, string | null>();
    if (userIds.length > 0) {
      const { data: profiles, error: profilesError } = await supabase
        .from('user_profiles')
        .select('id, nickname')
        .in('id', userIds);
      if (profilesError) {
        return internalError(new Error(profilesError.message), {
          failed_queries: ['user_profiles (inquiry authors)'],
          error_code: profilesError.code,
        });
      }
      (profiles || []).forEach((p: any) => nicknameById.set(p.id, p.nickname));
    }

    return NextResponse.json({
      overview: {
        pendingInquiries: pendingRes.count || 0,
        inProgressInquiries: inProgressRes.count || 0,
        resolvedToday: resolvedTodayRes.count || 0,
        totalInquiries: totalRes.count || 0,
        myResolvedThisWeek: myResolvedRes.count || 0,
      },
      inquiriesByType: typeCount,
      recentInquiries: recentInquiries.map((i: any) => ({
        id: i.id,
        inquiryType: i.inquiry_type,
        subject: i.subject,
        status: i.status,
        createdAt: i.created_at,
        userName: (i.user_id && nicknameById.get(i.user_id)) || 'Guest',
      })),
    });

  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return internalError(error);
  }
}
