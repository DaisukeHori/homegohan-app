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
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { isUuid, normalizeUuid } from '@/lib/http-params';
import { ORG_PLAN_VALUES } from '@/lib/org-plans';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'api/admin/organizations/[id] PATCH';

/** 運営の組織のプランの変更の監査の名前 (operator/07 §4.1) */
const ORG_PLAN_CHANGE_AUDIT_ACTION = 'admin.organization.plan_change';

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
  const nullCharacterRejection = await rejectNullCharacterBody(request);
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
        { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } },
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
    console.error(`[${ROUTE_NAME}] read error:`, readError.message);
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

  const { data: org, error: updateError } = await supabaseAdmin
    .from('organizations')
    .update({ plan, updated_at: new Date().toISOString() })
    .eq('id', organizationId)
    .select(ORG_RESPONSE_COLUMNS)
    .single();

  if (updateError || !org) {
    console.error(`[${ROUTE_NAME}] update error:`, updateError?.message);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '組織のプランを変更できませんでした' } },
      { status: 500 },
    );
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
