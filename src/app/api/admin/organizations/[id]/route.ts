/**
 * PATCH /api/admin/organizations/[id] — 組織のプラン (organizations.plan) の変更 (運営)
 * 権限: admin, super_admin (組織の作成 POST /api/admin/organizations と同じ)
 *
 * 組織のプランの段階は運営だけが変える (#1912。オーナーの選択 (2026-10-22・選択式)「運営だけが変える (推奨)」:
 * 「組織の管理者の設定画面では段階を表示だけにし、変更は運営の画面からだけにする (組織の契約は運営が決める)」)。
 * 組織の管理者の経路 (PUT /api/org/settings) は plan を受け取らず、DB のトリガー guard_organizations_plan_value が
 * ログインした利用者 (authenticated) と anon が plan を変えること自体を拒む (20261022170000_org_plan_operator_only.sql)。
 * そのため、ここでは service_role (getSupabaseAdmin) で書く (運営も JWT はログインした利用者なので、利用者の client では止まる)。
 *
 * 本文: { plan } (src/lib/org-plans.ts の ORG_PLAN_VALUES のどれか)。ほかのキーは受け取らない (変えるのはプランだけ)。
 * 監査: admin.organization.plan_change (docs/design/operator/07-audit-monitoring.md §4.1)。details は変える前と後のプラン。
 * 今と同じプランを送ったときは書かず、記録もしない (200 で今の行を返す)。
 *
 * 同時の変更 (#1912 の整合の候補): 更新は「直前に読んだ plan のままなら書く」条件つきにする (読んでから書くまでに
 * 別の運営が変えていたら 0 行)。0 行なら読み直し、今の値が送られたプランと同じなら書かず記録もしない (200 で今の行)、
 * 違えば 409 CONFLICT_STALE_DATA (cross/04 §4.2)。これで監査の from は、書いた時点の実際の直前の値と必ず一致する。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { operatorForbiddenMessageOf } from '@/lib/api/error-responses';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { recordAdminAudit } from '@/lib/admin/audit';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { isUuid, normalizeUuid } from '@/lib/http-params';
import { ORG_PLAN_VALUES } from '@/lib/org-plans';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'api/admin/organizations/[id] PATCH';

/** 運営の組織のプランの変更の監査の名前 (operator/07 §4.1) */
const ORG_PLAN_CHANGE_AUDIT_ACTION = 'admin.organization.plan_change';

/** 読んでから書くまでに別の運営がプランを変えていた (条件つきの更新が 0 行で、今の値が送られたプランと違う) */
const STALE_PLAN_RESPONSE = {
  error: { code: 'CONFLICT_STALE_DATA', message: '別の運営が先にこの組織のプランを変えました。一覧を読み込み直して、もう一度確認してください' },
} as const;

/** 返す organizations の列 (一覧の GET と同じ) */
const ORG_RESPONSE_COLUMNS = 'id, name, plan, created_at, updated_at';

const OrgPlanChangeSchema = z
  .object({
    plan: z.enum(ORG_PLAN_VALUES),
  })
  .strict();

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, props: RouteContext) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin']);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } },
        { status: 403 },
      );
    }
    throw err;
  }

  const { id: rawId } = await props.params;
  if (!isUuid(rawId)) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: '組織の ID が不正です' } },
      { status: 400 },
    );
  }
  const organizationId = normalizeUuid(rawId);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parseResult = OrgPlanChangeSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }
  const { plan } = parseResult.data;

  const supabaseAdmin = getSupabaseAdmin();

  const { data: before, error: readError } = await supabaseAdmin
    .from('organizations')
    .select(ORG_RESPONSE_COLUMNS)
    .eq('id', organizationId)
    .maybeSingle();

  if (readError) {
    // 生のエラー文は返さず、db-logger (app_logs) にだけ残す (#1172)
    createLogger(ROUTE_NAME, generateRequestId()).error('組織の読み出しに失敗しました', readError);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '組織のプランを変更できませんでした' } },
      { status: 500 },
    );
  }
  if (!before) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '組織が見つかりません' } },
      { status: 404 },
    );
  }

  // 今と同じプラン: 書かない・記録しない
  if (before.plan === plan) {
    return NextResponse.json({ organization: before });
  }

  // 直前に読んだ plan のままのときだけ書く (読んでから書くまでに別の運営が変えていたら 0 行)。
  // plan の列は NULL を許すので、読んだ値が NULL なら .eq ではなく .is で比べる (PostgREST の eq.null は NULL に一致しない)
  const updateQuery = supabaseAdmin
    .from('organizations')
    .update({ plan, updated_at: new Date().toISOString() })
    .eq('id', organizationId);
  const { data: org, error: updateError } = await (before.plan === null
    ? updateQuery.is('plan', null)
    : updateQuery.eq('plan', before.plan)
  )
    .select(ORG_RESPONSE_COLUMNS)
    .maybeSingle();

  if (updateError) {
    createLogger(ROUTE_NAME, generateRequestId()).error('組織のプランの更新に失敗しました', updateError);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '組織のプランを変更できませんでした' } },
      { status: 500 },
    );
  }

  if (!org) {
    // 0 行: 読んでから書くまでに、別の運営がプランを変えた (または組織が消えた)。読み直して決める
    const { data: current, error: rereadError } = await supabaseAdmin
      .from('organizations')
      .select(ORG_RESPONSE_COLUMNS)
      .eq('id', organizationId)
      .maybeSingle();
    if (rereadError) {
      createLogger(ROUTE_NAME, generateRequestId()).error('組織の読み直しに失敗しました', rereadError);
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: '組織のプランを変更できませんでした' } },
        { status: 500 },
      );
    }
    if (!current) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: '組織が見つかりません' } },
        { status: 404 },
      );
    }
    // 別の運営が同じプランへ先に変えていた: 書かず、記録もしない (その変更は先の運営の監査に残っている)
    if (current.plan === plan) {
      return NextResponse.json({ organization: current });
    }
    return NextResponse.json(STALE_PLAN_RESPONSE, { status: 409 });
  }

  // 監査ログ (運営本人の client で書く。admin_audit_logs の INSERT のポリシーは actor_id = auth.uid())
  const supabase = await createClient();
  await recordAdminAudit({
    supabase,
    actorId: actor.id,
    actionType: ORG_PLAN_CHANGE_AUDIT_ACTION,
    targetId: organizationId,
    targetType: 'organization',
    details: { from: before.plan, to: plan },
    severity: 'warn',
    request,
    routeName: ROUTE_NAME,
  });

  return NextResponse.json({ organization: org });
}
