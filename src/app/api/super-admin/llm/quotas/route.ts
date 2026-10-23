/**
 * GET   /api/super-admin/llm/quotas  — AI の 1 日の利用回数の上限 (プランごと) の一覧
 * PATCH /api/super-admin/llm/quotas  — プランの 1 日の上限を保存する
 *   保存できるキー = subscription_plans にあるプラン + 組織のプランの値 (ORG_PLAN_VALUES。#1912)。それ以外は 404 PLAN_NOT_FOUND
 *   ただし subscription_plans の組織のプランの行 (plan_type = 'org' の org_*) は 409 PLAN_READ_ONLY で断る (#1912):
 *   組織の利用者の上限は organizations.plan の値 (ORG_PLAN_VALUES) の行で決まり、org_* の行の値は判定に使われないため
 * operator/02-api-spec.md §8
 *
 * #1149 (T40): 上限の値は DB の ai_daily_limits に保存し、AI を使う入口の判定 (consume_ai_usage。
 * src/lib/plan/entitlements.ts / supabase/functions/_shared/ai-usage.ts) がその値を読む。保存した値は次の AI の利用から効く。
 *   - 上限は 1 日 (JST の暦日) の、全機能の合計の回数。null は無制限
 *   - 上限に数えない機能 (AI_UNMETERED_FEATURES。supabase/functions/_shared/ai-usage-core.ts) は合計に入らない:
 *     画面を開くと自動で呼ばれるアドバイス (nutrition_advice_auto) と、料理を保存・更新したときに付ける料理画像 (meal_image_auto)。
 *     これらは機能ごとの 1 日の安全弁 (DB の ai_unmetered_daily_caps) で止まり、この画面の上限では止まらない (#1487)
 *   - 自分の行が無いプランは free の行の値を使う (free = 1 日 3 回。migration 20261021100000_billing_paid_plans_iap.sql の (5b))
 *   - 以前の GET はコードに書いた目安を返すだけ、PATCH は保存せずに 501 を返していた (#1149 の本文)
 *
 * 権限: super_admin だけ。ai_daily_limits はクライアントのポリシーが無い (service_role だけが読み書きする) ので、
 * requireRole(['super_admin']) を通したあとで service_role のクライアントを使う。
 * 監査ログ (admin_audit_logs) は、ログインした本人の権限のクライアントで書く (RLS の audit_logs_insert_admins)。
 *
 * 同時の保存 (#1917 の整合の候補と同じ型): 監査の before は保存の直前に読んだ値なので、保存は「読んだ値のままなら書く」条件つきにする。
 *   - 行があった: 読んだ daily_limit のままのときだけ更新する (NULL は .is で比べる)
 *   - 行が無かった: 作るだけ (同じキーの行が先にできていたら何もしない。ON CONFLICT DO NOTHING)
 * どちらも 0 行なら読み直し、今の値が送られた値と同じなら書かず記録もしない (200 で今の行)、違えば 409 CONFLICT_STALE_DATA
 * (cross/04 §4.2)。これで監査の before は、書いた時点の実際の直前の値と必ず一致する。
 */
import { NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import { internalError } from '@/lib/api/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import {
  AI_DAILY_LIMIT_DEFAULT_PLAN_KEY,
  LLM_QUOTAS_ENFORCED_NOTE,
  UpdateAiDailyLimitSchema,
} from '@/lib/super-admin/llm-schemas';
import {
  LLM_QUOTA_AUDIT_ACTION,
  PLAN_READ_ONLY_CODE,
  PLAN_READ_ONLY_MESSAGE,
  PLAN_READ_ONLY_STATUS,
  buildAiDailyLimitRows,
  isOrgSubscriptionPlanRow,
  type AiDailyLimitRecord,
  type SubscriptionPlanRecord,
} from '@/lib/super-admin/ai-daily-limits';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { isOrgPlanValue } from '@/lib/org-plans';

export const dynamic = 'force-dynamic';

const GET_ROUTE = 'GET /api/super-admin/llm/quotas';
const PATCH_ROUTE = 'PATCH /api/super-admin/llm/quotas';

/** 保存した行として返す ai_daily_limits の列 */
const SAVED_LIMIT_COLUMNS = 'plan_key, daily_limit, updated_at';

/** 読んでから書くまでに別の運営が同じプランの上限を変えていた (条件つきの保存が 0 行で、今の値が送られた値と違う) */
const STALE_LIMIT_RESPONSE = {
  error: {
    code: 'CONFLICT_STALE_DATA',
    message: '別の運営が先にこのプランの上限を変えました。画面を読み込み直して、もう一度確認してください',
  },
} as const;

function authErrorResponse(err: unknown): NextResponse | null {
  const authFailure = authFailureNested(err);
  if (authFailure) return authFailure;
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
    // subscription_plans の組織のプランの行 (org_*) は、その値が判定に使われないので保存させない (409。画面も保存させない。#1912)
    if (!isOrgPlanValue(planKey)) {
      const { data: plan, error: planError } = await admin
        .from('subscription_plans')
        .select('plan_key, plan_type')
        .eq('plan_key', planKey)
        .maybeSingle();
      if (planError) {
        return internalError(PATCH_ROUTE, planError, { userId: actorId, table: 'subscription_plans' }, { shape: 'nested' });
      }
      if (!plan) {
        return NextResponse.json({ error: { code: 'PLAN_NOT_FOUND', message: '指定したプランはありません' } }, { status: 404 });
      }
      if (isOrgSubscriptionPlanRow(plan as { plan_key: string; plan_type: string | null })) {
        return NextResponse.json(
          { error: { code: PLAN_READ_ONLY_CODE, message: PLAN_READ_ONLY_MESSAGE } },
          { status: PLAN_READ_ONLY_STATUS },
        );
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

    // 直前に読んだ値のままのときだけ書く (監査の before を、書いた時点の実際の直前の値にする)
    const values = { daily_limit: dailyLimit, updated_by: actorId, updated_at: new Date().toISOString() };
    const saveLimit = async () => {
      if (before) {
        const updateQuery = admin.from('ai_daily_limits').update(values).eq('plan_key', planKey);
        // daily_limit の列は NULL (無制限) を許すので、読んだ値が NULL なら .eq ではなく .is で比べる (PostgREST の eq.null は NULL に一致しない)
        return (before.daily_limit === null
          ? updateQuery.is('daily_limit', null)
          : updateQuery.eq('daily_limit', before.daily_limit)
        )
          .select(SAVED_LIMIT_COLUMNS)
          .maybeSingle();
      }
      // 行が無かった: 作るだけ。読んでから書くまでに別の運営が同じキーの行を作っていたら何もしない (0 行)
      return admin
        .from('ai_daily_limits')
        .upsert({ plan_key: planKey, ...values }, { onConflict: 'plan_key', ignoreDuplicates: true })
        .select(SAVED_LIMIT_COLUMNS)
        .maybeSingle();
    };
    const { data: saved, error: saveError } = await saveLimit();
    if (saveError) {
      return internalError(PATCH_ROUTE, saveError, { userId: actorId, table: 'ai_daily_limits' }, { shape: 'nested' });
    }

    if (!saved) {
      // 0 行: 読んでから書くまでに、別の運営がこのプランの上限を変えた (作った・消した)。読み直して決める
      const { data: current, error: rereadError } = await admin
        .from('ai_daily_limits')
        .select(SAVED_LIMIT_COLUMNS)
        .eq('plan_key', planKey)
        .maybeSingle();
      if (rereadError) {
        return internalError(PATCH_ROUTE, rereadError, { userId: actorId, table: 'ai_daily_limits' }, { shape: 'nested' });
      }
      // 別の運営が同じ値を先に保存していた: 書かず、記録もしない (その変更は先の運営の監査に残っている)
      if (current && current.daily_limit === dailyLimit) {
        return NextResponse.json({ data: current });
      }
      return NextResponse.json(STALE_LIMIT_RESPONSE, { status: 409 });
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
