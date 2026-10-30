// @vitest-environment node
/**
 * #2112 Z3 のテスト: 運営の画面の英字の内部の値の表示名の表と、表を通さずに内部の値を描いている箇所の走査
 *
 * 1. 表 (Record<値, string>) のキーが値の一覧 (Zod の enum・定数の配列) と一致し、どの表示名も日本語を含む
 *    (値の一覧に値を足すと、表の型の誤り (tsc) とこのテストの両方で止まる)
 * 2. 表に無い値はそのまま返す (labelOrRaw。知らない値を隠さない。Object.prototype のプロパティ名もキーにしない)
 * 3. 運営の画面 (src/app/admin・src/app/super-admin・src/app/(support)・src/components/admin) のソースを TypeScript の構文木で走査し、
 *    状態・区分の列 (status / severity / category / priority / source / applicable_to / plan_key / plan_type / plan / type /
 *    subscription_target / processing_status) を、JSX の子 (`{row.status}`・`{status}` の素の名前も) か、setX(…) に渡すテンプレート文字列の文
 *    (「${updated.plan} に変更しました」の通知など) にそのまま出している箇所が無いこと。
 *    数えないもの (Issue #2112 の仕分けで除いたもの): `<code>` の子 (識別子として意図して code の字体で出すもの) と、
 *    plan_key を表示名 (display_name) と組にして出すもの (同じ要素の子か、すぐ外側の要素の中に display_name がある)。
 *    className の font-mono だけでは除かない (Issue は font-mono の plan_key 単独 (利用者の一覧のプランの列など) を直す対象に挙げている)。
 *    見ないもの (検出できない書き方。レビューで見る): 変数に入れてから出す・属性 (title・aria-label など) の値・setX を通さない文。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// src/lib/admin/inquiries.ts (値の一覧 INQUIRY_STATUSES) はサーバーの部品を import するので、読み込みだけできるよう置き換える
vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: vi.fn(), createClient: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  generateRequestId: () => 'req_test',
}));

const { labelOrRaw } = await import('@/lib/admin/value-labels');
const {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  createTicketSchema,
  ticketCategoryLabel,
  ticketListQuerySchema,
  ticketPriorityLabel,
  ticketStatusLabel,
  updateTicketSchema,
} = await import('@/lib/admin/support-schemas');
const { INQUIRY_STATUSES } = await import('@/lib/admin/inquiries');
const { INQUIRY_STATUS_LABELS, inquiryStatusLabel } = await import('@/lib/admin/inquiry-labels');
const { LEAD_SOURCES, LEAD_SOURCE_LABELS, createLeadSchema, leadSourceLabel } = await import('@/lib/admin/sales-schemas');
const { ADMIN_DEFAULT_PLAN_KEY, ADMIN_PLAN_KEY_LABELS, adminPlanKeyLabel } = await import('@/lib/admin/plan-key-labels');
const { OFFICIAL_PLAN_KEYS } = await import('@/lib/super-admin/plans-schemas');
const { ADMIN_SUBSCRIPTION_STATUS_LABELS, adminSubscriptionStatusLabel } = await import('@/lib/admin/subscription-status-labels');
const { SUBSCRIPTION_STATUSES } = await import('@/lib/billing/core');
const { ADMIN_AUDIT_SEVERITIES, ADMIN_AUDIT_SEVERITY_LABELS, adminAuditSeverityLabel } = await import(
  '@/lib/admin/audit-severity-labels'
);
const { ROLLOUT_STRATEGY_TYPES, ROLLOUT_STRATEGY_TYPE_LABELS, RolloutStrategySchema, rolloutStrategyTypeLabel } = await import(
  '@/lib/super-admin/flags-schemas'
);
const {
  COUPON_APPLICABLE_TO,
  COUPON_APPLICABLE_TO_LABELS,
  COUPON_SUBSCRIPTION_TARGETS,
  COUPON_SUBSCRIPTION_TARGET_LABELS,
  CouponApplySchema,
  couponApplicableToLabel,
  couponSubscriptionTargetLabel,
} = await import('@/lib/super-admin/coupons-schemas');
const { INVOICE_PROCESSING_STATUSES, InvoiceQuerySchema } = await import('@/lib/admin/finance-schemas');
const { INVOICE_PROCESSING_STATUS_LABELS, invoiceProcessingStatusLabel } = await import(
  '@/lib/admin/invoice-processing-status-labels'
);
const { FREE_PLAN_DISPLAY_NAME, PAID_PLAN_KEYS, planDisplayName } = await import('@homegohan/shared');

const ROOT = path.resolve(__dirname, '..');
/** ひらがな・カタカナ・CJK 統合漢字 (拡張 A を含む)・全角の英数記号 */
const JAPANESE = /[぀-ヿ㐀-鿿＀-￯]/;
/** 表に無い値 (将来の値・壊れた応答) */
const UNKNOWN_VALUE = 'brand_new_value';

/** [表の名前, 表, 値の一覧, 表示名の関数] */
const TABLES: ReadonlyArray<[string, Readonly<Record<string, string>>, readonly string[], (value: string) => string]> = [
  ['TICKET_STATUS_LABELS', TICKET_STATUS_LABELS, TICKET_STATUSES, ticketStatusLabel],
  ['TICKET_PRIORITY_LABELS', TICKET_PRIORITY_LABELS, TICKET_PRIORITIES, ticketPriorityLabel],
  ['TICKET_CATEGORY_LABELS', TICKET_CATEGORY_LABELS, TICKET_CATEGORIES, ticketCategoryLabel],
  ['INQUIRY_STATUS_LABELS', INQUIRY_STATUS_LABELS, INQUIRY_STATUSES, inquiryStatusLabel],
  ['LEAD_SOURCE_LABELS', LEAD_SOURCE_LABELS, LEAD_SOURCES, leadSourceLabel],
  ['ADMIN_PLAN_KEY_LABELS', ADMIN_PLAN_KEY_LABELS, OFFICIAL_PLAN_KEYS, adminPlanKeyLabel],
  ['ADMIN_SUBSCRIPTION_STATUS_LABELS', ADMIN_SUBSCRIPTION_STATUS_LABELS, SUBSCRIPTION_STATUSES, adminSubscriptionStatusLabel],
  ['ADMIN_AUDIT_SEVERITY_LABELS', ADMIN_AUDIT_SEVERITY_LABELS, ADMIN_AUDIT_SEVERITIES, adminAuditSeverityLabel],
  ['ROLLOUT_STRATEGY_TYPE_LABELS', ROLLOUT_STRATEGY_TYPE_LABELS, ROLLOUT_STRATEGY_TYPES, rolloutStrategyTypeLabel],
  ['COUPON_APPLICABLE_TO_LABELS', COUPON_APPLICABLE_TO_LABELS, COUPON_APPLICABLE_TO, couponApplicableToLabel],
  ['COUPON_SUBSCRIPTION_TARGET_LABELS', COUPON_SUBSCRIPTION_TARGET_LABELS, COUPON_SUBSCRIPTION_TARGETS, couponSubscriptionTargetLabel],
  ['INVOICE_PROCESSING_STATUS_LABELS', INVOICE_PROCESSING_STATUS_LABELS, INVOICE_PROCESSING_STATUSES, invoiceProcessingStatusLabel],
];

describe('#2112 Z3 表示名の表', () => {
  it.each(TABLES)('%s のキーは値の一覧と一致し、どの表示名も日本語を含む・表示名の関数は表の値を返す', (_name, table, values, label) => {
    expect(Object.keys(table).sort()).toEqual([...values].sort());
    for (const value of values) {
      expect(table[value]).toMatch(JAPANESE);
      expect(label(value)).toBe(table[value]);
    }
  });

  it.each(TABLES)('%s: 表に無い値はそのまま返す (Object.prototype のプロパティ名もそのまま)', (_name, _table, _values, label) => {
    expect(label(UNKNOWN_VALUE)).toBe(UNKNOWN_VALUE);
    expect(label('toString')).toBe('toString');
    expect(label('__proto__')).toBe('__proto__');
  });

  it('labelOrRaw: 表の値か、表に無ければそのままの値', () => {
    const table = { a: 'エー' };
    expect(labelOrRaw(table, 'a')).toBe('エー');
    expect(labelOrRaw(table, 'b')).toBe('b');
    expect(labelOrRaw(table, 'constructor')).toBe('constructor');
  });

  it('値の一覧は API の検査 (Zod の enum) と同じ: 問い合わせの状態・優先度・カテゴリ、リードの流入経路、フラグの公開の範囲の種類、請求書の処理の状態、クーポンを適用する契約の種類', () => {
    for (const status of TICKET_STATUSES) expect(ticketListQuerySchema.safeParse({ status }).success).toBe(true);
    expect(ticketListQuerySchema.safeParse({ status: UNKNOWN_VALUE }).success).toBe(false);
    for (const priority of TICKET_PRIORITIES) expect(updateTicketSchema.safeParse({ priority }).success).toBe(true);
    expect(updateTicketSchema.safeParse({ priority: UNKNOWN_VALUE }).success).toBe(false);
    const ticketBase = { user_id: '00000000-0000-4000-8000-000000000001', subject: '件名', body: '本文' };
    for (const category of TICKET_CATEGORIES) expect(createTicketSchema.safeParse({ ...ticketBase, category }).success).toBe(true);
    expect(createTicketSchema.safeParse({ ...ticketBase, category: UNKNOWN_VALUE }).success).toBe(false);
    for (const source of LEAD_SOURCES) expect(createLeadSchema.safeParse({ company_name: '会社', source }).success).toBe(true);
    expect(createLeadSchema.safeParse({ company_name: '会社', source: UNKNOWN_VALUE }).success).toBe(false);
    for (const type of ROLLOUT_STRATEGY_TYPES) expect(RolloutStrategySchema.safeParse({ type }).success).toBe(true);
    expect(RolloutStrategySchema.safeParse({ type: UNKNOWN_VALUE }).success).toBe(false);
    for (const status of INVOICE_PROCESSING_STATUSES) expect(InvoiceQuerySchema.safeParse({ status }).success).toBe(true);
    expect(InvoiceQuerySchema.safeParse({ status: UNKNOWN_VALUE }).success).toBe(false);
    const applyBase = { subscription_id: '00000000-0000-4000-8000-000000000001' };
    for (const target of COUPON_SUBSCRIPTION_TARGETS) {
      expect(CouponApplySchema.safeParse({ ...applyBase, subscription_target: target }).success).toBe(true);
    }
    expect(CouponApplySchema.safeParse({ ...applyBase, subscription_target: UNKNOWN_VALUE }).success).toBe(false);
  });

  it('クーポンを適用する契約の種類の表示名は、適用対象の表示名と同じ語 (個人 / 組織)', () => {
    for (const target of COUPON_SUBSCRIPTION_TARGETS) {
      expect(COUPON_SUBSCRIPTION_TARGET_LABELS[target]).toBe(COUPON_APPLICABLE_TO_LABELS[target]);
    }
  });

  it('プランの表示名: free と有料の 3 つは利用者の画面と同じ名前・空 (null / 空文字) は free の名前', () => {
    expect(ADMIN_DEFAULT_PLAN_KEY).toBe('free');
    expect(ADMIN_PLAN_KEY_LABELS.free).toBe(FREE_PLAN_DISPLAY_NAME);
    for (const key of PAID_PLAN_KEYS) expect(ADMIN_PLAN_KEY_LABELS[key]).toBe(planDisplayName(key));
    expect(adminPlanKeyLabel(null)).toBe(FREE_PLAN_DISPLAY_NAME);
    expect(adminPlanKeyLabel(undefined)).toBe(FREE_PLAN_DISPLAY_NAME);
    expect(adminPlanKeyLabel('')).toBe(FREE_PLAN_DISPLAY_NAME);
    // どのプランも名前が重ならない (運営が別のプランと取り違えない)
    expect(new Set(Object.values(ADMIN_PLAN_KEY_LABELS)).size).toBe(OFFICIAL_PLAN_KEYS.length);
  });
});

// ─── 走査 ─────────────────────────────────────────────────────────────────────

/** 走査する運営の画面の根 */
const SCAN_ROOTS = ['src/app/admin', 'src/app/super-admin', 'src/app/(support)', 'src/components/admin'];

/** 内部の値 (英字) が入る状態・区分の列の名前 */
const RAW_VALUE_PROPERTIES = new Set([
  'status',
  'severity',
  'category',
  'priority',
  'source',
  'applicable_to',
  'plan_key',
  'plan_type',
  'plan',
  'type',
  'subscription_target',
  'processing_status',
]);

/**
 * 許可リスト: `<ファイル>\t<式>` -> 理由。使われていない行があれば失敗する (PARALLEL_OWNED を除く)
 */
const ALLOWED: Record<string, string> = {
  'src/app/super-admin/logs/page.tsx\tlog.source':
    'アプリのログの発生元 (edge-function / api-route / client)。ログの調べ物で使う識別子で、Issue #2112 の仕分けの対象外',
  'src/app/super-admin/logs/page.tsx\tsource':
    'アプリのログの発生元の絞り込みの選択肢 (log.source と同じ識別子)。Issue #2112 の仕分けの対象外',
  'src/app/super-admin/infra/metrics/page.tsx\tlatest.source':
    'メトリクスの発生元 (取り込み元のサービスの識別子)。Issue #2112 の仕分けの対象外',
  'src/components/admin/UserFreezeForm.tsx\tres.status':
    '失敗の文の「(HTTP 500)」の HTTP の状態コード (数)。状態・区分の英字の内部の値ではない',
};

/**
 * 並走の案件 (同じ Issue #2112) が直すので、この案件では触らない箇所。並走の案件のマージで消えるため、使われていなくても失敗にしない。
 */
const PARALLEL_OWNED: Record<string, string> = {
  'src/app/admin/organizations/OrganizationsManager.tsx\torg.plan':
    '組織のプラン (standard / premium / enterprise)。組織の画面は Z2 (fix/org-create-checks) の範囲。表示名の表は src/lib/org-plans.ts の ORG_PLAN_LABELS',
  'src/app/admin/organizations/OrganizationsManager.tsx\tupdated.plan':
    '組織のプランの変更の通知「プランを ${updated.plan} に変更しました」。組織の画面は Z2 (fix/org-create-checks) の範囲',
  'src/app/super-admin/plans/[id]/page.tsx\tplan.plan_type':
    'プラン詳細の種別。Z1 (fix/plan-launch-screen) が plans-schemas の PLAN_TYPE_LABELS で直す',
};

/** 定数の名前 (大文字・数字・_) */
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;

interface RawFinding {
  file: string;
  line: number;
  text: string;
}

/** 内部の値を出しうる式 (プロパティの参照 `row.status` か、素の名前 `status`) */
type ValueAccess = ts.PropertyAccessExpression | ts.Identifier;

/** 参照の名前 (`row.status` なら status・`status` なら status) */
function accessName(access: ValueAccess): string {
  return ts.isIdentifier(access) ? access.text : access.name.text;
}

/** 値の位置にある参照を集める (式そのもの・三項の枝・&& / || / ?? の右・括弧・テンプレートの式) */
function collectValueAccesses(node: ts.Node, out: ValueAccess[]): void {
  if (ts.isPropertyAccessExpression(node) || ts.isIdentifier(node)) {
    out.push(node);
  } else if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) collectValueAccesses(span.expression, out);
  } else if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    collectValueAccesses(node.expression, out);
  } else if (ts.isConditionalExpression(node)) {
    collectValueAccesses(node.whenTrue, out);
    collectValueAccesses(node.whenFalse, out);
  } else if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      collectValueAccesses(node.right, out);
      if (op !== ts.SyntaxKind.AmpersandAmpersandToken) collectValueAccesses(node.left, out);
    }
  } else if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    collectValueAccesses(node.expression, out);
  }
}

/**
 * setX(…) の引数の中のテンプレート文字列の式だけを集める (三項の枝・&& / || / ?? の両辺・括弧をたどる)。
 * 引数そのものの参照 (setStatus(item.status) など、状態を持つための値) は文ではないので数えない
 */
function collectTemplateAccesses(node: ts.Node, out: ValueAccess[]): void {
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) collectValueAccesses(span.expression, out);
  } else if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    collectTemplateAccesses(node.expression, out);
  } else if (ts.isConditionalExpression(node)) {
    collectTemplateAccesses(node.whenTrue, out);
    collectTemplateAccesses(node.whenFalse, out);
  } else if (ts.isBinaryExpression(node)) {
    collectTemplateAccesses(node.left, out);
    collectTemplateAccesses(node.right, out);
  }
}

/** 画面の文を持つ状態の setter の呼び出しか (setMessage・setError・setPlanNotice など。setX の名前) */
const STATE_SETTER_NAME = /^set[A-Z]/;
function isStateSetterCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && STATE_SETTER_NAME.test(node.expression.text);
}

/** 要素が識別子を code の字体で出す `<code>` か (className の font-mono だけでは数えない。頭書きのとおり) */
function isCodeElement(element: ts.JsxElement, sf: ts.SourceFile): boolean {
  return element.openingElement.tagName.getText(sf) === 'code';
}

/** 定数の表 (ROLLOUT_STRATEGY_TYPE_LABELS.plan など。大文字の名前) の参照か。表示名を引いているので数えない */
function isConstantTableAccess(access: ValueAccess): boolean {
  return ts.isPropertyAccessExpression(access) && ts.isIdentifier(access.expression) && CONSTANT_NAME.test(access.expression.text);
}

/** 要素の子の式に display_name の参照があるか */
function hasDisplayNameChild(element: ts.JsxElement | ts.JsxFragment, sf: ts.SourceFile): boolean {
  return element.children.some((child) => ts.isJsxExpression(child) && child.getText(sf).includes('.display_name'));
}

/**
 * plan_key を表示名 (display_name) と組にして出しているか (Issue #2112 の仕分けで除いた「plan_key と表示名の組」)。
 * 同じ要素の子に display_name の参照がある (`{plan.display_name} ({plan.plan_key})`・`{row.display_name ?? row.plan_key}`) か、
 * すぐ外側の要素の中に display_name がある (`<td><div>{row.display_name}</div><div className="font-mono">{row.plan_key}</div></td>`) なら組と見なす
 */
function isPairedWithDisplayName(access: ValueAccess, element: ts.JsxElement | ts.JsxFragment, sf: ts.SourceFile): boolean {
  if (accessName(access) !== 'plan_key') return false;
  if (hasDisplayNameChild(element, sf)) return true;
  const outer = element.parent;
  return (ts.isJsxElement(outer) || ts.isJsxFragment(outer)) && outer.getText(sf).includes('.display_name');
}

function findRawValueRendering(file: string, source: string): RawFinding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: RawFinding[] = [];
  const report = (access: ValueAccess) => {
    const { line } = sf.getLineAndCharacterOfPosition(access.getStart(sf));
    findings.push({ file, line: line + 1, text: access.getText(sf) });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const parent = node.parent;
      if (!(ts.isJsxElement(parent) && isCodeElement(parent, sf))) {
        const accesses: ValueAccess[] = [];
        collectValueAccesses(node.expression, accesses);
        for (const access of accesses) {
          if (!RAW_VALUE_PROPERTIES.has(accessName(access))) continue;
          if (isConstantTableAccess(access) || isPairedWithDisplayName(access, parent, sf)) continue;
          report(access);
        }
      }
    } else if (isStateSetterCall(node)) {
      const accesses: ValueAccess[] = [];
      for (const arg of node.arguments) collectTemplateAccesses(arg, accesses);
      for (const access of accesses) {
        if (RAW_VALUE_PROPERTIES.has(accessName(access)) && !isConstantTableAccess(access)) report(access);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function listScreenFiles(): string[] {
  const result: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.tsx')) result.push(rel);
    }
  };
  for (const scanRoot of SCAN_ROOTS) walk(scanRoot);
  return result.sort();
}

describe('#2112 Z3 運営の画面の走査: 状態・区分の英字の内部の値を JSX にそのまま出していない', () => {
  const files = listScreenFiles();
  const findings = files.flatMap((file) => findRawValueRendering(file, fs.readFileSync(path.join(ROOT, file), 'utf8')));

  it('走査の対象に、直した画面が入っている', () => {
    for (const file of [
      'src/app/admin/users/page.tsx',
      'src/app/admin/users/[id]/page.tsx',
      'src/app/admin/support/page.tsx',
      'src/app/admin/support/[id]/page.tsx',
      'src/app/(support)/support/users/page.tsx',
      'src/app/admin/sales/[id]/page.tsx',
      'src/app/admin/finance/nps/page.tsx',
      'src/app/super-admin/audit-logs/page.tsx',
      'src/app/super-admin/backups/page.tsx',
      'src/app/super-admin/flags/page.tsx',
      'src/app/super-admin/coupons/page.tsx',
      'src/app/super-admin/coupons/[id]/page.tsx',
      'src/app/admin/finance/invoices/[id]/page.tsx',
      'src/components/admin/ManualPlanGrantSection.tsx',
    ]) {
      expect(files).toContain(file);
    }
  });

  it('走査は直す前の書き方を見つける (走査そのものの確かめ)', () => {
    const before = [
      'const A = ({ t }: { t: { category: string; priority: string } }) => (',
      '  <dl><dd className="text-gray-900">{t.category}</dd><span>{t.priority}</span></dl>',
      ');',
      'const B = ({ u }: { u: { plan_key: string | null } }) => <span className="font-mono">{u.plan_key ?? "free"}</span>;',
      'const C = ({ u }: { u: { plan_key: string | null } }) => <span>{u.plan_key ?? "free"}</span>;',
      'const D = ({ r }: { r: { severity: string } }) => <td>{`重要度: ${r.severity}`}</td>;',
      // 素の名前 (請求書の詳細の StatusBadge の `{status}`)・font-mono の plan_key 単独 (手動のプラン付与の今のプラン)
      'const H = ({ status }: { status: string }) => <span className="rounded">{status}</span>;',
      'const I = ({ v }: { v: { plan_key: string } }) => <dl><dd className="font-mono">{v.plan_key}</dd></dl>;',
      // setX に渡すテンプレート文字列の文 (付与の成功の文・組織のプランの変更の通知)
      'function J(setMessage: (m: string) => void, d: { plan_key: string; plan: string | null }) { setMessage(`${d.plan_key} を付与しました`); setMessage(`プランを ${d.plan ?? "-"} に変更しました`); }',
      // 数えないもの: 表示名との組 (同じ要素・すぐ外側の要素)・定数の表の参照・code の字体・setX の引数の素の値 (文ではない)
      'const E = ({ p }: { p: { display_name: string; plan_key: string } }) => <strong>{p.display_name} ({p.plan_key})</strong>;',
      'const K = ({ p }: { p: { display_name: string; plan_key: string } }) => <td><div>{p.display_name}</div><div className="font-mono">{p.plan_key}</div></td>;',
      'const F = () => <option value="plan">{ROLLOUT_STRATEGY_TYPE_LABELS.plan}</option>;',
      'const G = ({ p }: { p: { plan_key: string } }) => <code className="font-mono">{p.plan_key}</code>;',
      'function L(setStatus: (s: string) => void, item: { status: string }) { setStatus(item.status); }',
    ].join('\n');
    expect(findRawValueRendering('example.tsx', before).map((f) => f.text)).toEqual([
      't.category',
      't.priority',
      'u.plan_key',
      'r.severity',
      'status',
      'v.plan_key',
      'd.plan_key',
      'd.plan',
    ]);
  });

  it('許可リスト・並走の案件の箇所に無い、内部の値をそのまま描く箇所が無い', () => {
    const violations = findings
      .filter((f) => !(`${f.file}\t${f.text}` in ALLOWED) && !(`${f.file}\t${f.text}` in PARALLEL_OWNED))
      .map((f) => `${f.file}:${f.line} {${f.text}}`);
    expect(violations).toEqual([]);
  });

  it('許可リストの行は、どれも実際にソースにある (使われていない行は外す)', () => {
    const found = new Set(findings.map((f) => `${f.file}\t${f.text}`));
    expect(Object.keys(ALLOWED).filter((key) => !found.has(key))).toEqual([]);
  });
});
