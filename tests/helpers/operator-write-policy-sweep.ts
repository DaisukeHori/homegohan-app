/**
 * #1917 の続き (migration 20261024110000_announcements_moderation_flags_select_only.sql) の「同じ型の全域の探索」の棚卸しの台帳。
 *
 * 型: 運営のロール (user_profiles.roles の運営ロールの文字列) で判定する、書き込みを許すポリシー (cmd が SELECT 以外。FOR の無い形 = ALL を含む)。
 * このポリシーがあると、運営は自分のセッションの JWT で PostgREST から直接書け、運営の API と監査ログ (admin_audit_logs) を通らずに済む。
 *
 * 台帳は、本冊の直前 (migration を version 順に 20261024110000 の前まで流した状態) の public のポリシーのうち、この型に当たるものを
 * すべて並べ、1 本ずつ分類と理由を持つ。本冊が消したもの (closedHere) は、本冊の後には残らない。
 *   - tests/announcements-moderation-flags-select-only-migration-contract.test.ts が、migration の文面から作ったポリシーの一覧と
 *     この台帳が過不足なく一致することを見る (本冊の直前と、全部流した後の両方)。後の migration がこの型のポリシーを足すと赤になるので、
 *     足す人がここで分類する (分類の無い運営の書き込みのポリシーを残さない)
 *   - tests/integration/rls/announcements-moderation-flags-select-only.test.ts (A-9) が、実 DB の pg_policies と突き合わせる
 *   - 本冊の migration の頭のコメントの「同じ型の全域の探索」が、台帳のすべての表を名指しすることも、contract test が見る
 */

/** 分類 */
export type OperatorWritePolicySweepCategory = 'closedHere' | 'sessionClientApi' | 'noOperatorWriteApi' | 'auditSink';

/** 分類の意味 (migration の頭のコメントの見出しと同じ意味) */
export const OPERATOR_WRITE_POLICY_SWEEP_CATEGORY_LABELS: Readonly<Record<OperatorWritePolicySweepCategory, string>> = {
  closedHere:
    '本冊が消した: 運営の API は service_role の client (か SECURITY DEFINER の関数) で書き、本人のセッションの client でこのポリシーに頼って書く経路が無い',
  sessionClientApi:
    '別の案件: 運営 (や組織の管理者) の API が本人のセッションの client でこのポリシーに頼って書く。ポリシーを絞ると API が書けなくなるので、API を service_role に移す変更と一緒に直す',
  noOperatorWriteApi: '当たらない: 運営が書く API が無い (通るべき API が無いので「API を通らない書き込み」の型に当たらない)',
  auditSink: '当たらない: 監査ログそのもの (書き込みが監査の記録。WITH CHECK が actor_id = 本人・system.* でないことに固定する)',
};

/** ポリシーの種類 (pg_policies.cmd の値。SELECT はこの型に当たらない) */
export type OperatorWritePolicyCommand = 'ALL' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface OperatorWritePolicySweepEntry {
  table: string;
  policy: string;
  command: OperatorWritePolicyCommand;
  category: OperatorWritePolicySweepCategory;
  /** 分類の根拠 (書く経路のファイル・migration) */
  reason: string;
}

/** 本冊の直前の、この型のポリシーの全部 (表・ポリシーの名前の順) */
export const OPERATOR_WRITE_POLICY_SWEEP: readonly OperatorWritePolicySweepEntry[] = [
  { table: 'admin_audit_logs', policy: 'audit_logs_insert_admins', command: 'INSERT', category: 'auditSink', reason: 'src/lib/admin/audit.ts の recordAdminAudit が本人のセッションで書く監査の記録そのもの (20261017130000:375)' },
  { table: 'admin_user_notes', policy: 'Admins can manage user notes', command: 'ALL', category: 'sessionClientApi', reason: 'src/app/api/admin/users/[id]/route.ts・src/app/api/support/users/[id]/notes/route.ts が本人のセッションで INSERT' },
  { table: 'announcements', policy: 'Admins can manage announcements', command: 'ALL', category: 'closedHere', reason: 'POST /api/announcements が service_role で INSERT (本冊の 1)' },
  { table: 'coupons', policy: 'coupons_mutate_sales_or_above', command: 'ALL', category: 'sessionClientApi', reason: 'src/app/api/super-admin/coupons/** が本人のセッションで INSERT / UPDATE / DELETE' },
  { table: 'csat_feedbacks', policy: 'csat_access', command: 'ALL', category: 'noOperatorWriteApi', reason: '運営の API は読むだけ (src/app/api/admin/finance/nps/route.ts)' },
  { table: 'departments', policy: 'Org admins can manage departments', command: 'ALL', category: 'sessionClientApi', reason: 'src/app/api/org/departments/route.ts が本人のセッションで INSERT / UPDATE / DELETE' },
  { table: 'email_blacklist', policy: 'email_blacklist_admin', command: 'ALL', category: 'noOperatorWriteApi', reason: '書くのはメールの抑止 (src/lib/emails/suppression.ts) の service_role だけ' },
  { table: 'experiment_assignments', policy: 'experiment_assignments_delete_super_admin', command: 'DELETE', category: 'sessionClientApi', reason: 'src/app/api/super-admin/experiments/[id]/route.ts の DELETE が本人のセッションで消す' },
  { table: 'experiments', policy: 'experiments_select_super_admin', command: 'ALL', category: 'sessionClientApi', reason: 'src/app/api/super-admin/experiments/** が本人のセッションで INSERT / UPDATE / DELETE' },
  { table: 'feature_flags', policy: 'feature_flags_super_admin_all', command: 'ALL', category: 'sessionClientApi', reason: 'src/app/api/super-admin/flags/** が本人のセッションで INSERT / UPDATE / DELETE' },
  { table: 'feature_packages', policy: 'feature_packages_mutate_super_admin', command: 'ALL', category: 'sessionClientApi', reason: 'src/app/api/super-admin/feature-packages/**・flags/route.ts が本人のセッションで書く' },
  { table: 'help_articles', policy: 'help_articles_manage', command: 'ALL', category: 'noOperatorWriteApi', reason: 'アプリに help_articles を読み書きする経路が無い' },
  { table: 'infra_alerts', policy: 'infra_alerts_access', command: 'ALL', category: 'noOperatorWriteApi', reason: '運営の API は読むだけ (src/app/api/super-admin/infra/alerts/route.ts)' },
  { table: 'inquiries', policy: 'Admins can update inquiries', command: 'UPDATE', category: 'sessionClientApi', reason: 'src/app/api/admin/inquiries/[id]/route.ts の PATCH が本人のセッションで UPDATE' },
  { table: 'moderation_flags', policy: 'moderation_flags_admin_all', command: 'ALL', category: 'closedHere', reason: '運営の通報の API が service_role で書く (本冊の 2)' },
  { table: 'organization_challenges', policy: 'Org admins can manage challenges', command: 'ALL', category: 'sessionClientApi', reason: 'src/app/api/org/challenges/route.ts が本人のセッションで INSERT / UPDATE' },
  { table: 'organization_invites', policy: 'Org admins can delete invites', command: 'DELETE', category: 'sessionClientApi', reason: 'src/app/api/org/invites/route.ts の DELETE が本人のセッションで消す (組織の owner / admin の枝。20261022180000)' },
  { table: 'organization_reports', policy: 'Org admins can manage reports', command: 'ALL', category: 'noOperatorWriteApi', reason: 'アプリに organization_reports を読み書きする経路が無い' },
  { table: 'organizations', policy: 'organizations_delete_super_admin', command: 'DELETE', category: 'noOperatorWriteApi', reason: '運営が組織の行を消す API は無い。20261023100000 (#1963) がこのポリシーを残すと決めた (所属が残る間は 23514 で止まる)' },
  { table: 'personal_subscriptions', policy: 'personal_subscriptions_insert_admin', command: 'INSERT', category: 'closedHere', reason: '手動付与の API が service_role で billing_grant_manual_subscription を呼ぶ (本冊の 6。billing/02 §16 の 2)' },
  { table: 'personal_subscriptions', policy: 'personal_subscriptions_update_admin', command: 'UPDATE', category: 'closedHere', reason: '取り消し・写像・クーポンの適用は service_role で SECURITY DEFINER の関数を呼ぶ (本冊の 6)' },
  { table: 'plan_store_products', policy: 'plan_store_products_mutate_super_admin', command: 'ALL', category: 'noOperatorWriteApi', reason: 'アプリは読むだけ (src/app/api/billing/iap/catalog/route.ts・src/lib/billing/iap-repository.ts)' },
  { table: 'recipe_flags', policy: 'Admins can update recipe flags', command: 'UPDATE', category: 'closedHere', reason: '運営の通報の API が service_role で書く (本冊の 4)' },
  { table: 'sales_lead_activities', policy: 'sales_activities_access', command: 'ALL', category: 'sessionClientApi', reason: 'src/app/api/admin/sales/leads/** が本人のセッションで INSERT' },
  { table: 'sales_leads', policy: 'sales_leads_access', command: 'ALL', category: 'sessionClientApi', reason: 'src/app/api/admin/sales/leads/** が本人のセッションで INSERT / UPDATE' },
  { table: 'sport_presets', policy: 'sport_presets_mutate_super_admin', command: 'ALL', category: 'noOperatorWriteApi', reason: 'アプリは読むだけ (src/app/api/performance/sports/route.ts・src/app/api/onboarding/complete/route.ts)' },
  { table: 'subscription_plans', policy: 'subscription_plans_mutate_super_admin', command: 'ALL', category: 'sessionClientApi', reason: 'src/app/api/super-admin/plans/** が本人のセッションで INSERT / UPDATE / DELETE' },
  { table: 'support_ticket_messages', policy: 'ticket_messages_insert', command: 'INSERT', category: 'sessionClientApi', reason: 'src/app/api/admin/support/tickets/** が本人のセッションで INSERT' },
  { table: 'support_tickets', policy: 'tickets_insert_staff', command: 'INSERT', category: 'sessionClientApi', reason: 'src/app/api/admin/support/tickets/route.ts の POST が本人のセッションで INSERT' },
  { table: 'support_tickets', policy: 'tickets_update_support', command: 'UPDATE', category: 'sessionClientApi', reason: 'src/app/api/admin/support/tickets/[id]/** が本人のセッションで UPDATE' },
  { table: 'system_settings', policy: 'Super admins can update system settings', command: 'ALL', category: 'sessionClientApi', reason: 'src/app/api/super-admin/settings/route.ts が本人のセッションで UPSERT' },
];

/** 台帳のキー (表|ポリシー) */
export const sweepKeyOf = (table: string, policy: string): string => `${table}|${policy}`;

/** 本冊の後に残る (closedHere 以外の) 台帳の行 */
export const OPERATOR_WRITE_POLICIES_AFTER_MIGRATION: readonly OperatorWritePolicySweepEntry[] = OPERATOR_WRITE_POLICY_SWEEP.filter(
  (entry) => entry.category !== 'closedHere',
);

/** 式に user_profiles.roles の列が出る (運営ロールの判定の目印。付録 A.3 と同じ) */
const ROLES_COLUMN_PATTERN = /\broles\b/;
/**
 * 運営ロールの文字列 (src/lib/auth/password/policy.ts の OPERATOR_ROLES の 6 つと org_industrial_doctor)。
 * migration の文面は 'admin' / 'admin'::text / 'admin'::"text"、DB の式 (pg_policies) は 'admin'::text の形で現れる
 */
const OPERATOR_ROLE_LITERAL_PATTERN = /'(super_admin|admin|support|sales|finance|content_moderator|org_industrial_doctor)'/;

/** ポリシーの式 (USING と WITH CHECK をつないだもの) が運営のロールで判定するか */
export const isOperatorRoleExpression = (expression: string): boolean =>
  ROLES_COLUMN_PATTERN.test(expression) && OPERATOR_ROLE_LITERAL_PATTERN.test(expression);
