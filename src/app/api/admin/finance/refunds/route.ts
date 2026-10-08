/**
 * POST /api/admin/finance/refunds — 返金の記録 (監査ログ) と Stripe ダッシュボードへの誘導
 * 権限: admin, super_admin, finance
 *
 * このアプリは返金を実行しない。返金は担当者が Stripe ダッシュボードで行う。
 * その前に、この API で「誰が・いつ・誰に・いくら・なぜ」を admin_audit_logs
 * (action_type = 'admin.refund.issue') に記録する。
 * 記録できたときだけ Stripe ダッシュボードのリンクを返す。記録できなかったときは 500 を返し、
 * リンクは返さない (監査ログの残らない返金を作らないため)。
 *
 * 記録には recordAdminAudit (src/lib/admin/audit.ts) を使う。閲覧ログと違い、返金は
 * 「記録できないなら実行しない」操作なので、戻り値の ok を見て止める。supabase-js は DB の
 * エラーを例外にせず { error } で返すため、try/catch だけでは失敗を握りつぶしてしまう。
 * 失敗の内容は recordAdminAudit が db-logger (app_logs) に残す。
 *
 * 設計: docs/design/operator/07-audit-monitoring.md §4.1 (admin.refund.issue) / 03-ui-spec.md §11。
 * 2 名承認 (finance.refund.approve) と charge.refunded Webhook との突き合わせは #1125 側で後続。
 * Issue: #1185
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { recordAdminAudit } from '@/lib/admin/audit';
import { RefundRequestSchema, type RefundRequest } from '@/lib/admin/finance-schemas';
import { stripeInvoiceUrl, stripePaymentUrl } from '@/lib/stripe/links';

export const dynamic = 'force-dynamic';

/** 記録できなかったとき、担当者に返すメッセージ。画面にそのまま出る */
const AUDIT_FAILED_MESSAGE = '監査ログに記録できませんでした。返金はまだ行わず、もう一度お試しください';

/** 返金を行う Stripe ダッシュボードのページ (決済ならその決済、請求書ならその請求書) */
function stripeDashboardUrlFor(refund: RefundRequest): string {
  if (refund.stripe_charge_id) return stripePaymentUrl(refund.stripe_charge_id);
  if (refund.stripe_invoice_id) return stripeInvoiceUrl(refund.stripe_invoice_id);
  // スキーマが「どちらか一方」を保証しているので、ここには来ない
  throw new Error('stripe_charge_id と stripe_invoice_id のどちらもありません');
}

export async function POST(request: NextRequest) {
  const logger = createLogger('POST /api/admin/finance/refunds', generateRequestId());

  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin', 'finance']);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } },
        { status: 403 },
      );
    }
    logger.error('権限の確認中に想定外のエラーが発生しました', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parsed = RefundRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parsed.error.flatten() } },
      { status: 400 },
    );
  }
  const refund = parsed.data;

  try {
    // リンクは記録の前に作っておく (作れずに落ちるなら、記録だけが残る状態にしないため)
    const stripeDashboardUrl = stripeDashboardUrlFor(refund);

    // セッションの client (RLS 有効) で記録する。finance には audit_logs_insert_admins だけが効き、
    // actor_id = auth.uid() とロールを DB 側でも強制するので、他人名義では記録できない。
    // (admin / super_admin / support には actor_id を検査しない古いポリシーも効く。
    //  そのため actor は、必ず requireRole が返した本人の id を渡す)
    // finance は admin_audit_logs を SELECT できないため、読み戻す実装にしてはいけない。
    const supabase = await createClient();
    const audit = await recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: 'admin.refund.issue',
      targetId: refund.user_id,
      targetType: 'user',
      severity: 'warn',
      details: {
        amount: refund.amount,
        currency: refund.currency,
        reason: refund.reason,
        stripe_charge_id: refund.stripe_charge_id ?? null,
        stripe_invoice_id: refund.stripe_invoice_id ?? null,
      },
      request,
      routeName: 'api/admin/finance/refunds POST',
    });

    // 記録できなかったので、Stripe のリンクは返さない (失敗の内容は recordAdminAudit が記録済み)
    if (!audit.ok) {
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: AUDIT_FAILED_MESSAGE } },
        { status: 500 },
      );
    }

    return NextResponse.json({ data: { stripe_dashboard_url: stripeDashboardUrl } });
  } catch (err) {
    logger.withUser(actor.id).error('返金の記録中に想定外のエラーが発生しました', err, {
      target_user_id: refund.user_id,
    });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: AUDIT_FAILED_MESSAGE } },
      { status: 500 },
    );
  }
}
