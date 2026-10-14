/**
 * GET /api/admin/finance/nps
 * NPS / CSAT 集計
 * operator/01-data-model.md §3.14
 * 権限: admin, super_admin (財務ロール finance は #1311 で外した)
 *
 * #1311: NPS / CSAT は財務の業務には要らない (オーナー判断)。かつては finance もこの API を通せたが、
 * 行を読む RLS は finance を許していない (nps_surveys の nps_select_admin は admin / super_admin / support だけ、
 * csat_feedbacks の csat_access は本人の行 + 同じ 3 ロール)。そのため finance には NPS は 0 件、CSAT は本人の分だけが返り、
 * 運営全体の数字のように見える誤った集計になっていた。finance は入口で 403 にする。
 * RLS は変えない (support / admin / super_admin のまま)。この API を通せるのは、そのうち admin / super_admin だけ。
 *
 * #1217: 件数・合計・分布は DB の関数 (get_nps_summary / get_csat_summary) が数え、
 * 直近の一覧だけを order + limit で取る。以前は nps_surveys / csat_feedbacks の該当行を全部読み込んで
 * JavaScript で数えていたため、行が増えるほど遅くなり、API の最大行数 (Supabase の既定は 1000 行) を超えると
 * 集計が黙って切り詰められた。関数は SECURITY INVOKER なので、行レベルセキュリティ (RLS) は
 * これまでどおりログインユーザーの権限で効く (誰が何を見られるかは変えていない)。
 * レスポンスの形と、平均・NPS スコア・回答率の丸めは以前と同じ (src/lib/admin/nps-summary.ts)。
 *
 * #1433: 期間 (from / to。画面の日付の入力。どちらの日も含む) は JST の暦日で絞る。sent_at / created_at は timestamptz なので、
 * 日付の文字列をそのまま渡すと DB は UTC の 0 時 (= JST 9 時) と読み、開始日の JST 0:00〜8:59 の行が落ち、
 * 終了日は JST 9:00 で打ち切られてその日のほとんどが落ちていた。
 *   - 直近の一覧 (自分で組み立てる問い合わせ): 開始日の JST 0 時以上 (.gte)、終了日の翌日の JST 0 時未満 (.lt)
 *   - 集計 (DB の関数。条件は両端を含む `>= p_from AND <= p_to`): p_from に開始日の JST 0 時、
 *     p_to に終了日の最後の瞬間 (翌日の JST 0 時の 1 マイクロ秒前) を渡す。timestamptz の精度は 1 マイクロ秒なので、
 *     一覧の .lt と同じ行を選ぶ (関数は変えない。migration は無い)
 * 存在しない日付・時刻つきの値は 400 (DB に問い合わせない)。空文字は今までどおり「指定なし」。
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { NpsQuerySchema } from '@/lib/admin/finance-schemas';
import { jstDayEndInclusiveTimestamp, jstOptionalDayRangeTimestamps } from '@/lib/jst-day-ranges';
import {
  CsatSummaryRowSchema,
  NpsSummaryRowSchema,
  RECENT_LIMIT,
  buildCsatSummary,
  buildNpsSummary,
  firstRpcRow,
  type CsatRecentRow,
  type NpsRecentRow,
} from '@/lib/admin/nps-summary';
import { createLogger, generateRequestId } from '@/lib/db-logger';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const logger = createLogger('GET /api/admin/finance/nps', generateRequestId());
  try {
    // #1311: 財務ロール (finance) は含めない。画面 (admin/finance/page.tsx) と書き出し (finance/exports の nps) も同じ扱い
    await requireRole(['admin', 'super_admin']);
    const supabase = await createClient();

    const { searchParams } = new URL(request.url);
    const parsed = NpsQuerySchema.safeParse({
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
      plan_key: searchParams.get('plan_key') ?? undefined,
    });
    // 存在しない日付・時刻つきの値などは 400。JST 0 時の時刻に直す前に入口で弾く (DB には問い合わせない) (#1433)
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }
    const query = parsed.data;

    // 空文字は「指定なし」として扱う (以前の `if (query.from)` と同じ。from / to はスキーマが undefined にする)。
    // DB の関数には NULL (= 絞らない) で渡す
    const from = query.from ?? null;
    const to = query.to ?? null;
    const planKey = query.plan_key || null;

    // 期間を JST の暦日の時刻にする (#1433): 開始日の JST 0 時 (以上)・終了日の翌日の JST 0 時 (未満)
    const { fromTimestamp, toTimestampExclusive } = jstOptionalDayRangeTimestamps(query.from, query.to);
    // 集計の関数は両端を含む (`<= p_to`) ので、終了日の最後の瞬間 (翌日の JST 0 時の 1 マイクロ秒前) を渡す
    const rpcFrom = fromTimestamp ?? null;
    const rpcTo = query.to === undefined ? null : jstDayEndInclusiveTimestamp(query.to);

    // 直近の一覧。期間・プランの絞り込みは集計 (関数) と同じ条件にし、新しい順に RECENT_LIMIT 件だけ取る
    // NPS: 期間は送信日 (sent_at)。回答済み (responded_at あり) だけ。並びは回答日の新しい順
    let npsRecent = supabase
      .from('nps_surveys')
      .select('id, score, comment, plan_key, responded_at')
      .not('responded_at', 'is', null);
    if (fromTimestamp) npsRecent = npsRecent.gte('sent_at', fromTimestamp);
    if (toTimestampExclusive) npsRecent = npsRecent.lt('sent_at', toTimestampExclusive);
    if (planKey) npsRecent = npsRecent.eq('plan_key', planKey);

    // CSAT: 期間は作成日 (created_at)。プランの列は無い
    let csatRecent = supabase
      .from('csat_feedbacks')
      .select('id, score, comment, ticket_id, created_at');
    if (fromTimestamp) csatRecent = csatRecent.gte('created_at', fromTimestamp);
    if (toTimestampExclusive) csatRecent = csatRecent.lt('created_at', toTimestampExclusive);

    // 4 つの問い合わせは互いに独立なので並列に流す
    const [npsSummaryRes, npsRecentRes, csatSummaryRes, csatRecentRes] = await Promise.all([
      supabase.rpc('get_nps_summary', { p_from: rpcFrom, p_to: rpcTo, p_plan_key: planKey }),
      npsRecent.order('responded_at', { ascending: false }).limit(RECENT_LIMIT),
      supabase.rpc('get_csat_summary', { p_from: rpcFrom, p_to: rpcTo }),
      csatRecent.order('created_at', { ascending: false }).limit(RECENT_LIMIT),
    ]);

    // 1 つでも失敗したまま続けると、取れなかった数字を 0 として画面に出してしまう (誤った集計を返す)。
    // 握りつぶさずに記録し、500 を返す
    const failedQueries = [
      { query: 'get_nps_summary', error: npsSummaryRes.error },
      { query: 'nps_surveys (recent)', error: npsRecentRes.error },
      { query: 'get_csat_summary', error: csatSummaryRes.error },
      { query: 'csat_feedbacks (recent)', error: csatRecentRes.error },
    ].filter((q) => q.error);
    if (failedQueries.length > 0) {
      logger.error('NPS / CSAT の集計の取得に失敗', failedQueries[0].error, {
        failed_queries: failedQueries.map((q) => q.query),
        from,
        to,
        plan_key: planKey,
      });
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
        { status: 500 },
      );
    }

    // 関数の戻り値の形が想定と違うときは例外になる (下の catch で記録して 500)
    const npsRow = NpsSummaryRowSchema.parse(firstRpcRow(npsSummaryRes.data));
    const csatRow = CsatSummaryRowSchema.parse(firstRpcRow(csatSummaryRes.data));

    return NextResponse.json({
      data: {
        nps: buildNpsSummary(npsRow, (npsRecentRes.data ?? []) as NpsRecentRow[]),
        csat: buildCsatSummary(csatRow, (csatRecentRes.data ?? []) as CsatRecentRow[]),
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: err.message } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: err.message } },
        { status: 403 },
      );
    }
    logger.error('unexpected error', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
