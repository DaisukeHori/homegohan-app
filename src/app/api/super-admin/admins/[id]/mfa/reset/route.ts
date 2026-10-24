/**
 * POST /api/super-admin/admins/{id}/mfa/reset — 運営の別の人 (super_admin) による二段階認証の解除 (段 C)
 * (#1707・#1176。docs/design/cross/12-operator-mfa.md §14.7・§14.8.2・§17・§17.2)
 *
 * 認可: requireRole(['super_admin']) (段 B の AAL2 のゲートを通る)。自分自身は 403 OP_SELF_MODIFY (本人はバックアップコードか、AAL2 での解除を使う)。
 * パスの id は UUID の形なら小文字にそろえてから使う (normalizeUuid。大文字の自分の UUID で自分の判定をすり抜けさせない #1707)。
 * 本文の形は運営 API (nested): 失敗は { error: { code, message } }・成功は { data: {...} } (MfaResetResponseSchema)。
 * 手順 (この順。どこかで止まったら後ろは何もしない):
 *   1. 別オリジン → 403 FORBIDDEN_ORIGIN
 *   2. 認可 (AuthError → 401 UNAUTHORIZED・ForbiddenError → 403 FORBIDDEN。message は日本語の固定の文で、例外の文面は出さない (src/lib/api/error-responses.ts)) / 自分 → 403 OP_SELF_MODIFY
 *   3. 本文 (MfaResetBodySchema) → 400 OP_INVALID_INPUT (src/lib/super-admin/validation-errors.ts の形)
 *   4. 対象の user_profiles (無ければ 404 NOT_FOUND・読み取りの失敗は 500)
 *   5. 消す前の数 (admin.mfa.listFactors・countRemainingBackupCodes)。読めなければ監査を書かず何も消さずに 500
 *   6. 監査 super_admin.mfa.reset (critical) を削除より先に書く。書けなければ 500 で何も消さない (fail-closed)
 *   7. 対象の全セッションを終える (endUserSessions → RPC operator_mfa_end_sessions。factor の削除より先)。失敗は 500 で何も消さない
 *   8. 読んだ factor を 1 つずつ admin.mfa.deleteFactor (error が 1 つでもあれば 500)
 *   9. deleteBackupCodes (使用済みを含む全行。失敗は 500)
 *  10. 200 { data: { user_id, factors_deleted, backup_codes_deleted } }
 * 7 を factor の削除より先にする理由: 段 B のゲートは aal2 のセッションを factor の有無を見ずに通す (P-3) ので、先に終えないと、
 * 盗まれた端末などに残る対象の aal2 のセッションが解除の後も運営の入口を通る (S-32)。route は対象の token を持たないので
 * admin.signOut は使えず、auth.sessions の対象の行を消す SQL の関数にした (§7.1・§11.5)。終えたセッションの数は応答にも監査にも入れない (Q-19)。
 * 対象のロールは見ない (必須ロールでない U0 でも同じ手順で 200。§10 の (U0, S*) の行)。
 * 本文の NULL 文字: rejectNullCharacterBody を呼ばない (入口で呼ぶと requireRole と自分の id の判定より前に本文を読むため)。
 * reason の NULL 文字は MfaResetBodySchema の refine が 400 OP_INVALID_INPUT にする
 * (src/__tests__/api/null-character-routes.test.ts の EXCLUDED §23 N-28)。
 * 監査は recordMfaAudit (src/lib/auth/mfa/audit.ts) の中の recordAdminAudit で書き、この route は recordAdminAudit を直接呼ばない
 * (tests/admin-mutation-audit-coverage-1571.test.ts の EXPECTED では exempt に理由つき §23 N-38)。
 * 監査の factors_before / backup_codes_before は「削除の前に数えた値」(§17 の定義) で、監査を書いた後の実数ではない (#1917)。
 * 監査を取り消せない操作 (セッションの終了・削除) より先に書く fail-closed の設計なので、削除の結果では書けない。
 * Auth の管理 API (listFactors / deleteFactor) は DB の鍵をまたげないので、5 の後に対象が factor を足すと、その factor は数えにも削除にも入らない。
 * 8 で消すのは 5 で数えた factor そのもの (factors_before と応答の factors_deleted は同じ数)。backup_codes_before は未使用の残数で、
 * 応答の backup_codes_deleted (使用済みを含む全行) とは数え方が違う。
 */
import { NextResponse, type NextRequest } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { authFailureNested } from '@/lib/api/error-responses';
import { requireRole } from '@/lib/auth/helpers';
import { MFA_AUDIT_ACTIONS, recordMfaAudit } from '@/lib/auth/mfa/audit';
import { countRemainingBackupCodes, deleteBackupCodes } from '@/lib/auth/mfa/backup-codes';
import { isCrossOriginRequest, MFA_NO_STORE_HEADERS } from '@/lib/auth/mfa/route-support';
import { MfaResetBodySchema, type MfaResetResponse } from '@/lib/auth/mfa/schemas';
import { endUserSessions, type OperatorSessionRpcClient } from '@/lib/auth/mfa/sessions';
import { normalizeUuid } from '@/lib/http-params';
import { invalidInputBody, invalidJsonBodyBody, readJsonBody } from '@/lib/super-admin/validation-errors';
import { getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/super-admin/admins/[id]/mfa/reset';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

/** 別オリジンの要求を断るときの文 (/api/auth/login・自己サービスの MFA API と同じ) */
const FORBIDDEN_ORIGIN_MESSAGE = '許可されていないリクエストです。';
const SELF_MODIFY_MESSAGE = '自分自身の二段階認証は、ここでは解除できません';
const NOT_FOUND_MESSAGE = 'ユーザーが見つかりません';
/**
 * user_profiles.id (= auth.users.id) の形 (UUID)。形の違う id は該当する利用者がいないので、DB に問い合わせずに 404 にする
 * (PostgREST が uuid の型の誤りで返す error を 500 にしない)
 */
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { params: Promise<{ id: string }> };

/** nested の本文の応答 (Cache-Control: private, no-store を付ける §14 冒頭の共通) */
function json(body: object, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: MFA_NO_STORE_HEADERS });
}

function errorJson(code: string, message: string, status: number): NextResponse {
  return json({ error: { code, message } }, status);
}

/** 500 INTERNAL_ERROR (nested。元のエラーは app_logs にだけ残り、本文は固定の文) に no-store を付ける */
function internalErrorResponse(error: unknown, ctx: { userId?: string; targetId?: string }): NextResponse {
  const response = internalError(ROUTE_NAME, error, ctx, { shape: 'nested' });
  for (const [name, value] of Object.entries(MFA_NO_STORE_HEADERS)) response.headers.set(name, value);
  return response;
}

export async function POST(request: NextRequest, { params }: Params) {
  if (isCrossOriginRequest(request)) return errorJson('FORBIDDEN_ORIGIN', FORBIDDEN_ORIGIN_MESSAGE, HTTP_FORBIDDEN);

  let actorId: string;
  try {
    actorId = (await requireRole(['super_admin'])).id;
  } catch (err) {
    // 既存の src/app/api/super-admin/admins/route.ts と同じ形 (code は UNAUTHORIZED / FORBIDDEN)。err.code・例外の文面は本文に出さない (§14.8.2・§19.3)
    const authFailure = authFailureNested(err, { headers: MFA_NO_STORE_HEADERS });
    if (authFailure) return authFailure;
    return internalErrorResponse(err, {});
  }

  const { id: rawId } = await params;
  // UUID の形なら小文字にそろえ、以後はこの値だけを使う (#1707。自分の判定・DB・endUserSessions・deleteFactor・監査・応答)。
  // そろえないと、大文字にした自分の UUID が下の自分の判定をすり抜け、uuid 型で比べる DB では自分の行に当たる
  const id = normalizeUuid(rawId);
  // 本文の検証より前に断る (§10 の自分の id の行)
  if (id === normalizeUuid(actorId)) return errorJson('OP_SELF_MODIFY', SELF_MODIFY_MESSAGE, HTTP_FORBIDDEN);

  const raw = await readJsonBody(request);
  if (!raw.ok) return json(invalidJsonBodyBody(), HTTP_BAD_REQUEST);
  const parsed = MfaResetBodySchema.safeParse(raw.body);
  if (!parsed.success) return json(invalidInputBody(parsed.error.issues), HTTP_BAD_REQUEST);
  const body = parsed.data;

  if (!USER_ID_PATTERN.test(id)) return errorJson('NOT_FOUND', NOT_FOUND_MESSAGE, HTTP_NOT_FOUND);

  try {
    const admin = getSupabaseAdmin();

    const { data: profile, error: profileError } = await admin
      .from('user_profiles')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (profileError) return internalErrorResponse(profileError, { userId: actorId, targetId: id });
    if (!profile) return errorJson('NOT_FOUND', NOT_FOUND_MESSAGE, HTTP_NOT_FOUND);

    // 5. 消す前の数 (監査の details の材料。記録するのは「削除の前に数えた値」。冒頭の注記 #1917)。どちらの失敗でも監査を書かず、何も消さない (まだ何もしていない)
    const { data: listed, error: listError } = await admin.auth.admin.mfa.listFactors({ userId: id });
    if (listError || !listed) return internalErrorResponse(listError, { userId: actorId, targetId: id });
    const factors = listed.factors;
    const backupCodesBefore = await countRemainingBackupCodes(admin, id);

    // 6. 監査を削除より先に書く (fail-closed。書けなければ何も消さない)
    const audit = await recordMfaAudit({
      admin,
      actorId,
      targetUserId: id,
      action: MFA_AUDIT_ACTIONS.reset,
      details: {
        reason: body.reason,
        identity_check: body.identity_check,
        factors_before: factors.length,
        backup_codes_before: backupCodesBefore,
      },
      request,
      routeName: ROUTE_NAME,
    });
    if (!audit.ok) return internalErrorResponse(audit.error, { userId: actorId, targetId: id });

    // 7. 対象の全セッションを終える (factor の削除より先)。失敗なら 500 で、factor もコードも消さない
    //    (6 の監査行は「要求された事実と消す前の数」として残る S-33)。終えた数は応答にも監査にも入れない (Q-19)
    const sessions: OperatorSessionRpcClient = { rpc: (fn, args) => admin.rpc(fn, args) };
    try {
      await endUserSessions(sessions, id);
    } catch (error) {
      return internalErrorResponse(error, { userId: actorId, targetId: id });
    }

    // 8. 5 で読んだ factor を 1 つずつ消す (error が 1 つでもあれば 500。セッションは終わっている)
    for (const factor of factors) {
      const { error: deleteError } = await admin.auth.admin.mfa.deleteFactor({ id: factor.id, userId: id });
      if (deleteError) return internalErrorResponse(deleteError, { userId: actorId, targetId: id });
    }

    // 9. コードを全部消す (使用済みを含む。DB の失敗で投げれば外側の catch で 500)
    const backupCodesDeleted = await deleteBackupCodes(admin, id);

    const responseBody: MfaResetResponse = {
      data: { user_id: id, factors_deleted: factors.length, backup_codes_deleted: backupCodesDeleted },
    };
    return json(responseBody, HTTP_OK);
  } catch (err) {
    return internalErrorResponse(err, { userId: actorId, targetId: id });
  }
}
