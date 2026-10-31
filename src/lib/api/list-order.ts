// src/lib/api/list-order.ts
// 一覧の並びの鍵を 1 か所にまとめる (#2134 U2)。
//
// 一覧を 1 つの鍵 (作った日時・始まる日・参加した日など) だけで並べると、同じ値の行の順は DB 任せで、
// 開くたびに入れ替わりうる (ページ送りのある一覧では、ページの境目で同じ行が 2 回出る・どのページにも出ない、もありうる)。
// そこでどの一覧も、最後に一意の鍵 id の昇順を重ねて順を決める (組織のメンバーの一覧の orderOrgMemberList と同じ考え方。
// src/lib/membership/org-member-list-order.ts)。
// 新しい側の件数の上限まで読み、古い順へ並べ直して使う所だけは、元の一覧をそっくり逆にした並び (reversed。最後の鍵は id の降順) で読む。
//
// 一覧ごとの鍵は LIST_ORDERS に書き、route と、route や画面から呼ぶ helper・hook・画面は
// orderListBy(問い合わせ, LIST_ORDERS.<一覧>) で並べる (.order( を直接書かない。src/app・src/lib・src/hooks・src/modules・
// src/components・src/contexts の全体を tests/list-order-tiebreak-2134.test.ts が走査で守る。
// 並びの鍵がもう一意の所 (主キー・一意の制約の列で終わる、id で終える) だけは、そのテストの許可の表に理由つきで書く)。
// NULL の位置は、いままでの order で nullsFirst を省いていた鍵は PostgreSQL の既定 (昇順は最後・降順は最初) と同じ値を明示し、nullsFirst を書いていた鍵はその値を保つ (例: operatorOrgTransferCandidates の last_login_at は降順で空を最後)。

/** PostgREST の order に渡す 1 つの並びの鍵 */
export interface ListOrderKey {
  column: string;
  options: { ascending: boolean; nullsFirst: boolean };
}

/** 1 つの一覧の並び: 読む表と、並びの鍵 (先頭ほど強い) */
export interface ListOrder {
  table: string;
  keys: readonly ListOrderKey[];
}

/** order を重ねられる問い合わせ (supabase-js の PostgrestFilterBuilder など) */
export interface OrderableQuery<Query> {
  order(column: string, options: { ascending: boolean; nullsFirst: boolean }): Query;
}

/** 最後に重ねる一意の鍵 (主キー id を持つ表の一覧) */
export const ID_TIEBREAK_KEY: ListOrderKey = { column: 'id', options: { ascending: true, nullsFirst: false } };

/**
 * 主キー id を持たない表の一覧で、id の代わりに最後に重ねる一意の鍵の列 (表の名前で引く)。
 * 主キーは supabase/migrations/20251126124224_create_meal_planner_tables.sql による。
 * - user_badges の主キーは (user_id, badge_id) (user_badges_pkey)。一覧は user_id で絞って読むので、その中では badge_id が一意
 * - user_sessions_metadata の主キーは session_id (user_sessions_metadata_pkey)
 */
export const NON_ID_TIEBREAK_COLUMNS = {
  user_badges: 'badge_id',
  user_sessions_metadata: 'session_id',
} as const;

/** 昇順 (NULL は最後。PostgreSQL の昇順の既定と同じ) */
function ascending(column: string): ListOrderKey {
  return { column, options: { ascending: true, nullsFirst: false } };
}

/** 降順 (NULL は最初。PostgreSQL の降順の既定と同じ) */
function descending(column: string): ListOrderKey {
  return { column, options: { ascending: false, nullsFirst: true } };
}

/** 並びの鍵のあとに id の昇順を重ねた一覧の並び */
function withIdTiebreak(table: string, keys: readonly ListOrderKey[]): ListOrder {
  return { table, keys: [...keys, ID_TIEBREAK_KEY] };
}

/** 並びの鍵のあとに、id の代わりの一意の鍵 (NON_ID_TIEBREAK_COLUMNS) の昇順を重ねた一覧の並び (id の無い表) */
function withNonIdTiebreak(table: keyof typeof NON_ID_TIEBREAK_COLUMNS, keys: readonly ListOrderKey[]): ListOrder {
  return { table, keys: [...keys, ascending(NON_ID_TIEBREAK_COLUMNS[table])] };
}

/**
 * 並びをそっくり逆にする (どの鍵も、向きと NULL の位置の両方を逆にする)。
 * 逆にした並びで先頭から n 件を読んで逆順に戻すと、元の並びで読んだときの末尾の n 件と同じ行が同じ順で並ぶ
 * (同じ値の行の順も、最後の一意の鍵の向きごと逆になるので崩れない)
 */
function reversed(order: ListOrder): ListOrder {
  return {
    table: order.table,
    keys: order.keys.map((key) => ({
      column: key.column,
      options: { ascending: !key.options.ascending, nullsFirst: !key.options.nullsFirst },
    })),
  };
}

/** AI 相談の 1 つのセッションのメッセージの並び (書いた日時の古い順。同じ日時は id の順) */
const AI_CONSULTATION_MESSAGES_ORDER = withIdTiebreak('ai_consultation_messages', [ascending('created_at')]);

/** 一覧ごとの並び (route の名前で引く) */
export const LIST_ORDERS = {
  /** GET /api/org/my-challenges: 始まる日 (date 型) の新しい順。同じ日に始まるチャレンジは id の順 */
  orgMyChallenges: withIdTiebreak('organization_challenges', [descending('start_date')]),
  /** GET /api/org/challenges: 作った日時の新しい順 */
  orgChallenges: withIdTiebreak('organization_challenges', [descending('created_at')]),
  /** GET /api/org/invites: 作った日時の新しい順 */
  orgInvites: withIdTiebreak('organization_invites', [descending('created_at')]),
  /** GET /api/org/departments: 表示の順 → 作った日時の古い順 */
  orgDepartments: withIdTiebreak('departments', [ascending('display_order'), ascending('created_at')]),
  /** GET /api/operator/membership/audit: 記録した日時の新しい順 (ページ送りがあるので、境目の重なり・抜けも防ぐ) */
  operatorMembershipAudit: withIdTiebreak('membership_audit', [descending('created_at')]),
  /**
   * GET /api/operator/membership/org/[id]/candidates: 最終ログインの新しい順・まだログインしていない人は最後。
   * last_login_at はログインのたびにトリガー on_auth_session_created (関数 auth_session_created) が書く
   * (supabase/migrations/20261016243000_auth_history_sessions.sql)。移行の前からログインしていない人は空のまま
   */
  operatorOrgTransferCandidates: withIdTiebreak('user_profiles', [
    { column: 'last_login_at', options: { ascending: false, nullsFirst: false } },
  ]),
  /** GET /api/operator/membership/family/[id]/candidates: 家族に入った日時の古い順 */
  operatorFamilyTransferCandidates: withIdTiebreak('family_members', [ascending('joined_at')]),

  // ---- 運営 (admin) の売上・請求 (#2139 T1) ----
  /** POST /api/admin/finance/exports (invoices): 請求の webhook を受けた日時の新しい順 (CSV) */
  financeExportInvoices: withIdTiebreak('stripe_webhook_events', [descending('received_at')]),
  /** POST /api/admin/finance/exports (subscriptions): 契約を作った日時の新しい順 (CSV) */
  financeExportSubscriptions: withIdTiebreak('personal_subscriptions', [descending('created_at')]),
  /** POST /api/admin/finance/exports (nps): NPS を送った日時の新しい順 (CSV) */
  financeExportNps: withIdTiebreak('nps_surveys', [descending('sent_at')]),
  /** GET /api/admin/finance/invoices: 請求の webhook を受けた日時の新しい順 (ページ送り) */
  financeInvoices: withIdTiebreak('stripe_webhook_events', [descending('received_at')]),
  /** GET /api/admin/finance/nps: 最近の NPS の回答 (答えた日時の新しい順・件数の上限つき) */
  financeNpsRecent: withIdTiebreak('nps_surveys', [descending('responded_at')]),
  /** GET /api/admin/finance/nps: 最近の CSAT (作った日時の新しい順・件数の上限つき) */
  financeCsatRecent: withIdTiebreak('csat_feedbacks', [descending('created_at')]),
  /** GET /api/admin/finance/reconciliation: 突き合わせの食い違いの記録 (記録した日時の新しい順・ページ送り) */
  financeReconciliation: withIdTiebreak('admin_audit_logs', [descending('created_at')]),

  // ---- 運営 (admin) の組織・営業・問い合わせ・ユーザー ----
  /** GET /api/admin/organizations: 作った日時の新しい順 (ページ送り) */
  adminOrganizations: withIdTiebreak('organizations', [descending('created_at')]),
  /** GET /api/admin/sales/leads/[id]/activities と GET /api/admin/sales/leads/[id]: 活動履歴 (記録した日時の新しい順) */
  adminSalesLeadActivities: withIdTiebreak('sales_lead_activities', [descending('created_at')]),
  /** GET /api/admin/sales/leads: 更新した日時の新しい順 (ページ送り) */
  adminSalesLeads: withIdTiebreak('sales_leads', [descending('updated_at')]),
  /** GET /api/admin/support/tickets/[id]/messages と GET /api/admin/support/tickets/[id]: やりとり (書いた日時の古い順) */
  adminSupportTicketMessages: withIdTiebreak('support_ticket_messages', [ascending('created_at')]),
  /** GET /api/admin/support/tickets: 作った日時の新しい順 (ページ送り) */
  adminSupportTickets: withIdTiebreak('support_tickets', [descending('created_at')]),
  /** GET /api/admin/users/[id]: 有効な契約のうち最後に作ったもの 1 行 */
  adminUserCurrentSubscription: withIdTiebreak('personal_subscriptions', [descending('created_at')]),
  /** GET /api/admin/users/[id]: 停止・凍結の履歴 (記録した日時の新しい順・件数の上限つき) */
  adminUserBanHistory: withIdTiebreak('admin_audit_logs', [descending('created_at')]),
  /** GET /api/admin/users (sort=registered_at, order=asc): 登録した日時の古い順 (ページ送り) */
  adminUsersByRegisteredAtAsc: withIdTiebreak('user_profiles', [ascending('created_at')]),
  /** GET /api/admin/users (sort=registered_at, order=desc): 登録した日時の新しい順 (ページ送り) */
  adminUsersByRegisteredAtDesc: withIdTiebreak('user_profiles', [descending('created_at')]),
  /** GET /api/admin/users (sort=last_login, order=asc): 最終ログインの古い順・まだログインしていない人は最後 (ページ送り) */
  adminUsersByLastLoginAsc: withIdTiebreak('user_profiles', [ascending('last_login_at')]),
  /** GET /api/admin/users (sort=last_login, order=desc): 最終ログインの新しい順・まだログインしていない人は最初 (ページ送り) */
  adminUsersByLastLoginDesc: withIdTiebreak('user_profiles', [descending('last_login_at')]),

  // ---- AI 相談 ----
  /** AI 相談の 1 つのセッションのメッセージ (書いた日時の古い順): 一覧の GET・閉じる・要約 (会話の続きの POST は下の新しい順で読む) */
  aiConsultationMessages: AI_CONSULTATION_MESSAGES_ORDER,
  /**
   * 会話の続きの POST で AI に渡す過去のメッセージ: aiConsultationMessages をそっくり逆にした並び (書いた日時の新しい順。
   * 同じ日時は id の降順)。新しい側から件数の上限まで読み、古い順へ並べ直して渡す (#2144。古い順のまま件数で切ると、
   * 件数を超えた会話では、いま保存した利用者のメッセージが文脈から落ちる)
   */
  aiConsultationMessagesNewestFirst: reversed(AI_CONSULTATION_MESSAGES_ORDER),
  /** 重要の印を付けたメッセージ (書いた日時の新しい順・件数の上限つき): 一覧の GET・AI に渡す文脈 */
  aiConsultationImportantMessages: withIdTiebreak('ai_consultation_messages', [descending('created_at')]),
  /** GET /api/ai/consultation/sessions: セッションの一覧 (更新した日時の新しい順) */
  aiConsultationSessions: withIdTiebreak('ai_consultation_sessions', [descending('updated_at')]),
  /** 閉じたセッションの要約 (更新した日時の新しい順・件数の上限つき): AI に渡す文脈 */
  aiConsultationPastSummaries: withIdTiebreak('ai_consultation_sessions', [descending('updated_at')]),
  /** AI 相談の文脈: 取ったバッジ (取った日時の新しい順・件数の上限つき)。user_badges は id が無いので badge_id で終える */
  aiConsultationContextBadges: withNonIdTiebreak('user_badges', [descending('obtained_at')]),
  /** AI 相談の文脈: AI のインサイト (作った日時の新しい順・件数の上限つき) */
  aiConsultationContextInsights: withIdTiebreak('health_insights', [descending('created_at')]),
  /** AI 相談の文脈: 使っている買い物リストの品 (分類の順) */
  aiConsultationContextShoppingItems: withIdTiebreak('shopping_list_items', [ascending('category')]),
  /**
   * 冷蔵庫・パントリーの品 (期限の近い順・期限の無い品は最後): GET /api/pantry・AI 相談の文脈・献立の生成 (v4 / v5)・
   * ホームの期限の近い品 (src/hooks/useHomeData.ts)
   */
  pantryItemsByExpiration: withIdTiebreak('pantry_items', [ascending('expiration_date')]),

  // ---- 献立の生成の依頼 ----
  /** GET /api/ai/menu/meal/pending: 1 食の生成の依頼で待っているもの (作った日時の新しい順) */
  menuMealPendingRequests: withIdTiebreak('weekly_menu_requests', [descending('created_at')]),
  /** GET /api/ai/menu/weekly/cleanup: 待っている依頼 (作った日時の新しい順・件数の上限つき) */
  menuWeeklyCleanupRequests: withIdTiebreak('weekly_menu_requests', [descending('created_at')]),
  /** GET /api/ai/menu/weekly/pending: 週の生成の依頼で待っているもののうち最後に作ったもの 1 行 */
  menuWeeklyPendingRequest: withIdTiebreak('weekly_menu_requests', [descending('created_at')]),

  // ---- 利用者の画面 ----
  /** GET /api/announcements: お知らせ (作った日時の新しい順) */
  announcements: withIdTiebreak('announcements', [descending('created_at')]),
  /** GET /api/contact: 自分の問い合わせ (作った日時の新しい順) */
  contactMyInquiries: withIdTiebreak('inquiries', [descending('created_at')]),
  /** GET /api/family/invites: 家族の招待 (作った日時の新しい順) */
  familyInvites: withIdTiebreak('family_invites', [descending('created_at')]),
  /** GET /api/health/blood-tests: 血液検査 (検査日の新しい順・件数の上限つき) */
  healthBloodTests: withIdTiebreak('blood_test_results', [descending('test_date')]),
  /** POST /api/health/blood-tests の経年レビュー: 血液検査の全部 (検査日の古い順) */
  healthBloodTestsChronological: withIdTiebreak('blood_test_results', [ascending('test_date')]),
  /** GET /api/health/challenges: チャレンジ (作った日時の新しい順) */
  healthChallenges: withIdTiebreak('health_challenges', [descending('created_at')]),
  /** GET /api/health/goals: 目標 (作った日時の新しい順) */
  healthGoals: withIdTiebreak('health_goals', [descending('created_at')]),
  /** GET /api/health/insights: インサイト (作った日時の新しい順・件数の上限つき) */
  healthInsights: withIdTiebreak('health_insights', [descending('created_at')]),
  /** POST /api/meal-plans/meals/reorder: その日の食事 (表示の順。並べ替えの前後を決める) */
  mealPlanDayMeals: withIdTiebreak('planned_meals', [ascending('display_order')]),
  /** GET /api/performance/plans: パフォーマンスの計画 (始まる日の新しい順) */
  performancePlans: withIdTiebreak('performance_plans', [descending('start_date')]),
  /** GET /api/performance/sports: 競技の候補 (分類の順 → 名前の順) */
  performanceSports: withIdTiebreak('sport_presets', [ascending('category'), ascending('name_ja')]),
  /** GET /api/recipes/[id]/comments: レシピのコメント (書いた日時の新しい順) */
  recipeComments: withIdTiebreak('recipe_comments', [descending('created_at')]),
  /** GET /api/recipes: レシピ (作った日時の新しい順・ページ送り) */
  recipes: withIdTiebreak('recipes', [descending('created_at')]),
  /** GET /api/shopping-list: その状態の買い物リストのうち最後に作ったもの 1 行 */
  shoppingListLatest: withIdTiebreak('shopping_lists', [descending('created_at')]),

  // ---- 運営 (super-admin)・サポート ----
  /** GET /api/super-admin/admins: 管理者 (登録した日時の新しい順) */
  superAdminAdmins: withIdTiebreak('user_profiles', [descending('created_at')]),
  /** GET /api/super-admin/audit-logs: 監査ログ (記録した日時の新しい順・ページ送り) */
  superAdminAuditLogs: withIdTiebreak('admin_audit_logs', [descending('created_at')]),
  /** GET /api/cron/backup-freshness: バックアップが最後に終わった記録 1 行 */
  cronBackupFreshnessLatest: withIdTiebreak('admin_audit_logs', [descending('created_at')]),
  /** GET /api/super-admin/coupons/[id]/redemptions: クーポンを使った記録 (使った日時の新しい順・ページ送り) */
  superAdminCouponRedemptions: withIdTiebreak('coupon_redemptions', [descending('redeemed_at')]),
  /** GET /api/super-admin/coupons: クーポン (作った日時の新しい順・ページ送り) */
  superAdminCoupons: withIdTiebreak('coupons', [descending('created_at')]),
  /** GET /api/super-admin/experiments: 実験 (作った日時の新しい順・ページ送り) */
  superAdminExperiments: withIdTiebreak('experiments', [descending('created_at')]),
  /** GET /api/super-admin/feature-packages: 機能のまとまり (表示の順・ページ送り) */
  superAdminFeaturePackages: withIdTiebreak('feature_packages', [ascending('display_order')]),
  /** GET /api/super-admin/flags: 機能フラグ (作った日時の古い順) */
  superAdminFlags: withIdTiebreak('feature_flags', [ascending('created_at')]),
  /** GET /api/super-admin/infra/alerts: 基盤の警報 (起きた日時の新しい順・ページ送り) */
  superAdminInfraAlerts: withIdTiebreak('infra_alerts', [descending('triggered_at')]),
  /** GET /api/super-admin/infra/metrics: 基盤の計測値 (記録した日時の新しい順・件数の上限つき) */
  superAdminInfraMetrics: withIdTiebreak('infra_metrics', [descending('recorded_at')]),
  /** GET /api/super-admin/plans/[id]: 価格の変更履歴 (変えた日時の新しい順・件数の上限つき) */
  superAdminPlanPriceHistory: withIdTiebreak('plan_price_history', [descending('created_at')]),
  /** GET /api/super-admin/plans: プラン (表示の順・ページ送り) */
  superAdminPlans: withIdTiebreak('subscription_plans', [ascending('display_order')]),
  /** GET /api/support/stats: 最近の問い合わせ (作った日時の新しい順・件数の上限つき) */
  supportRecentInquiries: withIdTiebreak('inquiries', [descending('created_at')]),
  /** GET /api/support/users/[id]: その利用者の問い合わせ (作った日時の新しい順・件数の上限つき) */
  supportUserInquiries: withIdTiebreak('inquiries', [descending('created_at')]),
  /** GET /api/support/users/[id]/notes と GET /api/support/users/[id]: 管理者のノート (書いた日時の新しい順) */
  supportUserNotes: withIdTiebreak('admin_user_notes', [descending('created_at')]),

  // ---- src/app/api の外 (route や画面から呼ぶ helper・hook・画面) (#2144 S3) ----
  /** listPublicPlans (src/lib/billing/public-plans.ts): /pricing に出す公開のプラン (表示の順) */
  billingPublicPlans: withIdTiebreak('subscription_plans', [ascending('display_order')]),
  /** listGrantablePlans (src/lib/billing/manual-grant-repository.ts): 手動で付与できるプラン (表示の順) */
  billingGrantablePlans: withIdTiebreak('subscription_plans', [ascending('display_order')]),
  /**
   * findLiveSubscription (src/lib/billing/repository.ts と src/lib/billing/manual-grant-repository.ts): 利用者の有効な契約のうち
   * 最後に作ったもの 1 行
   */
  billingLiveSubscription: withIdTiebreak('personal_subscriptions', [descending('created_at')]),
  /** listHistory (src/lib/billing/manual-grant-repository.ts): 手動付与の履歴 (記録した日時の新しい順・件数の上限つき) */
  billingManualGrantHistory: withIdTiebreak('admin_audit_logs', [descending('created_at')]),
  /** listLiveSessions (src/lib/auth/sessions/store.ts): 使っているログイン (最後に使った日時の新しい順)。id が無いので session_id で終える */
  authLiveSessions: withNonIdTiebreak('user_sessions_metadata', [descending('last_active_at')]),
  /** listLoginHistory (src/lib/auth/sessions/store.ts): ログインの履歴 (ログインした日時の新しい順・件数の上限つき) */
  authLoginHistory: withNonIdTiebreak('user_sessions_metadata', [descending('created_at')]),
  /** listPriorLogins (src/lib/auth/sessions/store.ts): 新しいログインより前のログイン (ログインした日時の新しい順・件数の上限つき) */
  authPriorLogins: withNonIdTiebreak('user_sessions_metadata', [descending('created_at')]),
  /** fetchModerationList (src/lib/admin/moderation-backend.ts) の食事の写真の通報 (通報した日時の古い順・件数の上限つき) */
  adminModerationFoodFlags: withIdTiebreak('moderation_flags', [ascending('created_at')]),
  /** fetchModerationList (src/lib/admin/moderation-backend.ts) のレシピの通報 (通報した日時の古い順・件数の上限つき) */
  adminModerationRecipeFlags: withIdTiebreak('recipe_flags', [ascending('created_at')]),
  /** getAiConsentStatus (src/lib/ai/consent.ts): AI の外部送信の同意の履歴 (同意した日時の新しい順・件数の上限つき) */
  aiConsentHistory: withIdTiebreak('external_data_consents', [descending('consented_at')]),
  /** ホーム (src/hooks/useHomeData.ts): 最後に取ったバッジ 1 行。user_badges は id が無いので badge_id で終える */
  homeLatestBadge: withNonIdTiebreak('user_badges', [descending('obtained_at')]),
  /** ホーム (src/hooks/useHomeData.ts): この 7 日の食べた食事で野菜のスコアの最も高いもの 1 行 (スコアの無い食事は最後) */
  homeBestVegMeal: withIdTiebreak('planned_meals', [
    { column: 'veg_score', options: { ascending: false, nullsFirst: false } },
  ]),
  /** 家族のメンバーの画面 (src/app/(main)/family/members/[id]/page.tsx): 子供の保護者の同意の最新の 1 行 (署名した日時の新しい順) */
  familyMemberParentalConsent: withIdTiebreak('parental_consents', [descending('signed_at')]),
} as const satisfies Record<string, ListOrder>;

/** 問い合わせに鍵の順で order を重ねる (先に重ねた鍵ほど強い。PostgREST の order=a.asc,b.asc) */
export function orderListBy<Query extends OrderableQuery<Query>>(query: Query, order: { keys: readonly ListOrderKey[] }): Query {
  return order.keys.reduce((ordered, key) => ordered.order(key.column, key.options), query);
}
