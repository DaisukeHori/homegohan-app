/**
 * #2134 U2 / #2139 T1 / #2144 S3: 一覧の並びは、最後に一意の鍵 (id、id の無い表は別の一意の列) の昇順を重ねて、同じ値の行の順を決める
 * (ソースの突き合わせ)。
 *
 * 一覧を 1 つの鍵 (作った日時・始まる日・参加した日など) だけで並べると、同じ値の行の順は DB 任せで、開くたびに
 * 入れ替わりうる (ページ送りでは境目で同じ行が 2 回出る・どのページにも出ない、1 行だけ読む所ではどの行を取るかが決まらない)。
 * いまは src/lib/api/list-order.ts の LIST_ORDERS に一覧ごとの鍵を書き、route と、route や画面から呼ぶ helper・hook・画面は
 * orderListBy で並べる。
 * ここでは次を確かめる:
 *   1. LIST_ORDERS の各一覧の鍵 (いままでの鍵のあとに id の昇順)。NULL の位置は、いままでの order と同じ。
 *      新しい側から読む一覧 (REVERSED_OF) だけは、元の一覧をそっくり逆にした鍵 (最後は id の降順)
 *   2. orderListBy は鍵をこの順に order へ渡し、最後の order の戻り値を返す
 *   3. 一覧を使うファイルは orderListBy(…, LIST_ORDERS.<一覧>) で並べ、その一覧の表を読む。
 *      LIST_ORDERS.<一覧> を使うファイルは、どれも EXPECTED のその一覧の uses に書いてある。
 *      親の表の select に一覧の表を埋め込んで読む所 (uses の embeddedIn。#2166 X6) は、orderEmbeddedListBy(…, LIST_ORDERS.<一覧>) で
 *      埋め込んだ行を並べ、親の表を読んで select に一覧の表を埋め込む。orderEmbeddedListBy は鍵ごとに一覧の表を referencedTable にして渡す
 *   4. SCANNED_ROUTE_DIRS の全部のファイルは .order( を直接書かない。並びの鍵がもう一意の所 (主キー・一意の制約の列で終わる、
 *      id で終える) だけは ALLOWED_DIRECT_ORDERS に理由つきで書き、そこに書いた列の順のとおりにだけ .order( を書く
 * 実物の PostgREST が鍵の列を受け付けることは tests/integration/rls/list-order-tiebreak.test.ts が確かめる。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ID_TIEBREAK_KEY,
  LIST_ORDERS,
  NON_ID_TIEBREAK_COLUMNS,
  orderEmbeddedListBy,
  orderListBy,
  type ListOrderKey,
} from '@/lib/api/list-order';
import { AI_CONSENT_TABLE } from '../supabase/functions/_shared/ai-consent';

const ROOT = process.cwd();

/**
 * .order( を走査する場所 (#2134 で org と operator/membership、#2139 T1 で src/app/api の全体、#2144 S3 で route から呼ぶ
 * helper (src/lib・src/modules)・hook (src/hooks)・画面 (src/app の (main) など・src/components・src/contexts) に広げた。
 * #2150 でリポジトリ直下の lib を足した: src/lib/catalog-products.ts などは直下の lib の実装を再輸出するだけで、
 * 問い合わせは直下の lib に書いてある)。
 * ブラウザで動くコード (hook・画面) も、PostgREST に送る並びは同じなので走査に入れる。テスト (src/__tests__) の偽物は入れない。
 * Edge Function (supabase/functions) は Deno で動き LIST_ORDERS を import できないので走査に入れない
 * (generate-menu-v4 / v5 の並びは tests/edge-generate-menu-context-order-2150.test.ts が、料理画像のジョブ (process-meal-image-jobs)・
 * カタログの取り込みのカテゴリ (_shared/catalog/import-runner.ts)・埋め込みの再生成のページ送り (regenerate-embeddings)・
 * 栄養の検証のフォールバックの候補 (_shared/nutrition-calculator.ts) の並びは tests/edge-job-category-order-2157.test.ts が見る)
 */
const SCANNED_ROUTE_DIRS = ['src/app', 'src/lib', 'src/hooks', 'src/modules', 'src/components', 'src/contexts', 'lib'];

const ASC_NULLS_LAST = { ascending: true, nullsFirst: false };
const DESC_NULLS_FIRST = { ascending: false, nullsFirst: true };
const DESC_NULLS_LAST = { ascending: false, nullsFirst: false };

/** 昇順 (NULL は最後) の鍵 */
const asc = (column: string): ListOrderKey => ({ column, options: ASC_NULLS_LAST });
/** 降順 (NULL は最初) の鍵 */
const desc = (column: string): ListOrderKey => ({ column, options: DESC_NULLS_FIRST });

/**
 * 新しい側から件数の上限まで読み、古い順へ並べ直して使う一覧と、その元の一覧 (#2144)。
 * 鍵は元の一覧をそっくり逆にしたもの (向きと NULL の位置の両方が逆。最後の一意の鍵も降順) で、逆順に戻すと元の一覧の末尾と同じ順になる
 */
const REVERSED_OF: Partial<Record<keyof typeof LIST_ORDERS, keyof typeof LIST_ORDERS>> = {
  aiConsultationMessagesNewestFirst: 'aiConsultationMessages',
  aiConsultationContextRecentMealsNewestFirst: 'aiConsultationContextMealsByDay',
};

/** 鍵をそっくり逆にしたもの (テストの側で独立に求める) */
const reverseKey = (key: ListOrderKey): ListOrderKey => ({
  column: key.column,
  options: { ascending: !key.options.ascending, nullsFirst: !key.options.nullsFirst },
});

/** route のどこでその一覧を使うか (handler が null なら、ファイルの全体。helper の関数の中で使う所) */
interface ListOrderUse {
  file: string;
  handler: 'GET' | 'POST' | null;
  /**
   * 表の名前を定数で .from( に渡すファイルの、その定数 (省くと .from('<表>') を探す)。
   * expression を .from( に渡し、ファイルに definition の文があり、その値が value であることを見る
   */
  tableVia?: { expression: string; definition: string; value: string };
  /**
   * 一覧の表を親の表の select に埋め込んで読む所の、親の表 (.from( に渡す表。#2166 X6)。
   * そこでは orderEmbeddedListBy(…, LIST_ORDERS.<一覧>) で埋め込んだ行を並べ、select に `<一覧の表>(` を書く
   */
  embeddedIn?: string;
}

/** RegExp に入れる文字列の特殊文字を全部逃がす */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** src/lib/auth/sessions/store.ts は表の名前を TABLE に置いて読む */
const SESSIONS_STORE_TABLE_VIA = {
  expression: 'TABLE',
  definition: "const TABLE = 'user_sessions_metadata';",
  value: 'user_sessions_metadata',
};

/** 一覧ごとの、期待する表と鍵 (最後の一意の鍵を含む) と、それで並べる route */
const EXPECTED: Record<keyof typeof LIST_ORDERS, { table: string; keys: ListOrderKey[]; uses: ListOrderUse[] }> = {
  orgMyChallenges: {
    table: 'organization_challenges',
    keys: [desc('start_date'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/org/my-challenges/route.ts', handler: 'GET' }],
  },
  orgChallenges: {
    table: 'organization_challenges',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/org/challenges/route.ts', handler: 'GET' }],
  },
  orgInvites: {
    table: 'organization_invites',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/org/invites/route.ts', handler: 'GET' }],
  },
  orgDepartments: {
    table: 'departments',
    keys: [asc('display_order'), asc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/org/departments/route.ts', handler: 'GET' }],
  },
  operatorMembershipAudit: {
    table: 'membership_audit',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/operator/membership/audit/route.ts', handler: 'GET' }],
  },
  operatorOrgTransferCandidates: {
    table: 'user_profiles',
    keys: [{ column: 'last_login_at', options: DESC_NULLS_LAST }, ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/operator/membership/org/[id]/candidates/route.ts', handler: 'GET' }],
  },
  operatorFamilyTransferCandidates: {
    table: 'family_members',
    keys: [asc('joined_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/operator/membership/family/[id]/candidates/route.ts', handler: 'GET' }],
  },

  // ---- #2139 T1: 運営 (admin) の売上・請求 ----
  financeExportInvoices: {
    table: 'stripe_webhook_events',
    keys: [desc('received_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/finance/exports/route.ts', handler: 'POST' }],
  },
  financeExportSubscriptions: {
    table: 'personal_subscriptions',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/finance/exports/route.ts', handler: 'POST' }],
  },
  financeExportNps: {
    table: 'nps_surveys',
    keys: [desc('sent_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/finance/exports/route.ts', handler: 'POST' }],
  },
  financeInvoices: {
    table: 'stripe_webhook_events',
    keys: [desc('received_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/finance/invoices/route.ts', handler: 'GET' }],
  },
  financeNpsRecent: {
    table: 'nps_surveys',
    keys: [desc('responded_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/finance/nps/route.ts', handler: 'GET' }],
  },
  financeCsatRecent: {
    table: 'csat_feedbacks',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/finance/nps/route.ts', handler: 'GET' }],
  },
  financeReconciliation: {
    table: 'admin_audit_logs',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/finance/reconciliation/route.ts', handler: 'GET' }],
  },

  // ---- 運営 (admin) の組織・営業・問い合わせ・ユーザー ----
  adminOrganizations: {
    table: 'organizations',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/organizations/route.ts', handler: null }],
  },
  adminSalesLeadActivities: {
    table: 'sales_lead_activities',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [
      { file: 'src/app/api/admin/sales/leads/[id]/activities/route.ts', handler: 'GET' },
      { file: 'src/app/api/admin/sales/leads/[id]/route.ts', handler: 'GET' },
    ],
  },
  adminSalesLeads: {
    table: 'sales_leads',
    keys: [desc('updated_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/sales/leads/route.ts', handler: 'GET' }],
  },
  adminSupportTicketMessages: {
    table: 'support_ticket_messages',
    keys: [asc('created_at'), ID_TIEBREAK_KEY],
    uses: [
      { file: 'src/app/api/admin/support/tickets/[id]/messages/route.ts', handler: 'GET' },
      { file: 'src/app/api/admin/support/tickets/[id]/route.ts', handler: 'GET' },
    ],
  },
  adminSupportTickets: {
    table: 'support_tickets',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/support/tickets/route.ts', handler: null }],
  },
  adminUserCurrentSubscription: {
    table: 'personal_subscriptions',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/users/[id]/route.ts', handler: null }],
  },
  adminUserBanHistory: {
    table: 'admin_audit_logs',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/users/[id]/route.ts', handler: null }],
  },
  adminUsersByRegisteredAtAsc: {
    table: 'user_profiles',
    keys: [asc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/users/route.ts', handler: null }],
  },
  adminUsersByRegisteredAtDesc: {
    table: 'user_profiles',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/users/route.ts', handler: null }],
  },
  adminUsersByLastLoginAsc: {
    table: 'user_profiles',
    keys: [asc('last_login_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/users/route.ts', handler: null }],
  },
  adminUsersByLastLoginDesc: {
    table: 'user_profiles',
    keys: [desc('last_login_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/admin/users/route.ts', handler: null }],
  },

  // ---- AI 相談 ----
  aiConsultationMessages: {
    table: 'ai_consultation_messages',
    keys: [asc('created_at'), ID_TIEBREAK_KEY],
    uses: [
      { file: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts', handler: null },
      { file: 'src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts', handler: 'POST' },
      { file: 'src/app/api/ai/consultation/sessions/[sessionId]/summarize/route.ts', handler: 'POST' },
    ],
  },
  aiConsultationMessagesNewestFirst: {
    table: 'ai_consultation_messages',
    keys: [desc('created_at'), { column: 'id', options: DESC_NULLS_FIRST }],
    uses: [{ file: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts', handler: 'POST' }],
  },
  aiConsultationImportantMessages: {
    table: 'ai_consultation_messages',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [
      { file: 'src/app/api/ai/consultation/important-messages/route.ts', handler: 'GET' },
      { file: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts', handler: null },
      { file: 'src/app/api/ai/consultation/sessions/route.ts', handler: 'POST' },
    ],
  },
  aiConsultationSessions: {
    table: 'ai_consultation_sessions',
    keys: [desc('updated_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/ai/consultation/sessions/route.ts', handler: 'GET' }],
  },
  aiConsultationPastSummaries: {
    table: 'ai_consultation_sessions',
    keys: [desc('updated_at'), ID_TIEBREAK_KEY],
    uses: [
      { file: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts', handler: null },
      { file: 'src/app/api/ai/consultation/sessions/route.ts', handler: 'POST' },
    ],
  },
  aiConsultationContextBadges: {
    table: 'user_badges',
    keys: [desc('obtained_at'), asc('badge_id')],
    uses: [{ file: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts', handler: null }],
  },
  aiConsultationContextInsights: {
    table: 'health_insights',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts', handler: null }],
  },
  aiConsultationRecipeCollections: {
    table: 'recipe_collections',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts', handler: null }],
  },
  // ---- #2166 X4: AI 相談の add_recipe_to_collection が名前で引くコレクション ((user_id, name) の一意の索引 (#2178 Y3-b) の後は、同じ名前は 1 件。古い順の先頭を読むのは、索引の前に作られた行への防御) ----
  aiConsultationCollectionByName: {
    table: 'recipe_collections',
    keys: [asc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/lib/ai/consultation-action-executor.ts', handler: null }],
  },
  aiConsultationContextShoppingItems: {
    table: 'shopping_list_items',
    keys: [asc('category'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts', handler: null }],
  },
  // ---- #2150: AI 相談の文脈の献立と食事 (埋め込んだ user_daily_meals の日で親の行を並べる) ----
  aiConsultationContextMealsByDay: {
    table: 'planned_meals',
    keys: [asc('user_daily_meals(day_date)'), ID_TIEBREAK_KEY],
    uses: [
      { file: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts', handler: null },
      { file: 'src/app/api/ai/consultation/sessions/route.ts', handler: 'POST' },
    ],
  },
  aiConsultationContextRecentMealsNewestFirst: {
    table: 'planned_meals',
    keys: [desc('user_daily_meals(day_date)'), { column: 'id', options: DESC_NULLS_FIRST }],
    uses: [{ file: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts', handler: null }],
  },
  pantryItemsByExpiration: {
    table: 'pantry_items',
    keys: [asc('expiration_date'), ID_TIEBREAK_KEY],
    uses: [
      { file: 'src/app/api/pantry/route.ts', handler: 'GET' },
      { file: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts', handler: null },
      { file: 'src/app/api/ai/menu/v4/generate/route.ts', handler: 'POST' },
      { file: 'src/app/api/ai/menu/v5/generate/route.ts', handler: 'POST' },
      { file: 'src/hooks/useHomeData.ts', handler: null },
    ],
  },

  // ---- 献立の生成の依頼 ----
  menuMealPendingRequests: {
    table: 'weekly_menu_requests',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/ai/menu/meal/pending/route.ts', handler: 'GET' }],
  },
  menuWeeklyCleanupRequests: {
    table: 'weekly_menu_requests',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/ai/menu/weekly/cleanup/route.ts', handler: 'GET' }],
  },
  menuWeeklyPendingRequest: {
    table: 'weekly_menu_requests',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/ai/menu/weekly/pending/route.ts', handler: 'GET' }],
  },

  // ---- 利用者の画面 ----
  announcements: {
    table: 'announcements',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/announcements/route.ts', handler: 'GET' }],
  },
  contactMyInquiries: {
    table: 'inquiries',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/contact/route.ts', handler: 'GET' }],
  },
  familyInvites: {
    table: 'family_invites',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/family/invites/route.ts', handler: 'GET' }],
  },
  healthBloodTests: {
    table: 'blood_test_results',
    keys: [desc('test_date'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/health/blood-tests/route.ts', handler: 'GET' }],
  },
  healthBloodTestsChronological: {
    table: 'blood_test_results',
    keys: [asc('test_date'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/health/blood-tests/route.ts', handler: null }],
  },
  healthChallenges: {
    table: 'health_challenges',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/health/challenges/route.ts', handler: 'GET' }],
  },
  healthGoals: {
    table: 'health_goals',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/health/goals/route.ts', handler: 'GET' }],
  },
  healthInsights: {
    table: 'health_insights',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/health/insights/route.ts', handler: 'GET' }],
  },
  mealPlanDayMeals: {
    table: 'planned_meals',
    keys: [asc('display_order'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/meal-plans/meals/reorder/route.ts', handler: 'POST' }],
  },
  performancePlans: {
    table: 'performance_plans',
    keys: [desc('start_date'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/performance/plans/route.ts', handler: 'GET' }],
  },
  performanceSports: {
    table: 'sport_presets',
    keys: [asc('category'), asc('name_ja'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/performance/sports/route.ts', handler: 'GET' }],
  },
  recipeComments: {
    table: 'recipe_comments',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [
      { file: 'src/app/api/recipes/[id]/comments/route.ts', handler: 'GET' },
      // レシピの詳細はコメントをレシピに埋め込んで返す (#2166 X6)
      { file: 'src/app/api/recipes/[id]/route.ts', handler: 'GET', embeddedIn: 'recipes' },
    ],
  },
  recipes: {
    table: 'recipes',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/recipes/route.ts', handler: 'GET' }],
  },
  shoppingListLatest: {
    table: 'shopping_lists',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/shopping-list/route.ts', handler: 'GET' }],
  },

  // ---- 運営 (super-admin)・サポート ----
  superAdminAdmins: {
    table: 'user_profiles',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/super-admin/admins/route.ts', handler: 'GET' }],
  },
  superAdminAuditLogs: {
    table: 'admin_audit_logs',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/super-admin/audit-logs/route.ts', handler: 'GET' }],
  },
  cronBackupFreshnessLatest: {
    table: 'admin_audit_logs',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/cron/backup-freshness/route.ts', handler: null }],
  },
  superAdminCouponRedemptions: {
    table: 'coupon_redemptions',
    keys: [desc('redeemed_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/super-admin/coupons/[id]/redemptions/route.ts', handler: 'GET' }],
  },
  superAdminCoupons: {
    table: 'coupons',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/super-admin/coupons/route.ts', handler: 'GET' }],
  },
  superAdminExperiments: {
    table: 'experiments',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/super-admin/experiments/route.ts', handler: 'GET' }],
  },
  superAdminFeaturePackages: {
    table: 'feature_packages',
    keys: [asc('display_order'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/super-admin/feature-packages/route.ts', handler: 'GET' }],
  },
  superAdminFlags: {
    table: 'feature_flags',
    keys: [asc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/super-admin/flags/route.ts', handler: 'GET' }],
  },
  superAdminInfraAlerts: {
    table: 'infra_alerts',
    keys: [desc('triggered_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/super-admin/infra/alerts/route.ts', handler: 'GET' }],
  },
  superAdminInfraMetrics: {
    table: 'infra_metrics',
    keys: [desc('recorded_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/super-admin/infra/metrics/route.ts', handler: 'GET' }],
  },
  superAdminPlanPriceHistory: {
    table: 'plan_price_history',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/super-admin/plans/[id]/route.ts', handler: 'GET' }],
  },
  superAdminPlans: {
    table: 'subscription_plans',
    keys: [asc('display_order'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/super-admin/plans/route.ts', handler: 'GET' }],
  },
  supportRecentInquiries: {
    table: 'inquiries',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/support/stats/route.ts', handler: 'GET' }],
  },
  supportUserInquiries: {
    table: 'inquiries',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/api/support/users/[id]/route.ts', handler: 'GET' }],
  },
  supportUserNotes: {
    table: 'admin_user_notes',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [
      { file: 'src/app/api/support/users/[id]/notes/route.ts', handler: 'GET' },
      { file: 'src/app/api/support/users/[id]/route.ts', handler: 'GET' },
    ],
  },

  // ---- #2144 S3: src/app/api の外 (route や画面から呼ぶ helper・hook・画面) ----
  billingPublicPlans: {
    table: 'subscription_plans',
    keys: [asc('display_order'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/lib/billing/public-plans.ts', handler: null }],
  },
  billingGrantablePlans: {
    table: 'subscription_plans',
    keys: [asc('display_order'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/lib/billing/manual-grant-repository.ts', handler: null }],
  },
  billingLiveSubscription: {
    table: 'personal_subscriptions',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [
      { file: 'src/lib/billing/repository.ts', handler: null },
      { file: 'src/lib/billing/manual-grant-repository.ts', handler: null },
    ],
  },
  billingManualGrantHistory: {
    table: 'admin_audit_logs',
    keys: [desc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/lib/billing/manual-grant-repository.ts', handler: null }],
  },
  authLiveSessions: {
    table: 'user_sessions_metadata',
    keys: [desc('last_active_at'), asc('session_id')],
    uses: [{ file: 'src/lib/auth/sessions/store.ts', handler: null, tableVia: SESSIONS_STORE_TABLE_VIA }],
  },
  authLoginHistory: {
    table: 'user_sessions_metadata',
    keys: [desc('created_at'), asc('session_id')],
    uses: [{ file: 'src/lib/auth/sessions/store.ts', handler: null, tableVia: SESSIONS_STORE_TABLE_VIA }],
  },
  authPriorLogins: {
    table: 'user_sessions_metadata',
    keys: [desc('created_at'), asc('session_id')],
    uses: [{ file: 'src/lib/auth/sessions/store.ts', handler: null, tableVia: SESSIONS_STORE_TABLE_VIA }],
  },
  adminModerationFoodFlags: {
    table: 'moderation_flags',
    keys: [asc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/lib/admin/moderation-backend.ts', handler: null }],
  },
  adminModerationRecipeFlags: {
    table: 'recipe_flags',
    keys: [asc('created_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/lib/admin/moderation-backend.ts', handler: null }],
  },
  aiConsentHistory: {
    table: 'external_data_consents',
    keys: [desc('consented_at'), ID_TIEBREAK_KEY],
    uses: [
      {
        file: 'src/lib/ai/consent.ts',
        handler: null,
        tableVia: { expression: 'TABLE', definition: 'const TABLE = AI_CONSENT_TABLE;', value: AI_CONSENT_TABLE },
      },
    ],
  },
  homeLatestBadge: {
    table: 'user_badges',
    keys: [desc('obtained_at'), asc('badge_id')],
    uses: [{ file: 'src/hooks/useHomeData.ts', handler: null }],
  },
  homeBestVegMeal: {
    table: 'planned_meals',
    keys: [{ column: 'veg_score', options: DESC_NULLS_LAST }, ID_TIEBREAK_KEY],
    uses: [{ file: 'src/hooks/useHomeData.ts', handler: null }],
  },
  familyMemberParentalConsent: {
    table: 'parental_consents',
    keys: [desc('signed_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'src/app/(main)/family/members/[id]/page.tsx', handler: null }],
  },

  // ---- #2150: リポジトリ直下の lib ----
  catalogProductSearch: {
    table: 'catalog_products',
    keys: [desc('updated_at'), ID_TIEBREAK_KEY],
    uses: [{ file: 'lib/catalog-products.ts', handler: null }],
  },
};

/** user_id で絞って読む health_records の理由 (同じ文を 5 か所に書くので 1 つにまとめる) */
const HEALTH_RECORDS_UNIQUE_REASON =
  'health_records は (user_id, record_date) が一意 (health_records_user_id_record_date_key) で、user_id で絞って読む';
/** user_id で絞って読む user_daily_meals の理由 */
const USER_DAILY_MEALS_UNIQUE_REASON =
  'user_daily_meals は (user_id, day_date) が一意 (user_daily_meals_user_id_day_date_key) で、user_id で絞って読む';
/** revenue_snapshots の理由 */
const REVENUE_SNAPSHOTS_UNIQUE_REASON = 'revenue_snapshots の主キーは date (revenue_snapshots_pkey)';

/**
 * .order( を直接書いてよい所 (並びの鍵がもう一意で、同じ値の行が出ない所)。columns は、そのファイルに書く .order( の
 * 列を書いた順に並べたもの (それ以外の .order( を足すと赤くなる)。主キー・一意の制約は
 * supabase/migrations/20251126124224_create_meal_planner_tables.sql (ai_daily_limits は 20261011020000_ai_daily_limits.sql)
 */
const ALLOWED_DIRECT_ORDERS: Record<string, { columns: string[]; reason: string }> = {
  'src/app/api/admin/finance/dashboard/route.ts': {
    columns: ['date', 'date', 'date'],
    reason: `${REVENUE_SNAPSHOTS_UNIQUE_REASON}。daily_active_users の主キーは (date, plan_type, plan_key) で、plan_type と plan_key を絞って読むので date が一意`,
  },
  'src/app/api/admin/finance/exports/route.ts': {
    columns: ['date'],
    reason: `${REVENUE_SNAPSHOTS_UNIQUE_REASON}。ほかの CSV は LIST_ORDERS で並べる`,
  },
  'src/app/api/admin/finance/revenue/route.ts': {
    columns: ['date', 'date'],
    reason: REVENUE_SNAPSHOTS_UNIQUE_REASON,
  },
  'src/app/api/admin/inquiries/route.ts': {
    columns: ['created_at', 'id'],
    reason: '作った日時の新しい順のあと id の降順で終える (一意。ページ送りの境目の重なり・抜けを防ぐ)',
  },
  'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts': {
    columns: ['record_date'],
    reason: `${HEALTH_RECORDS_UNIQUE_REASON}。ほかの文脈の一覧は LIST_ORDERS で並べる`,
  },
  'src/app/api/ai/consultation/sessions/route.ts': {
    columns: ['record_date'],
    reason: `${HEALTH_RECORDS_UNIQUE_REASON}。ほかの一覧は LIST_ORDERS で並べる`,
  },
  'src/app/api/badges/route.ts': {
    columns: ['day_date'],
    reason: USER_DAILY_MEALS_UNIQUE_REASON,
  },
  'src/app/api/export/meals/route.ts': {
    columns: ['day_date'],
    reason: USER_DAILY_MEALS_UNIQUE_REASON,
  },
  'src/app/api/health/checkups/route.ts': {
    columns: ['checkup_date', 'checkup_date'],
    reason: 'health_checkups は (user_id, checkup_date) が一意 (health_checkups_user_date_unique) で、user_id で絞って読む',
  },
  'src/app/api/health/insights/route.ts': {
    columns: ['record_date', 'checkup_date'],
    reason: `${HEALTH_RECORDS_UNIQUE_REASON}。health_checkups も (user_id, checkup_date) が一意で、user_id で絞って読む。インサイトの一覧は LIST_ORDERS で並べる`,
  },
  'src/app/api/health/records/history/route.ts': {
    columns: ['record_date'],
    reason: HEALTH_RECORDS_UNIQUE_REASON,
  },
  'src/app/api/health/records/route.ts': {
    columns: ['record_date'],
    reason: HEALTH_RECORDS_UNIQUE_REASON,
  },
  'src/app/api/health/streaks/route.ts': {
    columns: ['record_date'],
    reason: HEALTH_RECORDS_UNIQUE_REASON,
  },
  'src/app/api/meal-plans/route.ts': {
    columns: ['day_date', 'created_at'],
    reason: `${USER_DAILY_MEALS_UNIQUE_REASON}。使っている買い物リスト (status = active) は user_id ごとに 1 つ (一意の索引 idx_shopping_lists_active_unique)`,
  },
  'src/app/api/performance/checkins/route.ts': {
    columns: ['checkin_date'],
    reason:
      'user_performance_checkins は (user_id, checkin_date) が一意 (user_performance_checkins_user_id_checkin_date_key) で、user_id で絞って読む',
  },
  'src/app/api/super-admin/backups/route.ts': {
    columns: ['created_at', 'id', 'created_at', 'id', 'created_at', 'id', 'created_at', 'id'],
    reason: '記録した日時の新しい順のあと id の降順で終える (一意)',
  },
  'src/app/api/super-admin/email-outbox/route.ts': {
    columns: ['created_at', 'id'],
    reason: '作った日時の新しい順のあと id の降順で終える (一意。続きのページのカーソルの前提)',
  },
  'src/app/api/super-admin/logs/route.ts': {
    columns: ['created_at', 'id'],
    reason: '記録した日時の新しい順のあと id の降順で終える (一意。続きのページのカーソルの前提)',
  },
  'src/app/api/super-admin/llm/quotas/route.ts': {
    columns: ['display_order', 'plan_key', 'plan_key'],
    reason:
      'subscription_plans は表示の順のあと plan_key (一意 subscription_plans_plan_key_key) で終える。ai_daily_limits の主キーは plan_key',
  },
  'src/app/api/super-admin/settings/route.ts': {
    columns: ['key'],
    reason: 'system_settings の主キーは key (system_settings_pkey)',
  },

  // ---- #2144 S3: src/app/api の外 ----
  'src/hooks/useHomeData.ts': {
    columns: ['day_date', 'day_date', 'record_date'],
    reason: `${USER_DAILY_MEALS_UNIQUE_REASON}。${HEALTH_RECORDS_UNIQUE_REASON}。期限の近い品・最新のバッジ・ベストの食事は LIST_ORDERS で並べる`,
  },
  'src/lib/account-deletion-storage.ts': {
    columns: ['id', 'id', 'id', 'id', 'id', 'id'],
    reason: 'どの表も主キー id だけで並べる (一意。ページ送りで全部の行を読む)',
  },
  'src/lib/account-export.ts': {
    columns: ['<column>'],
    reason:
      '表ごとの orderBy (src/lib/account-export-tables.ts。省くと id) の列を順に重ねる。orderBy が主キーの全列を含むことは tests/account-export-tables.test.ts が見る',
  },
  'src/lib/api/list-order.ts': {
    columns: ['<key.column>'],
    reason:
      'orderListBy と orderEmbeddedListBy の共通の中身 (LIST_ORDERS の鍵を順に重ねる。どの一覧も一意の鍵で終わることはこのテストが見る)',
  },
  'src/lib/data-subject-requests/service.ts': {
    columns: ['created_at', 'id', 'due_at', 'created_at', 'id'],
    reason: 'どちらの一覧も id の降順で終える (一意)',
  },
  'src/lib/health-insight-meals.ts': {
    columns: ['day_date'],
    reason: USER_DAILY_MEALS_UNIQUE_REASON,
  },
  'src/lib/super-admin/flag-active-users.ts': {
    columns: ['id'],
    reason: '主キー id だけで並べる (一意。ページ送りで全部の利用者を読む)',
  },
  'src/modules/dish-favorites/server.ts': {
    columns: ['created_at', 'dish_name_key', 'created_at', 'id'],
    reason: '選んだ並び (作った日時の古い順・名前の順・作った日時の新しい順) のあと、どれも id の昇順で終える (一意)',
  },
};

/**
 * TypeScript の行コメントとブロックコメントを外す。文字列 ('…' / "…" / `…`) の中はそのまま残す
 * (文字列の中の // や /* でコードを消して .order( を見落とさないため)
 */
function stripTsComments(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      i = end === -1 ? code.length : end;
    } else if (ch === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) j += code[j] === '\\' ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** コメントを外したファイルの中身 */
function sourceOf(file: string): string {
  return stripTsComments(readFileSync(join(ROOT, file), 'utf8'));
}

/** route の handler (export async function GET / POST) の本体 (次の export async function まで)。null ならファイルの全体 */
function handlerBodyOf(file: string, handler: ListOrderUse['handler']): string {
  const text = sourceOf(file);
  if (handler === null) return text;
  const start = text.indexOf(`export async function ${handler}`);
  expect(start, `${file} ${handler}`).toBeGreaterThan(-1);
  const next = text.indexOf('export async function', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

/** .order( の第 1 引数を書いた順に (文字列の列名はその名前、式は <式> と書く) */
function orderColumnsOf(code: string): string[] {
  return [...code.matchAll(/\.order\(\s*(?:'([^']*)'|"([^"]*)"|([^,)]*))/g)].map(
    ([, single, double, expression]) => single ?? double ?? `<${expression.trim()}>`,
  );
}

/** dir の下の TypeScript のファイルを全部 (リポジトリの根からの相対パス) */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (absolute: string) => {
    for (const name of readdirSync(absolute)) {
      const child = join(absolute, name);
      if (statSync(child).isDirectory()) walk(child);
      else if (/\.tsx?$/.test(name)) found.push(relative(ROOT, child));
    }
  };
  walk(join(ROOT, dir));
  return found.sort();
}

/** EXPECTED の一覧ごとの使う所を 1 行ずつに (it.each に渡す) */
const EXPECTED_USES = Object.entries(EXPECTED).flatMap(([name, expected]) =>
  expected.uses.map((use) => [name, use.file, use.handler ?? 'ファイルの全体', expected.table] as const),
);

describe('#2134 U2 / #2139 T1 / #2144 S3 一覧の並びの同じ値の順', () => {
  it('LIST_ORDERS の一覧は、期待する表から、いままでの鍵のあとに一意の鍵の昇順を重ねて読む', () => {
    expect(Object.keys(LIST_ORDERS).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const order = LIST_ORDERS[name as keyof typeof LIST_ORDERS];
      expect(order.table, name).toBe(expected.table);
      expect(order.keys, name).toEqual(expected.keys);
    }
  });

  it('どの一覧も、最後の鍵は一意の鍵 (id、id の無い表は NON_ID_TIEBREAK_COLUMNS の列) の昇順 (REVERSED_OF の一覧は降順) で、その列はそこにしか出ない', () => {
    expect(ID_TIEBREAK_KEY).toEqual({ column: 'id', options: ASC_NULLS_LAST });
    const nonIdColumns: Record<string, string> = NON_ID_TIEBREAK_COLUMNS;
    for (const [name, order] of Object.entries(LIST_ORDERS)) {
      const tiebreakColumn = nonIdColumns[order.table] ?? ID_TIEBREAK_KEY.column;
      const tiebreakOptions = name in REVERSED_OF ? DESC_NULLS_FIRST : ASC_NULLS_LAST;
      expect(order.keys.at(-1), name).toEqual({ column: tiebreakColumn, options: tiebreakOptions });
      expect(order.keys.filter((key) => key.column === tiebreakColumn), name).toHaveLength(1);
    }
  });

  it('REVERSED_OF の一覧は、元の一覧と同じ表を、元の一覧の鍵をそっくり逆にした鍵で読む (#2144)', () => {
    const entries = Object.entries(REVERSED_OF) as Array<[keyof typeof LIST_ORDERS, keyof typeof LIST_ORDERS]>;
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, source] of entries) {
      expect(LIST_ORDERS[name].table, name).toBe(LIST_ORDERS[source].table);
      expect(LIST_ORDERS[name].keys, name).toEqual(LIST_ORDERS[source].keys.map(reverseKey));
    }
  });

  it('orderListBy は鍵をこの順に order へ渡し、最後の order の戻り値を返す', () => {
    const calls: Array<[string, { ascending: boolean; nullsFirst: boolean }]> = [];
    interface RecordingQuery {
      depth: number;
      order(column: string, options: { ascending: boolean; nullsFirst: boolean }): RecordingQuery;
    }
    const makeQuery = (depth: number): RecordingQuery => ({
      depth,
      order(column, options) {
        calls.push([column, options]);
        return makeQuery(depth + 1);
      },
    });

    const ordered = orderListBy(makeQuery(0), LIST_ORDERS.orgDepartments);

    expect(calls).toEqual([
      ['display_order', ASC_NULLS_LAST],
      ['created_at', ASC_NULLS_LAST],
      ['id', ASC_NULLS_LAST],
    ]);
    // 親の行を並べるので、埋め込んだ表を指す referencedTable は渡さない
    expect(calls.filter(([, options]) => 'referencedTable' in options)).toEqual([]);
    expect(ordered.depth).toBe(LIST_ORDERS.orgDepartments.keys.length);
  });

  it('orderEmbeddedListBy は一覧の鍵をこの順に、一覧の表を referencedTable にして order へ渡し、最後の order の戻り値を返す (#2166 X6)', () => {
    const calls: Array<[string, { ascending: boolean; nullsFirst: boolean; referencedTable?: string }]> = [];
    interface RecordingQuery {
      depth: number;
      order(column: string, options: { ascending: boolean; nullsFirst: boolean; referencedTable?: string }): RecordingQuery;
    }
    const makeQuery = (depth: number): RecordingQuery => ({
      depth,
      order(column, options) {
        calls.push([column, options]);
        return makeQuery(depth + 1);
      },
    });

    const ordered = orderEmbeddedListBy(makeQuery(0), LIST_ORDERS.recipeComments);

    expect(calls).toStrictEqual([
      ['created_at', { ...DESC_NULLS_FIRST, referencedTable: 'recipe_comments' }],
      ['id', { ...ASC_NULLS_LAST, referencedTable: 'recipe_comments' }],
    ]);
    expect(ordered.depth).toBe(LIST_ORDERS.recipeComments.keys.length);
    // 鍵の options そのものは書き換えない (LIST_ORDERS はほかの一覧の並びにも使う)
    expect(LIST_ORDERS.recipeComments.keys).toEqual(EXPECTED.recipeComments.keys);
  });

  it.each(EXPECTED_USES)('%s: %s (%s) は LIST_ORDERS のこの一覧を orderListBy で使い、その表を読む', (name, file, handler, table) => {
    const body = handlerBodyOf(file, handler === 'ファイルの全体' ? null : handler);
    const usesByName: Record<string, { uses: ListOrderUse[] }> = EXPECTED;
    const use = usesByName[name].uses.find((candidate) => candidate.file === file);
    const tableVia = use?.tableVia;
    const embeddedIn = use?.embeddedIn;
    if (embeddedIn !== undefined) {
      // 親の表を読み、select に一覧の表を埋め込み、埋め込んだ行をこの一覧の鍵で並べる (#2166 X6)
      expect(body).toMatch(new RegExp(`orderEmbeddedListBy\\([\\s\\S]*?LIST_ORDERS\\.${escapeRegExp(name)}\\b`));
      expect([`.from('${embeddedIn}')`, `.from("${embeddedIn}")`].some((call) => body.includes(call)), `${file}: .from(<${embeddedIn}>)`).toBe(true);
      expect(body, `${file}: select に ${table}( を埋め込む`).toMatch(new RegExp(`\\b${escapeRegExp(table)}\\s*\\(`));
      return;
    }
    expect(body).toContain('orderListBy(');
    expect(body).toMatch(new RegExp(`LIST_ORDERS\\.${name}\\b`));
    if (tableVia === undefined) {
      // 引用符は ' と " のどちらでもよい (リポジトリ直下の lib は " で書く)
      expect([`.from('${table}')`, `.from("${table}")`].some((call) => body.includes(call)), `${file}: .from(<${table}>)`).toBe(true);
    } else {
      expect(body).toContain(`.from(${tableVia.expression})`);
      expect(sourceOf(file)).toContain(tableVia.definition);
      expect(tableVia.value).toBe(table);
    }
  });

  it('LIST_ORDERS.<一覧> を使う走査の範囲のファイルは、どれも EXPECTED のその一覧の uses に書いてある', () => {
    const unexpected: string[] = [];
    for (const file of SCANNED_ROUTE_DIRS.flatMap(sourceFiles)) {
      for (const [, name] of sourceOf(file).matchAll(/LIST_ORDERS\.(\w+)/g)) {
        const uses: ListOrderUse[] = name in EXPECTED ? EXPECTED[name as keyof typeof EXPECTED].uses : [];
        if (!uses.some((use) => use.file === file)) unexpected.push(`${file}: LIST_ORDERS.${name}`);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it('orderEmbeddedListBy を使う走査の範囲のファイルは、どれも EXPECTED の uses に embeddedIn つきで書いてある (#2166 X6)', () => {
    const embeddedFiles = Object.values(EXPECTED).flatMap((expected) =>
      expected.uses.filter((use) => use.embeddedIn !== undefined).map((use) => use.file),
    );
    expect(embeddedFiles.length).toBeGreaterThan(0);
    const unexpected = SCANNED_ROUTE_DIRS.flatMap(sourceFiles)
      .filter((file) => file !== 'src/lib/api/list-order.ts' && sourceOf(file).includes('orderEmbeddedListBy('))
      .filter((file) => !embeddedFiles.includes(file));
    expect(unexpected).toEqual([]);
  });

  it('.order( の検出は、文字列の列名・式の列名・複数行の書き方・文字列の中の // のあとの .order( を拾い、コメントの中は拾わない', () => {
    const sample = [
      "const url = 'https://example.test/a'; q.order('created_at', { ascending: false })",
      '  .order(sortColumn, { ascending: true })',
      '  .order(',
      '    "name_ja",',
      '  )',
      "// q.order('commented_out')",
      "/* q.order('block_commented') */",
    ].join('\n');
    expect(orderColumnsOf(stripTsComments(sample))).toEqual(['created_at', '<sortColumn>', 'name_ja']);
  });

  it.each(SCANNED_ROUTE_DIRS)('%s のファイルは .order( を直接書かない (並びは LIST_ORDERS か orderOrgMemberList を通す。許可の表の所だけ例外)', (dir) => {
    const files = sourceFiles(dir);
    expect(files.length, dir).toBeGreaterThan(0);
    const mismatches = files
      .map((file) => ({ file, columns: orderColumnsOf(sourceOf(file)), allowed: ALLOWED_DIRECT_ORDERS[file]?.columns ?? [] }))
      .filter(({ columns, allowed }) => JSON.stringify(columns) !== JSON.stringify(allowed));
    expect(mismatches).toEqual([]);
  });

  it('許可の表の所は、どれも走査の範囲にあって理由が書いてある', () => {
    const scanned = SCANNED_ROUTE_DIRS.flatMap(sourceFiles);
    for (const [file, { columns, reason }] of Object.entries(ALLOWED_DIRECT_ORDERS)) {
      expect(scanned, file).toContain(file);
      expect(columns.length, file).toBeGreaterThan(0);
      expect(reason.length, file).toBeGreaterThan(0);
    }
  });

  it('走査の範囲に、LIST_ORDERS で並べる route が全部入っている', () => {
    const scanned = SCANNED_ROUTE_DIRS.flatMap(sourceFiles);
    for (const expected of Object.values(EXPECTED)) {
      for (const use of expected.uses) expect(scanned).toContain(use.file);
    }
  });
});
