/**
 * POST /api/comparison/trigger — セグメント統計 (比較ランキング) の集計を手動で走らせる (#1406)
 * 権限: super_admin だけ
 *
 * 集計 (Edge Function calculate-segment-stats) は、全利用者の指標・順位・バッジを作り直す重い処理。
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
 *   - 500 の本文は汎用メッセージだけ (src/lib/api/errors.ts の internalError)。原因は構造化ログにだけ残す
 *
 * エラー本文の形は運営 API と同じ { error: { code, message } } (docs/design/cross/04-api-conventions.md §5.2)。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { internalError } from '@/lib/api/errors';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireRole } from '@/lib/auth/helpers';

export const dynamic = 'force-dynamic';
// 集計の Edge Function の応答を待つ上限 (秒)。他の重い API (AI の献立生成など) と同じ値。
// Next.js はこの値を静的に読むため、定数を参照せずリテラルで書く
export const maxDuration = 300;

const ROUTE_NAME = 'POST /api/comparison/trigger';
const EDGE_FUNCTION_NAME = 'calculate-segment-stats';

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

export async function POST(request: Request) {
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

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return internalError(
      ROUTE_NAME,
      new Error('NEXT_PUBLIC_SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定のため、集計の Edge Function を呼べません'),
      { userId: actorId, periodType },
      { shape: 'nested' },
    );
  }

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

  let edgeData: unknown;
  try {
    edgeData = JSON.parse(edgeText);
  } catch (err) {
    return internalError(ROUTE_NAME, err, { userId: actorId, periodType, stage: 'parse' }, { shape: 'nested' });
  }

  return NextResponse.json(edgeData);
}
