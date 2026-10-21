/**
 * GET   /api/super-admin/llm/quotas  — AI の 1 日の利用回数の上限 (プランごと) の一覧
 * PATCH /api/super-admin/llm/quotas  — プランの 1 日の上限を保存する
 *   保存できるキー = subscription_plans にあるプラン + 組織のプランの値 (ORG_PLAN_VALUES。#1912)。それ以外は 404 PLAN_NOT_FOUND
 * operator/02-api-spec.md §8
 *
 * #1149 (T40): 上限の値は DB の ai_daily_limits に保存し、AI を使う入口の判定 (consume_ai_usage。
 * src/lib/plan/entitlements.ts / supabase/functions/_shared/ai-usage.ts) がその値を読む。保存した値は次の AI の利用から効く。
 *   - 上限は 1 日 (JST の暦日) の、全機能の合計の回数。null は無制限
 *   - 上限に数えない機能 (AI_UNMETERED_FEATURES。supabase/functions/_shared/ai-usage-core.ts) は合計に入らない:
 *     画面を開くと自動で呼ばれるアドバイス (nutrition_advice_auto) と、料理を保存・更新したときに付ける料理画像 (meal_image_auto)。
 *     これらは機能ごとの 1 日の安全弁 (DB の ai_unmetered_daily_caps) で止まり、この画面の上限では止まらない (#1487)
 *   - 自分の行が無いプランは free の行の値を使う (既定は free = 1 日 10 回。migration 20261011020000_ai_daily_limits.sql)
 *   - 以前の GET はコードに書いた目安を返すだけ、PATCH は保存せずに 501 を返していた (#1149 の本文)
 *
 * 権限: super_admin だけ。ai_daily_limits はクライアントのポリシーが無い (service_role だけが読み書きする) ので、
 * requireRole(['super_admin']) を通したあとで service_role のクライアントを使う。
 * 監査ログ (admin_audit_logs) は、ログインした本人の権限のクライアントで書く (RLS の audit_logs_insert_admins)。
 */
import { NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { internalError } from '@/lib/api/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import {
  AI_DAILY_LIMIT_DEFAULT_PLAN_KEY,
  LLM_QUOTAS_ENFORCED_NOTE,
  UpdateAiDailyLimitSchema,
} from '@/lib/super-admin/llm-schemas';
import {
  LLM_QUOTA_AUDIT_ACTION,
  buildAiDailyLimitRows,
  type AiDailyLimitRecord,
  type SubscriptionPlanRecord,
} from '@/lib/super-admin/ai-daily-limits';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { isOrgPlanValue } from '@/lib/org-plans';

export const dynamic = 'force-dynamic';

const GET_ROUTE = 'GET /api/super-admin/llm/quotas';
const PATCH_ROUTE = 'PATCH /api/super-admin/llm/quotas';

function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
  }
  return null;
}

export async function GET() {
  try {
    await requireRole(['super_admin']);
  } catch (err) {
    return authErrorResponse(err) ?? internalError(GET_ROUTE, err, {}, { shape: 'nested' });
  }

  try {
    const admin = getSupabaseAdmin();
    const [plansResult, limitsResult] = await Promise.all([
      admin
        .from('subscription_plans')
        .select('plan_key, display_name, plan_type')
        .order('display_order', { ascending: true })
        .order('plan_key', { ascending: true }),
      admin.from('ai_daily_limits').select('plan_key, daily_limit, updated_at').order('plan_key', { ascending: true }),
    ]);
    if (plansResult.error) {
      return internalError(GET_ROUTE, plansResult.error, { table: 'subscription_plans' }, { shape: 'nested' });
    }
    if (limitsResult.error) {
      return internalError(GET_ROUTE, limitsResult.error, { table: 'ai_daily_limits' }, { shape: 'nested' });
    }

    return NextResponse.json({
      data: buildAiDailyLimitRows(
        (plansResult.data ?? []) as SubscriptionPlanRecord[],
        (limitsResult.data ?? []) as AiDailyLimitRecord[],
      ),
      default_plan_key: AI_DAILY_LIMIT_DEFAULT_PLAN_KEY,
      enforced: true,
      note: LLM_QUOTAS_ENFORCED_NOTE,
    });
  } catch (err) {
    return internalError(GET_ROUTE, err, {}, { shape: 'nested' });
  }
}

export async function PATCH(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  let actorId: string;
  try {
    actorId = (await requireRole(['super_admin'])).id;
  } catch (err) {
    return authErrorResponse(err) ?? internalError(PATCH_ROUTE, err, {}, { shape: 'nested' });
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = UpdateAiDailyLimitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
      { status: 400 },
    );
  }
  const { plan_key: planKey, daily_limit: dailyLimit, reason } = parsed.data;

  try {
    const admin = getSupabaseAdmin();

    // 実在するプランだけを保存する (打ち間違えたキーの行を作らない)。
    // 受け付けるのは subscription_plans にあるキーと、組織のプランの値 (ORG_PLAN_VALUES。organizations.plan に書ける値)。
    // 組織の利用者の AI の上限は organizations.plan の値の行で決まり (get_effective_plan がその値を返す)、この値は subscription_plans に無い。
    // 一覧 (GET) はこの値の行を出すので、ここで断ると画面の行が保存できない (#1912)
    if (!isOrgPlanValue(planKey)) {
      const { data: plan, error: planError } = await admin
        .from('subscription_plans')
        .select('plan_key')
        .eq('plan_key', planKey)
        .maybeSingle();
      if (planError) {
        return internalError(PATCH_ROUTE, planError, { userId: actorId, table: 'subscription_plans' }, { shape: 'nested' });
      }
      if (!plan) {
        return NextResponse.json({ error: { code: 'PLAN_NOT_FOUND', message: '指定したプランはありません' } }, { status: 404 });
      }
    }

    const { data: before, error: beforeError } = await admin
      .from('ai_daily_limits')
      .select('daily_limit')
      .eq('plan_key', planKey)
      .maybeSingle();
    if (beforeError) {
      return internalError(PATCH_ROUTE, beforeError, { userId: actorId, table: 'ai_daily_limits' }, { shape: 'nested' });
    }

    const { data: saved, error: saveError } = await admin
      .from('ai_daily_limits')
      .upsert(
        { plan_key: planKey, daily_limit: dailyLimit, updated_by: actorId, updated_at: new Date().toISOString() },
        { onConflict: 'plan_key' },
      )
      .select('plan_key, daily_limit, updated_at')
      .single();
    if (saveError || !saved) {
      return internalError(
        PATCH_ROUTE,
        saveError ?? new Error('ai_daily_limits upsert returned no row'),
        { userId: actorId, table: 'ai_daily_limits' },
        { shape: 'nested' },
      );
    }

    // 監査ログ (ログインした本人の権限で書く。記録に失敗しても保存は取り消さない: recordAdminAudit は fail-open)
    await recordAdminAudit({
      supabase: await createClient(),
      actorId,
      actionType: LLM_QUOTA_AUDIT_ACTION,
      targetType: 'ai_daily_limit',
      details: {
        plan_key: planKey,
        before: before ? { daily_limit: before.daily_limit } : null,
        after: { daily_limit: dailyLimit },
        reason,
      },
      severity: 'warn',
      request,
      routeName: PATCH_ROUTE,
    });

    return NextResponse.json({ data: saved });
  } catch (err) {
    return internalError(PATCH_ROUTE, err, { userId: actorId }, { shape: 'nested' });
  }
}
