/**
 * POST /api/super-admin/backups/dr-tests — DR 訓練の結果を 1 行記録する (#1191)
 * 設計: docs/design/cross/17-backup-automation.md §7.2 (正典)・§10・§11
 *
 * 権限は super_admin だけ。本文は drTestRecordBodySchema (src/lib/backups/core.ts) で検証し、
 * admin_audit_logs に dr.test.<周期>.<種類> を本人の client で 1 行書く (target_type 'dr_test'・details は検証済みの本文)。
 * 記録そのものが操作なので fail-closed: 監査行を書けなければ 500 で、201 を返さない。
 * 重複の判定はしない (同じ月に 2 回記録してもよい。一覧で見える)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { invalidInputResponse, invalidJsonBodyResponse, readJsonBody } from '@/lib/super-admin/validation-errors';
import {
  DR_TEST_AUDIT_ACTIONS,
  DR_TEST_AUDIT_TARGET_TYPE,
  drTestRecordBodySchema,
  drTestSeverity,
} from '@/lib/backups/core';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/super-admin/backups/dr-tests';
const AUDIT_ROUTE_NAME = 'api/super-admin/backups/dr-tests POST';
const HTTP_CREATED = 201;

export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると DB (jsonb) で拒まれて 500 になる。認証・DB に触れる前に 400 で断る (#1657)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  try {
    const actor = await requireRole(['super_admin']);
    const supabase = await createClient();

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      // #1654: 本文が JSON として読めないときは 400 OP_INVALID_INPUT (外側の catch の 500 に落とさない)
      return invalidJsonBodyResponse();
    }
    const parsed = drTestRecordBodySchema.safeParse(bodyResult.body);
    if (!parsed.success) {
      // 項目の文は schema に書いた日本語。画面は details を項目ごとに出す (§7.4)
      return invalidInputResponse(parsed.error.issues);
    }
    const body = parsed.data;

    const audit = await recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: DR_TEST_AUDIT_ACTIONS[body.kind],
      targetType: DR_TEST_AUDIT_TARGET_TYPE,
      details: body,
      severity: drTestSeverity(body.result),
      request,
      routeName: AUDIT_ROUTE_NAME,
    });
    if (!audit.ok) {
      // fail-closed: 記録できなければ 201 を返さない
      return internalError(ROUTE_NAME, new Error(audit.error), { userId: actor.id }, { shape: 'nested' });
    }

    return NextResponse.json({ success: true }, { status: HTTP_CREATED });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError(ROUTE_NAME, err, {}, { shape: 'nested' });
  }
}
