// @vitest-environment node
/**
 * 組織の管理画面 (src/app/(org) 配下と、管理画面の枠の外に置いた src/app/(main)/org 配下)・家族の画面 (src/app/(main)/family 配下。#2073)・
 * 設定のメンバーシップ (src/app/(main)/settings/membership。#2073) に、英語だけの固定の文言
 *  (と、内部の英字の状態・役割の値をそのまま出す箇所) が残っていないことのソース走査テスト。
 * 内部の値をそのまま出す箇所は、運営のメンバーシップの画面 (src/app/(operator)/operator/membership と部品) と
 * 運営の審査の画面 (src/app/admin/moderation と審査の欄の部品。#2080 U6) も見る
 *
 * 問題:
 *   日本語の画面なのに、サイドバーのログアウトのボタンに「Sign Out」、ダッシュボードの見出しに「Health Cockpit」、
 *   メンバー数の欄に「Total Members」「users」と英語が出ていた (組織の名前が読めないときの「Organization」は
 *   src/lib/org-sidebar.ts の定数で、tests/org-sidebar-plan-label.test.tsx が見る)。日本語に置き換えたうえで、
 *   新しい英語の固定の文言が入らないよう、画面のソースを TypeScript の構文木で走査する (コメントは見ない)。
 *
 * 画面に出る文字として数えるもの:
 *   1. JSX の文字 (`<span>Sign Out</span>`)
 *   2. JSX の子の式の値の位置にある文字列 (`{ok ? "Saved" : "Failed"}`・`{x && "Done"}`・`{name ?? "Unknown"}`)
 *   3. 画面に出る属性の値 (placeholder / title / alt / aria-label / label)
 *   4. 文言を持つプロパティの値 (`{ label: "..." }` / title / description / message / text / placeholder)
 *   5. 利用者に見せる呼び出しの引数 (alert / confirm / setError… / set…Message。`data.error?.message ?? "..."` の右も)
 *   値の位置 = 式そのもの・三項演算子の 2 つの枝・&& / || / ?? の右・括弧の中・テンプレート文字列の文字の部分。
 *   比べる式 (`status === "loaded"`) や関数の引数 (`fetch("/api/...")`) の文字列は数えない。
 *
 * 違反: ラテン文字を含み、日本語 (ひらがな・カタカナ・漢字・全角) を 1 文字も含まないもの。
 *   日本語の文に混じる英字 (「Email アドレス」など) は数えない。
 *
 * 許可リスト (ALLOWED): 英語だけでも日本語の画面で正しいものだけ。理由を書き、使われていない行があれば失敗する。
 *
 * 運営の画面 (src/app/super-admin・src/app/admin。#2086 V6) は、失敗の文だけを見る (見出しやプロバイダの名前など、英字のままで正しい
 * 表示が多いので、英語だけの文言の走査 (SCAN_ROOTS) には入れない)。以前の画面は、本文に文の無い失敗 (プロキシの 502 など) を
 * 「HTTP 502」と英字だけで出し、fetch の reject ではブラウザの英字の例外の文 (Failed to fetch) を、失敗の応答の本文が JSON でないと
 * res.json() の英字の SyntaxError の文を、エラー欄・alert にそのまま出していた。見るもの (FAILURE_COPY_SCAN_ROOTS):
 *   F1. 利用者に見せる呼び出し (alert / confirm / setError… / set…Message) の引数と、文言のプロパティ (message / text) の値に、
 *       英語だけの文字 (`HTTP ${status}` の「HTTP 」など) が無い
 *   F2. 同じ場所と JSX の子に、例外の文面 (`err.message`・`e instanceof Error ? e.message : …`・`String(e)`。例外を受ける名前の変数の
 *       .message と String()) を入れていない。画面に出す例外の文は src/lib/admin/admin-screen-messages.ts の displayableAdminError で
 *       日本語の文の例外 (AdminScreenError) だけを出す
 *   F3. 失敗の応答 (`if (!res.ok) { … }` の中) の本文を `.json()` で読むときは `.catch(…)` を付ける (JSON でない本文で SyntaxError を投げない)
 *   見ないもの (検出できない書き方。レビューで見る): 例外の文面を変数に入れてから出す (`const m = err.message; setError(m)`)・
 *   `!res.ok` 以外の条件の分岐の中の `.json()`。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ORG_SCREEN_ROOTS, isUnderRoot, orgUrlTopDirs } from './helpers/org-screen-roots';

const ROOT = path.resolve(__dirname, '..');
/**
 * 走査する画面のディレクトリ: 組織の管理画面のルートグループと、管理画面の枠の外に置いた組織の画面
 * (オーナーの譲渡の承諾の画面 /org/transfer-accept/[proposal_id]。一般メンバーも開くので (main) に置く。#2068)。
 * 組織の画面の根は、組織の画面を走査するテストで共通の定数 ORG_SCREEN_ROOTS から取る (#2073)。
 * それに、家族の画面 (#2073 S5。家族の代表者の譲渡の承諾の画面が、処理済みの提案に「(ステータス: accepted)」と内部の英字の値を出していた) と、
 * 設定のメンバーシップ (#2073。組織の役割を「役割: owner」と英字のまま出していた) を足す。
 * 家族の画面と設定のメンバーシップは、この走査だけが見る根なので、共通の定数には入れない
 * (共通の定数を広げると、それを使う組織の画面の別の走査 (API のエラーの日本語・見出しの文言) の範囲まで変わる)
 */
const FAMILY_SCREEN_ROOT = 'src/app/(main)/family';
const SETTINGS_MEMBERSHIP_ROOT = 'src/app/(main)/settings/membership';
const SCAN_ROOTS: readonly string[] = [...ORG_SCREEN_ROOTS, FAMILY_SCREEN_ROOT, SETTINGS_MEMBERSHIP_ROOT];
/**
 * 内部の値をそのまま出していないかだけを見る画面 (英語だけの文言の走査は SCAN_ROOTS だけ)。
 * 運営の家族の代表者・組織のオーナーの付け替えの画面が、候補の役割を「adult」「member」と英字のまま出していた (#2073)
 */
const RAW_VALUE_ONLY_SCAN_ROOTS = [
  'src/app/(operator)/operator/membership',
  // 運営のメンバーシップの画面の部品 (確認の枠・一覧の表)
  'src/components/operator/membership',
  // 運営の審査の画面 (一覧・詳細) と審査の欄。審査済みのアイテムの状態を「ステータス: rejected」と英字のまま出していた (#2080 U6)
  'src/app/admin/moderation',
  'src/components/operator/moderation',
];

/**
 * 失敗の文だけを見る運営の画面の根 (#2086 V6)。運営の審査の画面 (src/app/admin/moderation) もこの根の下にあり、同じ規則で見る
 */
const FAILURE_COPY_SCAN_ROOTS = ['src/app/super-admin', 'src/app/admin'];

/** 画面に出る属性 */
const DISPLAY_ATTRIBUTES = new Set(['placeholder', 'title', 'alt', 'aria-label', 'label']);
/** 文言を持つプロパティ (ナビの項目・状態の札の表など) */
const COPY_PROPERTIES = new Set(['label', 'title', 'description', 'message', 'text', 'placeholder']);
/** 引数を利用者に見せる呼び出し */
const USER_FACING_CALL = /^(?:alert|confirm|set\w*(?:Error|Message))$/;

const LATIN = /[A-Za-z]/;
/** ひらがな・カタカナ・CJK 統合漢字 (拡張 A を含む)・全角の英数記号 */
const JAPANESE = /[぀-ヿ㐀-鿿＀-￯]/;

/**
 * 許可リスト: `<ファイル>\t<文字>` -> 理由。
 */
const ALLOWED: Record<string, string> = {
  'src/app/(org)/org/invites/page.tsx\tuser@example.com':
    '招待のメールアドレスの入力欄の placeholder。メールアドレスの書式の例で、訳す語ではない (例示用のドメイン example.com)',
};

interface CopyFinding {
  file: string;
  line: number;
  text: string;
}

function isEnglishOnly(text: string): boolean {
  return LATIN.test(text) && !JAPANESE.test(text);
}

/** 値の位置にある文字列を集める (式そのもの・三項の枝・&& / || / ?? の右・括弧・テンプレートの文字の部分) */
function collectValueStrings(node: ts.Node, out: ts.Node[]): void {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push(node);
  } else if (ts.isTemplateExpression(node)) {
    out.push(node.head);
    for (const span of node.templateSpans) out.push(span.literal);
  } else if (ts.isParenthesizedExpression(node)) {
    collectValueStrings(node.expression, out);
  } else if (ts.isConditionalExpression(node)) {
    collectValueStrings(node.whenTrue, out);
    collectValueStrings(node.whenFalse, out);
  } else if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      collectValueStrings(node.right, out);
      if (op !== ts.SyntaxKind.AmpersandAmpersandToken) collectValueStrings(node.left, out);
    }
  } else if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    collectValueStrings(node.expression, out);
  }
}

function literalText(node: ts.Node): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  return '';
}

function calleeName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

/** 1 つのソースから、画面に出る英語だけの文言を集める */
function findEnglishOnlyCopy(file: string, source: string): CopyFinding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: CopyFinding[] = [];

  const report = (node: ts.Node, text: string) => {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (!trimmed || !isEnglishOnly(trimmed)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ file, line: line + 1, text: trimmed });
  };
  const reportValues = (expression: ts.Node) => {
    const strings: ts.Node[] = [];
    collectValueStrings(expression, strings);
    for (const s of strings) report(s, literalText(s));
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      report(node, node.text);
    } else if (ts.isJsxExpression(node) && node.expression) {
      const parent = node.parent;
      if (ts.isJsxElement(parent) || ts.isJsxFragment(parent)) reportValues(node.expression);
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      if (DISPLAY_ATTRIBUTES.has(name)) {
        if (ts.isStringLiteral(node.initializer)) report(node.initializer, node.initializer.text);
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          reportValues(node.initializer.expression);
        }
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
      if (name && COPY_PROPERTIES.has(name)) reportValues(node.initializer);
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && USER_FACING_CALL.test(name) && node.arguments.length > 0) reportValues(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

/**
 * 内部の値をそのまま画面に出していると見なすプロパティ (DB の状態・役割の列。英字の値が入る)。
 * 役割は src/lib/membership/role-labels.ts の orgRoleLabel / familyRoleLabel に通して出す
 * (#2073: 設定のメンバーシップが組織の役割を「役割: owner」と出していた)
 */
const RAW_INTERNAL_VALUE_PROPERTIES = new Set(['status', 'role', 'org_role', 'invited_role']);

/**
 * 値の位置にあるプロパティの参照 (`x.status`・`x?.status`) と、同じ名前の変数そのもの (`status`。部品が状態を props で受けて
 * `ステータス: {status}` と出していた。#2080 U6) を集める (式そのもの・三項の枝・&& / || / ?? の右・括弧・テンプレートの式)
 */
function collectValuePropertyAccesses(node: ts.Node, out: (ts.PropertyAccessExpression | ts.Identifier)[]): void {
  if (ts.isPropertyAccessExpression(node) || ts.isIdentifier(node)) {
    out.push(node);
  } else if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) collectValuePropertyAccesses(span.expression, out);
  } else if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    collectValuePropertyAccesses(node.expression, out);
  } else if (ts.isConditionalExpression(node)) {
    collectValuePropertyAccesses(node.whenTrue, out);
    collectValuePropertyAccesses(node.whenFalse, out);
  } else if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      collectValuePropertyAccesses(node.right, out);
      if (op !== ts.SyntaxKind.AmpersandAmpersandToken) collectValuePropertyAccesses(node.left, out);
    }
  } else if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    collectValuePropertyAccesses(node.expression, out);
  }
}

/**
 * 1 つのソースから、内部の値 (状態の列) を JSX の子にそのまま出している箇所を集める (#2073 S5)。
 * 文字列の走査では値の中身 (accepted など) が見えないので、参照の形で見る。対応表の関数に通した値 (`statusLabel(x.status)`) や、
 * 比べる式 (`x.status === 'pending'`) は数えない
 */
function findRawInternalValueRendering(file: string, source: string): CopyFinding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: CopyFinding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const accesses: (ts.PropertyAccessExpression | ts.Identifier)[] = [];
      collectValuePropertyAccesses(node.expression, accesses);
      for (const access of accesses) {
        const name = ts.isIdentifier(access) ? access.text : access.name.text;
        if (!RAW_INTERNAL_VALUE_PROPERTIES.has(name)) continue;
        const { line } = sf.getLineAndCharacterOfPosition(access.getStart(sf));
        findings.push({ file, line: line + 1, text: access.getText(sf) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function listScreenFiles(roots: readonly string[] = SCAN_ROOTS): string[] {
  const result: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.tsx')) result.push(rel);
    }
  };
  for (const scanRoot of roots) walk(scanRoot);
  return result.sort();
}

/** 例外を受ける変数の名前 (tests/lib-raw-error-message-scan.test.ts と同じ規則) */
const ERROR_VARIABLE_NAME = /^(?:e|err|error|exception|ex)$|(?:Error|Err)$/;
/** 失敗の文を持つプロパティ (行の文 { ok, text }・知らせ { kind, message } など) */
const FAILURE_COPY_PROPERTIES = new Set(['message', 'text']);

/** 例外の文面を画面に出す式か (`err.message`・`err?.message`・`String(err)`) */
function isRawErrorText(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'message') {
    return ts.isIdentifier(node.expression) && ERROR_VARIABLE_NAME.test(node.expression.text);
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'String') {
    const [arg] = node.arguments;
    return arg !== undefined && ts.isIdentifier(arg) && ERROR_VARIABLE_NAME.test(arg.text);
  }
  return false;
}

/** 式の中 (入れ子の式・三項・?? を含む) の、例外の文面を出す式を集める */
function collectRawErrorTexts(node: ts.Node, out: ts.Node[]): void {
  if (isRawErrorText(node)) {
    out.push(node);
    return;
  }
  ts.forEachChild(node, (child) => collectRawErrorTexts(child, out));
}

/** `!x.ok` の条件か */
function isNotOkCondition(node: ts.Expression): boolean {
  const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
  return (
    ts.isPrefixUnaryExpression(inner) &&
    inner.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isPropertyAccessExpression(inner.operand) &&
    inner.operand.name.text === 'ok'
  );
}

/** `x.json()` の呼び出しが `.catch(…)` を付けずに使われているか */
function isUncaughtJsonCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || node.arguments.length > 0) return false;
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'json') return false;
  const parent = node.parent;
  return !(ts.isPropertyAccessExpression(parent) && parent.name.text === 'catch');
}

/** 1 つのソースから、運営の画面の失敗の文の違反 (F1・F2・F3) を集める (#2086 V6) */
function findFailureCopyViolations(file: string, source: string): CopyFinding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: CopyFinding[] = [];
  const push = (node: ts.Node, text: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ file, line: line + 1, text });
  };
  const checkShown = (expression: ts.Node) => {
    const strings: ts.Node[] = [];
    collectValueStrings(expression, strings);
    for (const literal of strings) {
      const trimmed = literalText(literal).replace(/\s+/g, ' ').trim();
      if (trimmed && isEnglishOnly(trimmed)) push(literal, `英語だけの文: ${trimmed}`);
    }
    const raw: ts.Node[] = [];
    collectRawErrorTexts(expression, raw);
    for (const node of raw) push(node, `例外の文面: ${node.getText(sf)}`);
  };
  const checkUncaughtJson = (node: ts.Node) => {
    if (isUncaughtJsonCall(node)) push(node, `!ok の中の .catch の無い本文の読み: ${node.getText(sf)}`);
    ts.forEachChild(node, checkUncaughtJson);
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && USER_FACING_CALL.test(name) && node.arguments.length > 0) checkShown(node.arguments[0]);
    } else if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
      if (name && FAILURE_COPY_PROPERTIES.has(name)) checkShown(node.initializer);
    } else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const raw: ts.Node[] = [];
      collectRawErrorTexts(node.expression, raw);
      for (const r of raw) push(r, `例外の文面: ${r.getText(sf)}`);
    } else if (ts.isIfStatement(node) && isNotOkCondition(node.expression)) {
      checkUncaughtJson(node.thenStatement);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

describe('走査の仕組み: 英語だけの文言を見つけられる', () => {
  const FIXTURE = `
    "use client";
    // コメントの Sign Out は見ない
    const items = [{ href: "/org/x", label: "Members" }, { href: "/org/y", label: "メンバー" }];
    export default function Page({ ok, name }: { ok: boolean; name?: string }) {
      if (!ok) alert("Failed to save");
      setErrorMessage(data.error?.message ?? "Network error");
      return (
        <div>
          <h1>Health Cockpit</h1>
          <p>
            Total Members
          </p>
          <span>{ok ? "Saved" : "保存できませんでした"}</span>
          <span>{name ?? "Unknown"}</span>
          <input placeholder="Search" title={"検索"} />
          <p>Email アドレス</p>
          <p>{status === "loaded" ? null : "—"}</p>
          <p>{\`\${3} users\`}</p>
        </div>
      );
    }
  `;

  it('JSX の文字・子の式の値・属性・プロパティ・利用者に見せる呼び出しの英語だけの文言を、行つきで見つける', () => {
    const texts = findEnglishOnlyCopy('fixture.tsx', FIXTURE).map((f) => f.text);
    expect(texts.sort()).toEqual(
      ['Members', 'Failed to save', 'Network error', 'Health Cockpit', 'Total Members', 'Saved', 'Unknown', 'Search', 'users'].sort(),
    );
  });

  it('比べる式・コメント・日本語の混じった文言・記号だけの文字は数えない', () => {
    const texts = findEnglishOnlyCopy('fixture.tsx', FIXTURE).map((f) => f.text);
    for (const ignored of ['loaded', 'Sign Out', 'Email アドレス', '—', '/org/x', 'use client']) {
      expect(texts).not.toContain(ignored);
    }
  });

  it('見つけた文言の行番号はソースの行', () => {
    const finding = findEnglishOnlyCopy('fixture.tsx', FIXTURE).find((f) => f.text === 'Health Cockpit');
    expect(finding?.line).toBe(FIXTURE.split('\n').findIndex((l) => l.includes('Health Cockpit')) + 1);
  });
});

describe('走査の仕組み: 内部の状態の値をそのまま出している箇所を見つけられる (#2073 S5)', () => {
  const FIXTURE = `
    export default function Page({ proposal, invite, x, orgInfo, c, member, status }: { proposal?: { status: string }; invite: { status: string; role: string }; x: { status: string }; orgInfo: { org_role: string }; c: { org_role: string | null }; member: { role: string }; status: string }) {
      return (
        <div>
          <p>この提案は既に処理されています (ステータス: {proposal?.status})</p>
          <p>{\`状態: \${invite.status}\`}</p>
          <p>{x.status === 'pending' ? '待機中' : null}</p>
          <span>{statusLabel(invite.status)}</span>
          <span className={x.status}>{'固定'}</span>
          <p>役割: {orgInfo.org_role}</p>
          <p>{c.org_role ?? '—'} &mdash; 最終ログイン</p>
          <p>{member.role}</p>
          <p>{orgRoleLabel(orgInfo.org_role)}</p>
          <p>{orgInfo.org_role === 'owner' ? 'オーナー' : null}</p>
          <span data-role={member.role}>{familyRoleLabel(member.role)}</span>
          <p>ステータス: {status}</p>
          <p>{statusLabel(status)}</p>
          <p>{status === 'pending' ? '未審査' : null}</p>
        </div>
      );
    }
  `;

  it('JSX の子に出している状態・役割の参照 (テンプレートの式・?? の左・同じ名前の変数そのものを含む) を見つけ、比べる式・関数に通した値・属性は数えない', () => {
    const texts = findRawInternalValueRendering('fixture.tsx', FIXTURE).map((f) => f.text);
    expect(texts.sort()).toEqual(['invite.status', 'proposal?.status', 'orgInfo.org_role', 'c.org_role', 'member.role', 'status'].sort());
  });
});

describe('組織の管理画面・家族の画面に英語だけの固定の文言が無い', () => {
  const files = listScreenFiles();
  const findings = files.flatMap((file) => findEnglishOnlyCopy(file, fs.readFileSync(path.join(ROOT, file), 'utf8')));

  it('走査する画面のファイルがある (サイドバーのレイアウトとダッシュボードを含む)', () => {
    expect(files).toContain('src/app/(org)/layout.tsx');
    expect(files).toContain('src/app/(org)/org/dashboard/page.tsx');
    expect(files).toContain('src/app/(main)/org/transfer-accept/[proposal_id]/page.tsx');
    expect(files).toContain('src/app/(main)/family/transfer-accept/[proposal_id]/page.tsx');
    expect(files).toContain('src/app/(main)/settings/membership/page.tsx');
  });

  it('URL が /org で始まる画面のディレクトリ (共通の定数の根の下) のファイルを、どれも走査している (#2073: 家族の画面の根を足しても組織の画面を落とさない)', () => {
    const orgDirs = orgUrlTopDirs();
    expect(orgDirs.length).toBeGreaterThan(0);
    const unscanned = orgDirs.filter((dir) => !files.some((file) => isUnderRoot(file, dir)));
    expect(unscanned).toEqual([]);
  });

  it('内部の状態・役割の値 (英字) を画面にそのまま出していない (#2073)', () => {
    const rawValueFiles = [...files, ...listScreenFiles(RAW_VALUE_ONLY_SCAN_ROOTS)];
    expect(rawValueFiles).toContain('src/app/(operator)/operator/membership/families/[id]/transfer/page.tsx');
    expect(rawValueFiles).toContain('src/app/(operator)/operator/membership/orgs/[id]/transfer/page.tsx');
    expect(rawValueFiles).toContain('src/app/admin/moderation/page.tsx');
    expect(rawValueFiles).toContain('src/app/admin/moderation/[type]/[id]/page.tsx');
    expect(rawValueFiles).toContain('src/components/operator/moderation/ModerationReviewForm.tsx');
    const rawRendering = rawValueFiles
      .flatMap((file) => findRawInternalValueRendering(file, fs.readFileSync(path.join(ROOT, file), 'utf8')))
      .map((f) => `${f.file}:${f.line} {${f.text}}`);
    expect(rawRendering).toEqual([]);
  });

  it('許可リストに無い英語だけの文言が無い', () => {
    const violations = findings
      .filter((f) => !(`${f.file}\t${f.text}` in ALLOWED))
      .map((f) => `${f.file}:${f.line} 「${f.text}」`);
    expect(violations).toEqual([]);
  });

  it('許可リストの行は、どれも実際にソースにある (使われていない行は外す)', () => {
    const found = new Set(findings.map((f) => `${f.file}\t${f.text}`));
    const stale = Object.keys(ALLOWED).filter((key) => !found.has(key));
    expect(stale).toEqual([]);
  });

  it('以前の英語の文言 (Sign Out・Health Cockpit・Total Members・users) は、どの画面にも出ない', () => {
    const texts = new Set(findings.map((f) => f.text));
    for (const removed of ['Sign Out', 'Health Cockpit', 'Total Members', 'users']) {
      expect(texts.has(removed), `「${removed}」が残っている`).toBe(false);
    }
  });
});

describe('走査の仕組み: 運営の画面の失敗の文の違反を見つけられる (#2086 V6)', () => {
  // #2086 V6 の前の機能フラグの画面の形 (本文の無い 502 の「HTTP 502」・例外の文面・JSON でない本文の SyntaxError)
  const FIXTURE = `
    async function load() {
      try {
        const res = await fetch("/api/super-admin/flags");
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error?.message ?? \`HTTP \${res.status}\`);
        }
        const safe = await res.json();
        if (!res.ok) {
          const tolerant = await res.json().catch(() => null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "読み込みに失敗しました");
        alert(\`HTTP \${res.status}\`);
        setNotice({ ok: false, text: String(e) });
        setError(displayableAdminError(err, "読み込みに失敗しました"));
        setError(\`機能フラグを読み込めませんでした (HTTP \${res.status})\`);
      }
      return <p>{error.message}</p>;
    }
  `;

  it('例外の文面・英語だけの文・!ok の中の .catch の無い本文の読みを、行つきで見つけ、日本語の文と部品に通した例外は数えない', () => {
    const findings = findFailureCopyViolations('fixture.tsx', FIXTURE);
    const lineOf = (needle: string) => FIXTURE.split('\n').findIndex((l) => l.includes(needle)) + 1;
    expect(findings.map((f) => `${f.line} ${f.text}`).sort()).toEqual(
      [
        `${lineOf('const body = await res.json();')} !ok の中の .catch の無い本文の読み: res.json()`,
        `${lineOf('err instanceof Error ? err.message')} 例外の文面: err.message`,
        `${lineOf('alert(')} 英語だけの文: HTTP`,
        `${lineOf('String(e)')} 例外の文面: String(e)`,
        `${lineOf('{error.message}')} 例外の文面: error.message`,
      ].sort(),
    );
  });
});

describe('運営の画面 (super-admin・admin) の失敗の文に英字の文・例外の文面が出ない (#2086 V6)', () => {
  const files = listScreenFiles(FAILURE_COPY_SCAN_ROOTS);

  it('走査する画面のファイルがある (#2086 V6 で直した画面を含む)', () => {
    for (const file of [
      'src/app/super-admin/flags/page.tsx',
      'src/app/super-admin/flags/new/page.tsx',
      'src/app/super-admin/experiments/page.tsx',
      'src/app/super-admin/experiments/[id]/page.tsx',
      'src/app/super-admin/llm/quotas/page.tsx',
      'src/app/admin/finance/exports/page.tsx',
      'src/app/admin/support/[id]/page.tsx',
    ]) {
      expect(files).toContain(file);
    }
  });

  it('失敗の文に英語だけの文・例外の文面が無く、失敗の応答の本文を .catch なしで読んでいない', () => {
    const violations = files
      .flatMap((file) => findFailureCopyViolations(file, fs.readFileSync(path.join(ROOT, file), 'utf8')))
      .map((f) => `${f.file}:${f.line} ${f.text}`);
    expect(violations).toEqual([]);
  });
});
