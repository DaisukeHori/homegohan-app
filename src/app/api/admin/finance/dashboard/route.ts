/**
 * GET /api/admin/finance/dashboard
 * 売上ダッシュボード KPI
 * operator/02-api-spec.md §9
 * 権限: admin, super_admin, finance
 */
import { NextResponse } from 'next/server';
import { jstMonthBoundaries } from '@/lib/jst-day-ranges';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED, authFailureNested } from '@/lib/api/error-responses';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireRole(['admin', 'super_admin', 'finance']);
    const supabase = await createClient();

    // 最新スナップショット (今月と先月) を revenue_snapshots から取得。
    // revenue_snapshots.date は JST の暦日なので、今月・先月も JST の暦で決める (#1433)。
    // 以前はローカル時刻の年・月で作った 0 時を toISOString (UTC) で日付に戻していたので、実行環境のタイムゾーンで結果が変わった
    // (Vercel (UTC) では月初の JST 0:00〜8:59 に今月・先月が 1 か月前にずれ、JST の開発機では毎日 1 日前にずれた)
    const { thisMonthStart, lastMonthStart, lastMonthEnd } = jstMonthBoundaries();

    // 読み込みはどれも、行が無いときだけ「無い」(0・フォールバック) にし、読めなかった (DB の失敗) ときは 500 にする (#1917 の続き。
    // 以前は error を受けずに捨て、DB の失敗でも売上・利用者数が 0 のように見えていた)。1 行を読むところは .limit(1) の
    // .maybeSingle() (行が無いのは失敗ではない。.single() は 0 行を失敗にする)

    // 今月の最新スナップショット
    const { data: currentSnap, error: currentSnapError } = await supabase
      .from('revenue_snapshots')
      .select('*')
      .gte('date', thisMonthStart)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (currentSnapError) {
      return internalError('GET /api/admin/finance/dashboard', currentSnapError, { userId: user.id, table: 'revenue_snapshots' }, { shape: 'nested' });
    }

    // 先月の最新スナップショット (比較用)
    const { data: lastMonthSnap, error: lastMonthSnapError } = await supabase
      .from('revenue_snapshots')
      .select('*')
      .gte('date', lastMonthStart)
      .lte('date', lastMonthEnd)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastMonthSnapError) {
      return internalError('GET /api/admin/finance/dashboard', lastMonthSnapError, { userId: user.id, table: 'revenue_snapshots' }, { shape: 'nested' });
    }

    // スナップショットがなければ personal_subscriptions から直接集計
    let currentMrrJpy = currentSnap?.total_mrr_jpy ?? 0;
    let currentArrJpy = currentSnap?.total_arr_jpy ?? 0;
    let personalActiveUsers = currentSnap?.personal_active_users ?? 0;
    let familyActiveGroups = currentSnap?.family_active_groups ?? 0;
    let orgActiveOrgs = currentSnap?.org_active_orgs ?? 0;
    let mau = 0;

    if (!currentSnap) {
      // フォールバック: personal_subscriptions から直接集計
      const { data: activeSubs, error: activeSubsError } = await supabase
        .from('personal_subscriptions')
        .select('plan_key, subscription_plans(monthly_price_jpy)')
        .in('status', ['active', 'trialing']);
      if (activeSubsError) {
        return internalError('GET /api/admin/finance/dashboard', activeSubsError, { userId: user.id, table: 'personal_subscriptions' }, { shape: 'nested' });
      }

      if (activeSubs) {
        personalActiveUsers = activeSubs.length;
        // @ts-ignore: join type
        const monthlyTotal = activeSubs.reduce((sum, s) => sum + (s.subscription_plans?.monthly_price_jpy ?? 0), 0);
        currentMrrJpy = monthlyTotal;
        currentArrJpy = monthlyTotal * 12;
      }
    }

    // MAU は daily_active_users から
    const { data: dauRecord, error: dauRecordError } = await supabase
      .from('daily_active_users')
      .select('mau')
      .eq('plan_type', 'all')
      .eq('plan_key', '')
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (dauRecordError) {
      return internalError('GET /api/admin/finance/dashboard', dauRecordError, { userId: user.id, table: 'daily_active_users' }, { shape: 'nested' });
    }
    mau = dauRecord?.mau ?? 0;

    // チャーンレート計算
    // churn_rate = (先月のキャンセル数 / 先月初頭のアクティブ数) * 100
    const lastMonthMrr = lastMonthSnap?.total_mrr_jpy ?? 1;
    const churnedMrrJpy = lastMonthSnap?.cancellations
      ? Math.round((lastMonthSnap.cancellations / Math.max(1, lastMonthSnap.personal_active_users)) * lastMonthMrr)
      : 0;
    const churnRate = lastMonthMrr > 0
      ? Math.round((churnedMrrJpy / lastMonthMrr) * 100 * 10) / 10
      : 0;

    // LTV = MRR / churn_rate (churn が 0 の場合は N/A として 0 返却)
    const ltvJpy = churnRate > 0
      ? Math.round(currentMrrJpy / (churnRate / 100) / Math.max(1, personalActiveUsers))
      : 0;

    // 新規/拡張/縮小/解約 MRR (スナップショットの upgrade/downgrade/cancellation カウントから概算)
    const newMrrJpy = currentSnap
      ? Math.round((currentSnap.new_signups ?? 0) * (currentMrrJpy / Math.max(1, personalActiveUsers)))
      : 0;
    const expansionMrrJpy = currentSnap
      ? Math.round((currentSnap.upgrade_count ?? 0) * (currentMrrJpy / Math.max(1, personalActiveUsers)) * 0.3)
      : 0;
    const contractionMrrJpy = currentSnap
      ? Math.round((currentSnap.downgrade_count ?? 0) * (currentMrrJpy / Math.max(1, personalActiveUsers)) * 0.2)
      : 0;

    void user; // 認証確認済み

    return NextResponse.json({
      data: {
        current_mrr_jpy: currentMrrJpy,
        current_arr_jpy: currentArrJpy,
        churn_rate: churnRate,
        ltv_jpy: ltvJpy,
        new_mrr_jpy: newMrrJpy,
        expansion_mrr_jpy: expansionMrrJpy,
        contraction_mrr_jpy: contractionMrrJpy,
        churned_mrr_jpy: churnedMrrJpy,
        personal_active_users: personalActiveUsers,
        family_active_groups: familyActiveGroups,
        org_active_orgs: orgActiveOrgs,
        mau,
      },
    });
  } catch (err) {
    const authFailure = authFailureNested(err, { code: AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('GET /api/admin/finance/dashboard', err, { log_context: '[finance/dashboard] unexpected error' }, { shape: 'nested' });
  }
}
