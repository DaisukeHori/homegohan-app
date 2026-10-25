/**
 * 運営のロールで判定する、書き込みを許す public のポリシー (以下「この型」) の、いまの状態の台帳 (常設)。
 *
 * 型: 運営のロール (user_profiles.roles の運営ロールの文字列) で判定する、書き込みを許すポリシー (cmd が SELECT 以外。FOR の無い形 = ALL を含む)。
 * このポリシーがあると、運営は自分のセッションの JWT で PostgREST から直接書け、運営の API と監査ログ (admin_audit_logs) を通らずに済む。
 *
 * 台帳は、migration を version 順にすべて流した状態 (いまの状態) で、この型に当たるポリシーをすべて並べ、1 本ずつ分類と理由を持つ。
 *   - tests/operator-write-policy-ledger.test.ts が、migration の文面から作ったこの型の一覧と台帳が過不足なく一致することを見る
 *   - tests/integration/rls/operator-write-policy-ledger.test.ts が、実 DB の pg_policies と台帳が過不足なく一致することを見る
 * migration でこの型のポリシーを足す・消す・名前を変えるときは、同じ変更で台帳の行を足す・消す・直す (足すときは分類と理由を書く)。
 * 台帳は過去の状態の写しを持たない。どの migration がこの型の何を消したかの記録は、その migration の頭のコメントと PR に置く
 * (最初の棚卸しは #1917 の続き = announcements_moderation_flags_select_only の migration の頭のコメントの「同じ型の全域の探索」)。
 * 運営の API が本人のセッションの client でこの型のポリシーに頼って書く形は残さない: 運営の API は requireRole の後で service_role の
 * client で書く (20261025120000_operator_session_writes_select_only.sql がその形の 17 本を消した・運営の枝を外した)。
 * この型のポリシーを新しく足すときは、運営の API がそれに頼って書かないこと (分類のどちらかに当たること) を確かめる。
 */

/** 分類 */
export type OperatorWritePolicyCategory = 'noOperatorWriteApi' | 'auditSink';

/** 分類の意味 */
export const OPERATOR_WRITE_POLICY_CATEGORY_LABELS: Readonly<Record<OperatorWritePolicyCategory, string>> = {
  noOperatorWriteApi: '当たらない: 運営が書く API が無い (通るべき API が無いので「API を通らない書き込み」の型に当たらない)',
  auditSink: '当たらない: 監査ログそのもの (書き込みが監査の記録。WITH CHECK が actor_id = 本人・system.* でないことに固定する)',
};

/** ポリシーの種類 (pg_policies.cmd の値。SELECT はこの型に当たらない) */
export type OperatorWritePolicyCommand = 'ALL' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface OperatorWritePolicyLedgerEntry {
  table: string;
  policy: string;
  command: OperatorWritePolicyCommand;
  category: OperatorWritePolicyCategory;
  /** 分類の根拠 (書く経路のファイル・migration) */
  reason: string;
}

/** いまの状態の、この型のポリシーの全部 (表・ポリシーの名前の順) */
export const OPERATOR_WRITE_POLICY_LEDGER: readonly OperatorWritePolicyLedgerEntry[] = [
  { table: 'admin_audit_logs', policy: 'audit_logs_insert_admins', command: 'INSERT', category: 'auditSink', reason: 'src/lib/admin/audit.ts の recordAdminAudit が本人のセッションで書く監査の記録そのもの (20261017130000:375)' },
  { table: 'csat_feedbacks', policy: 'csat_access', command: 'ALL', category: 'noOperatorWriteApi', reason: '運営の API は読むだけ (src/app/api/admin/finance/nps/route.ts)' },
  { table: 'email_blacklist', policy: 'email_blacklist_admin', command: 'ALL', category: 'noOperatorWriteApi', reason: '書くのはメールの抑止 (src/lib/emails/suppression.ts) の service_role だけ' },
  { table: 'help_articles', policy: 'help_articles_manage', command: 'ALL', category: 'noOperatorWriteApi', reason: 'アプリに help_articles を読み書きする経路が無い' },
  { table: 'infra_alerts', policy: 'infra_alerts_access', command: 'ALL', category: 'noOperatorWriteApi', reason: '運営の API は読むだけ (src/app/api/super-admin/infra/alerts/route.ts)' },
  { table: 'organization_reports', policy: 'Org admins can manage reports', command: 'ALL', category: 'noOperatorWriteApi', reason: 'アプリに organization_reports を読み書きする経路が無い' },
  { table: 'organizations', policy: 'organizations_delete_super_admin', command: 'DELETE', category: 'noOperatorWriteApi', reason: '運営が組織の行を消す API は無い。20261023100000 (#1963) がこのポリシーを残すと決めた (所属が残る間は 23514 で止まる)' },
  { table: 'plan_store_products', policy: 'plan_store_products_mutate_super_admin', command: 'ALL', category: 'noOperatorWriteApi', reason: 'アプリは読むだけ (src/app/api/billing/iap/catalog/route.ts・src/lib/billing/iap-repository.ts)' },
  { table: 'sport_presets', policy: 'sport_presets_mutate_super_admin', command: 'ALL', category: 'noOperatorWriteApi', reason: 'アプリは読むだけ (src/app/api/performance/sports/route.ts・src/app/api/onboarding/complete/route.ts)' },
];

/** 突き合わせに使う 1 行の形 (「表|ポリシー 種類」) */
export const operatorWritePolicyRow = (table: string, policy: string, command: string): string => `${table}|${policy} ${command}`;

/** 台帳の行を、突き合わせの形で並べたもの (並べ替え済み) */
export const operatorWritePolicyLedgerRows = (entries: readonly OperatorWritePolicyLedgerEntry[] = OPERATOR_WRITE_POLICY_LEDGER): string[] =>
  entries.map((e) => operatorWritePolicyRow(e.table, e.policy, e.command)).sort();

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

/** ポリシーの名前 (引用符つき / 無し) */
const POLICY_NAME = String.raw`(?:"([^"]+)"|([A-Za-z_][\w]*))`;
/** スキーマつき / 無しの表の名前 */
const QUALIFIED_TABLE = String.raw`(?:"?(\w+)"?\.)?"?([A-Za-z_]\w*)"?`;

/** migration の文面から作る、ポリシー 1 本の種類と式の文面 */
interface PolicyText {
  command: string;
  /** CREATE POLICY / ALTER POLICY の ON 表 の後ろの文面 (USING と WITH CHECK の式を含む) */
  text: string;
}

/**
 * migration (行コメントを除いた文面) を順に流したときの、ポリシーの全部 (「スキーマ.表|ポリシー」→ 種類と式)。
 * CREATE / DROP / ALTER POLICY (式の差し替えと RENAME) と DROP TABLE を、ファイルの中で書かれた順に流す
 */
function policiesAfterMigrations(files: ReadonlyArray<{ sql: string }>): Map<string, PolicyText> {
  const policies = new Map<string, PolicyText>();
  const keyOf = (schema: string | undefined, table: string, name: string) => `${(schema ?? 'public').toLowerCase()}.${table}|${name}`;
  for (const { sql } of files) {
    const events: Array<{ at: number; apply: () => void }> = [];
    for (const m of sql.matchAll(new RegExp(String.raw`CREATE\s+POLICY\s+${POLICY_NAME}\s+ON\s+${QUALIFIED_TABLE}([^;]*);`, 'gi'))) {
      const key = keyOf(m[3], m[4], m[1] ?? m[2]);
      const rest = m[5];
      const command = (/^\s*(?:AS\s+\w+\s+)?(?:FOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE))?/i.exec(rest)?.[1] ?? 'ALL').toUpperCase();
      events.push({ at: m.index ?? 0, apply: () => policies.set(key, { command, text: rest }) });
    }
    for (const m of sql.matchAll(new RegExp(String.raw`DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?${POLICY_NAME}\s+ON\s+${QUALIFIED_TABLE}`, 'gi'))) {
      const key = keyOf(m[3], m[4], m[1] ?? m[2]);
      events.push({ at: m.index ?? 0, apply: () => policies.delete(key) });
    }
    for (const m of sql.matchAll(new RegExp(String.raw`ALTER\s+POLICY\s+${POLICY_NAME}\s+ON\s+${QUALIFIED_TABLE}([^;]*);`, 'gi'))) {
      const schema = m[3];
      const table = m[4];
      const key = keyOf(schema, table, m[1] ?? m[2]);
      const rest = m[5];
      events.push({
        at: m.index ?? 0,
        apply: () => {
          const current = policies.get(key);
          if (!current) return;
          const rename = /RENAME\s+TO\s+(?:"([^"]+)"|(\w+))/i.exec(rest);
          if (rename) {
            policies.delete(key);
            policies.set(keyOf(schema, table, rename[1] ?? rename[2]), current);
          } else if (/\b(USING|WITH\s+CHECK)\b/i.test(rest)) {
            policies.set(key, { ...current, text: rest });
          }
        },
      });
    }
    for (const m of sql.matchAll(new RegExp(String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${QUALIFIED_TABLE}`, 'gi'))) {
      const prefix = `${(m[1] ?? 'public').toLowerCase()}.${m[2]}|`;
      events.push({
        at: m.index ?? 0,
        apply: () => {
          for (const key of [...policies.keys()]) if (key.startsWith(prefix)) policies.delete(key);
        },
      });
    }
    for (const event of events.sort((a, b) => a.at - b.at)) event.apply();
  }
  return policies;
}

/** migration を順に流したときの、この型の public のポリシー (「表|ポリシー 種類」の並び。並べ替え済み) */
export function operatorWritePolicyRowsAfterMigrations(files: ReadonlyArray<{ sql: string }>): string[] {
  return [...policiesAfterMigrations(files).entries()]
    .filter(([key, { command, text }]) => key.startsWith('public.') && command !== 'SELECT' && isOperatorRoleExpression(text))
    // キーの「public.表|ポリシー」から public. を外すと、operatorWritePolicyRow の「表|ポリシー」と同じ形になる
    .map(([key, { command }]) => `${key.slice('public.'.length)} ${command}`)
    .sort();
}
