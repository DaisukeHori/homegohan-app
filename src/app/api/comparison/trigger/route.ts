/**
 * POST /api/comparison/trigger — セグメント統計 (比較ランキング) の集計を手動で走らせる (#1406)
 * 権限: super_admin だけ
 *
 * 集計 (Edge Function calculate-segment-stats) は、全利用者の指標・統計・順位を作り直す重い処理。
 * 通常は pg_cron が 1 時間ごと (毎時 5 分) に呼ぶ (supabase/migrations/20261009100000_schedule_calculate_segment_stats.sql)。
 * この API は、運営が定期実行を待たずに作り直したいときのためだけに残す。
 *
 * 以前の問題:
 *   - ログインしていれば誰でも呼べた (getUser() しか見ていなかった)
 *   - 利用者の JWT のまま関数を呼んでいたため、関数の認証 (requireServiceRole) で必ず 401 → この API は必ず 500 だった
 *   - 失敗時に error.message をそのまま本文に返していた (#1172)
 *
 * 今の動き:
 *   - 未ログインは 401、super_admin でない (一般利用者・admin・support など) は 403。どちらも関数は呼ばない
 *   - 関数は service role の鍵で呼ぶ (認可を通したあとだけ使う)
 *   - 関数に渡すのは periodType だけ。関数は、呼んだ時刻 (JST) が属する直近の 1 期間だけを集計する
 *     (本文に期間の開始日などを書いても、関数には渡さない。過去の期間の埋め戻しはしない)
 *   - 今の期間 (進行中) の集計なので、比較のバッジは判定しない。バッジは、pg_cron が期間の切り替わった直後に
 *     直前の期間を集計し直す回 (previousPeriod: true) だけが付ける (#1491。暫定の順位で取り消されないバッジを付けないため)
 *   - 500 の本文は汎用メッセージだけ (src/lib/api/errors.ts の internalError)。原因は構造化ログにだけ残す
 *   - 集計を走らせられた (関数が 200 を返した) ときだけ、監査ログに super_admin.cron.run_now を 1 行残す (#1571。
 *     運営の変更系はすべて記録する。docs/design/operator/07-audit-monitoring.md §4.2)。本人の権限の client で書き、
 *     記録の失敗で応答は変えない (fail-open。失敗は recordAdminAudit が db-logger に残す)
 *
 * エラー本文の形は運営 API と同じ { error: { code, message } } (docs/design/cross/04-api-conventions.md §5.2)。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { recordAdminAudit } from '@/lib/admin/audit';
import { internalError } from '@/lib/api/errors';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireRole } from '@/lib/auth/helpers';
import { createLogger } from '@/lib/db-logger';
import { getSupabaseServiceConfig } from '@/lib/env-required';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
// 集計の Edge Function の応答を待つ上限 (秒)。他の重い API (AI の献立生成など) と同じ値。
// Next.js はこの値を静的に読むため、定数を参照せずリテラルで書く
export const maxDuration = 300;

const ROUTE_NAME = 'POST /api/comparison/trigger';
const EDGE_FUNCTION_NAME = 'calculate-segment-stats';
/** 監査ログ (admin_audit_logs) の action_type。定期実行 (pg_cron) を待たずに手で走らせる操作 (operator/07 §4.2 の cron 手動実行) */
const CRON_RUN_NOW_AUDIT_ACTION = 'super_admin.cron.run_now';
/** 監査ログの target_type。対象は定期処理そのもので、uuid の id は無い (target_id は null) */
const CRON_RUN_NOW_AUDIT_TARGET_TYPE = 'cron_job';

/**
 * 集計できる期間の種類。pg_cron の定期実行 (public.invoke_calculate_segment_stats) が呼ぶ 3 種類と同じで、
 * 比較画面の選択肢 (モバイル: 日・週・月、Web: 週・月) をすべて含む。
 */
const PERIOD_TYPES = ['daily', 'weekly', 'monthly'] as const;
/** periodType を省略したときの値。Edge Function の既定 (weekly) と同じ */
const DEFAULT_PERIOD_TYPE: (typeof PERIOD_TYPES)[number] = 'weekly';

// periodType 以外のキーは受け取らずに捨てる (z.object の既定)。関数へは periodType だけを送る
const TriggerBodySchema = z.object({
  periodType: z.enum(PERIOD_TYPES).default(DEFAULT_PERIOD_TYPE),
});

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/** 本文を読む。空の本文は {} とみなす (periodType は既定値になる)。JSON として読めなければ null */
async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 手動の集計を監査ログに 1 行残す (#1571)。fail-open: 記録できなくても例外を投げず、応答は変えない。
 * 本人の権限の client が作れないとき (RLS の audit_logs_insert_admins は actor_id = auth.uid() を求める) も、
 * その失敗を構造化ログに残して戻る (INSERT の失敗は recordAdminAudit が構造化ログに残す)。
 */
async function recordRunNowAudit(
  request: Request,
  actorId: string,
  periodType: (typeof PERIOD_TYPES)[number],
): Promise<void> {
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch (err) {
    createLogger(ROUTE_NAME).error('監査ログ (admin_audit_logs) への記録に失敗しました', err, {
      action_type: CRON_RUN_NOW_AUDIT_ACTION,
      actor_id: actorId,
      stage: 'client',
    });
    return;
  }
  await recordAdminAudit({
    supabase,
    actorId,
    actionType: CRON_RUN_NOW_AUDIT_ACTION,
    targetType: CRON_RUN_NOW_AUDIT_TARGET_TYPE,
    details: { job: EDGE_FUNCTION_NAME, period_type: periodType },
    request,
    routeName: ROUTE_NAME,
  });
}

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  let actorId: string;
  try {
    const actor = await requireRole(['super_admin']);
    actorId = actor.id;
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(errorBody('UNAUTHORIZED', '認証が必要です'), { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(errorBody('FORBIDDEN', '権限がありません'), { status: 403 });
    }
    return internalError(ROUTE_NAME, err, {}, { shape: 'nested' });
  }

  const parsed = TriggerBodySchema.safeParse(await readBody(request));
  if (!parsed.success) {
    return NextResponse.json(
      errorBody('VALIDATION_ERROR', `periodType は ${PERIOD_TYPES.join(' / ')} のいずれかを指定してください`),
      { status: 400 },
    );
  }
  const { periodType } = parsed.data;

  // 必須の環境変数 (Supabase の URL・service role の鍵) が欠けていれば、関数を呼ばずに汎用の 500 で止める。
  // MissingEnvError の message は固定の文で変数名を含まない。欠けた変数名はサーバーのログと構造化ログにだけ残る (#1182 / #1172)
  let serviceConfig: { url: string; serviceRoleKey: string };
  try {
    serviceConfig = getSupabaseServiceConfig();
  } catch (err) {
    return internalError(ROUTE_NAME, err, { userId: actorId, periodType, stage: 'env' }, { shape: 'nested' });
  }
  const { url: supabaseUrl, serviceRoleKey } = serviceConfig;

  let edgeRes: Response;
  try {
    edgeRes = await fetch(`${supabaseUrl}/functions/v1/${EDGE_FUNCTION_NAME}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ periodType }),
    });
  } catch (err) {
    return internalError(ROUTE_NAME, err, { userId: actorId, periodType, stage: 'fetch' }, { shape: 'nested' });
  }

  const edgeText = await edgeRes.text().catch(() => '');
  if (!edgeRes.ok) {
    // 関数の本文 (DB のエラー文を含むことがある) は利用者に返さず、ログにだけ残す
    return internalError(
      ROUTE_NAME,
      new Error(`${EDGE_FUNCTION_NAME} が HTTP ${edgeRes.status} を返しました: ${edgeText}`),
      { userId: actorId, periodType, edge_status: edgeRes.status },
      { shape: 'nested' },
    );
  }

  // 関数が 200 を返した時点で集計は走っている (取り消せない) ので、本文が読めるかどうかの前に記録する
  await recordRunNowAudit(request, actorId, periodType);

  let edgeData: unknown;
  try {
    edgeData = JSON.parse(edgeText);
  } catch (err) {
    return internalError(ROUTE_NAME, err, { userId: actorId, periodType, stage: 'parse' }, { shape: 'nested' });
  }

  return NextResponse.json(edgeData);
}
