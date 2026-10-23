/**
 * GET    /api/super-admin/users/{id}/manual-plan — 利用者の live な契約・付与できるプラン・付与の履歴 (運営の画面の節が読む)
 * POST   /api/super-admin/users/{id}/manual-plan — 手動付与 (billing_grant_manual_subscription)
 * DELETE /api/super-admin/users/{id}/manual-plan — 付与の取り消し (billing_revoke_manual_subscription)
 * 設計: docs/design/billing/02-manual-plan-grant.md §8.5・§9
 *
 * 権限: super_admin だけ (requireRole(['super_admin'])。既定の assurance = AAL2 の門。cross/12 §13.1)。
 * 自分自身 (POST / DELETE) は 403 OP_SELF_MODIFY: パスの id の形の判定の直後、本文 (JSON・Zod) を読む前に route が断る
 * (cross/12 の super_admin の reset と同じ順。本文が不正でも 403)。service の grantManualPlan / revokeManualPlan も同じ判定を持つ (二重の守り)。
 * GET は読むだけなので自分の判定をしない。判定の順の正本は設計書 §9.0。
 * 本文の形は運営 API (nested): 失敗は { error: { code, message } }・成功は { data }。
 * DB は requireRole 通過後に service_role (getSupabaseAdmin) の repository で RPC を呼ぶ (#1028 の型)。
 * 監査は recordAdminAudit を user-scoped の client で (admin.billing.manual_grant / manual_revoke。severity warn。request つき。
 * tests/admin-mutation-audit-coverage-1571.test.ts の EXPECTED に POST / DELETE を audited で載せる)。GET は個人情報を返さない
 * (プランの状態と運営の操作の履歴だけ) ので閲覧の監査は書かない (#1200 の対象外。ユーザー詳細の GET が admin.user.view を書く)。
 * 応答の本文に例外の文面を入れない (tests/api-raw-error-message-scan.test.ts): ManualGrantError も code から固定の文を引く。
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { internalError } from '@/lib/api/errors';
import { isUuid, normalizeUuid } from '@/lib/http-params';
import { jstToday } from '@/lib/jst-day-ranges';
import { invalidInputResponse, invalidJsonBodyResponse, readJsonBody } from '@/lib/super-admin/validation-errors';
import {
  MANUAL_GRANT_AUDIT_ACTIONS,
  MANUAL_GRANT_AUDIT_SEVERITY,
  MANUAL_GRANT_AUDIT_TARGET_TYPE,
  MANUAL_GRANT_ERROR_HTTP_STATUS,
  MANUAL_GRANT_ERROR_MESSAGES,
  ManualGrantError,
  ManualPlanRevokeBodySchema,
  manualPlanGrantBodySchema,
} from '@/lib/billing/manual-grant';
import { createManualGrantRepository } from '@/lib/billing/manual-grant-repository';
import { getManualPlanView, grantManualPlan, revokeManualPlan } from '@/lib/billing/manual-grant-service';

export const dynamic = 'force-dynamic';

const ROUTE_GET = 'GET /api/super-admin/users/[id]/manual-plan';
const ROUTE_POST = 'POST /api/super-admin/users/[id]/manual-plan';
const ROUTE_DELETE = 'DELETE /api/super-admin/users/[id]/manual-plan';
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
/**
 * 運営の画面だけが読む応答 (共有キャッシュに残さない)。route が自分で組み立てる応答 (errorJson と 200) にだけ付ける。
 * 共通のヘルパーの応答 (rejectNullCharacterBody の 400・invalidInputResponse / invalidJsonBodyResponse の 400・internalError の 500) は、
 * ヘルパーが作ったまま返す (本文は固定の文と Zod の issue だけ。NULL 文字の 2 行は null-character-routes.test.ts が逐語を求めるので包めない。§9 の冒頭)
 */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

type Params = { params: Promise<{ id: string }> };

function errorJson(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers: NO_STORE });
}

/** requireRole の失敗 → 401 / 403 (既存の super-admin の route と同じ形)。それ以外は投げ直す */
function authFailure(err: unknown): NextResponse {
  if (err instanceof AuthError) return errorJson('AUTH_UNAUTHENTICATED', '認証が必要です', HTTP_UNAUTHORIZED);
  if (err instanceof ForbiddenError) return errorJson('OP_PERMISSION_DENIED', '権限がありません', HTTP_FORBIDDEN);
  throw err;
}

/** ManualGrantError → §12.1 の HTTP と固定の文 */
function manualGrantFailure(err: ManualGrantError): NextResponse {
  return errorJson(err.code, MANUAL_GRANT_ERROR_MESSAGES[err.code], MANUAL_GRANT_ERROR_HTTP_STATUS[err.code]);
}

/** パスの id (UUID の形なら小文字にそろえる。形が違えば 404。#1707・#1478) */
function targetIdOf(rawId: string): string | null {
  return isUuid(rawId) ? normalizeUuid(rawId) : null;
}

/** 自分自身への付与・取り消し → 403 OP_SELF_MODIFY (§9.0 の 4。本文の検証・service・DB・監査より前) */
function selfModifyFailure(): NextResponse {
  return errorJson('OP_SELF_MODIFY', MANUAL_GRANT_ERROR_MESSAGES.OP_SELF_MODIFY, MANUAL_GRANT_ERROR_HTTP_STATUS.OP_SELF_MODIFY);
}

export async function GET(_request: Request, props: Params): Promise<NextResponse> {
  let actor;
  try {
    actor = await requireRole(['super_admin']);
  } catch (err) {
    return authFailure(err);
  }
  const { id: rawId } = await props.params;
  const id = targetIdOf(rawId);
  if (id === null) return errorJson('NOT_FOUND', MANUAL_GRANT_ERROR_MESSAGES.NOT_FOUND, MANUAL_GRANT_ERROR_HTTP_STATUS.NOT_FOUND);
  try {
    const view = await getManualPlanView({ repository: createManualGrantRepository() }, id);
    return NextResponse.json({ data: view }, { status: HTTP_OK, headers: NO_STORE });
  } catch (err) {
    if (err instanceof ManualGrantError) return manualGrantFailure(err);
    return internalError(ROUTE_GET, err, { userId: actor.id, targetId: id }, { shape: 'nested' });
  }
}

export async function POST(request: Request, props: Params): Promise<NextResponse> {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  let actor;
  try {
    actor = await requireRole(['super_admin']);
  } catch (err) {
    return authFailure(err);
  }
  const { id: rawId } = await props.params;
  const id = targetIdOf(rawId);
  if (id === null) return errorJson('NOT_FOUND', MANUAL_GRANT_ERROR_MESSAGES.NOT_FOUND, MANUAL_GRANT_ERROR_HTTP_STATUS.NOT_FOUND);
  // 自分自身は本文を読む前に断る (§9.0 の 4。大文字の自分の UUID も targetIdOf が小文字にそろえているので同じ値になる #1707)
  const actorId = normalizeUuid(actor.id);
  if (id === actorId) return selfModifyFailure();
  const raw = await readJsonBody(request);
  if (!raw.ok) return invalidJsonBodyResponse();
  const parsed = manualPlanGrantBodySchema(jstToday()).safeParse(raw.body);
  if (!parsed.success) return invalidInputResponse(parsed.error.issues);
  try {
    const result = await grantManualPlan(
      { repository: createManualGrantRepository() },
      { userId: id, actorId, planKey: parsed.data.plan_key, expiresOn: parsed.data.expires_on ?? null },
    );
    // 監査は付与のあと (fail-open。失敗は app_logs)。details に本人の個人情報は入れない (理由は運営が書いた文)
    const supabase = await createClient();
    await recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: MANUAL_GRANT_AUDIT_ACTIONS.grant,
      targetId: id,
      targetType: MANUAL_GRANT_AUDIT_TARGET_TYPE,
      details: { subscription_id: result.subscription_id, plan_key: result.plan_key, expires_at: result.expires_at, reason: parsed.data.reason },
      severity: MANUAL_GRANT_AUDIT_SEVERITY[MANUAL_GRANT_AUDIT_ACTIONS.grant],
      request,
      routeName: ROUTE_POST,
    });
    return NextResponse.json({ data: result }, { status: HTTP_OK, headers: NO_STORE });
  } catch (err) {
    if (err instanceof ManualGrantError) return manualGrantFailure(err);
    return internalError(ROUTE_POST, err, { userId: actor.id, targetId: id }, { shape: 'nested' });
  }
}

export async function DELETE(request: Request, props: Params): Promise<NextResponse> {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  let actor;
  try {
    actor = await requireRole(['super_admin']);
  } catch (err) {
    return authFailure(err);
  }
  const { id: rawId } = await props.params;
  const id = targetIdOf(rawId);
  if (id === null) return errorJson('NOT_FOUND', MANUAL_GRANT_ERROR_MESSAGES.NOT_FOUND, MANUAL_GRANT_ERROR_HTTP_STATUS.NOT_FOUND);
  // 自分自身は本文を読む前に断る (§9.0 の 4。POST と同じ)
  const actorId = normalizeUuid(actor.id);
  if (id === actorId) return selfModifyFailure();
  const raw = await readJsonBody(request);
  if (!raw.ok) return invalidJsonBodyResponse();
  const parsed = ManualPlanRevokeBodySchema.safeParse(raw.body);
  if (!parsed.success) return invalidInputResponse(parsed.error.issues);
  try {
    const result = await revokeManualPlan({ repository: createManualGrantRepository() }, { userId: id, actorId });
    const supabase = await createClient();
    await recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: MANUAL_GRANT_AUDIT_ACTIONS.revoke,
      targetId: id,
      targetType: MANUAL_GRANT_AUDIT_TARGET_TYPE,
      details: { subscription_id: result.subscription_id, plan_key: result.plan_key, reason: parsed.data.reason },
      severity: MANUAL_GRANT_AUDIT_SEVERITY[MANUAL_GRANT_AUDIT_ACTIONS.revoke],
      request,
      routeName: ROUTE_DELETE,
    });
    return NextResponse.json({ data: result }, { status: HTTP_OK, headers: NO_STORE });
  } catch (err) {
    if (err instanceof ManualGrantError) return manualGrantFailure(err);
    return internalError(ROUTE_DELETE, err, { userId: actor.id, targetId: id }, { shape: 'nested' });
  }
}
