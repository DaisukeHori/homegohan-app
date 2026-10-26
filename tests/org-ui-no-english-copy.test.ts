// @vitest-environment node
/**
 * 組織の管理画面 (src/app/(org) 配下と、管理画面の枠の外に置いた src/app/(main)/org 配下) に、英語だけの固定の文言が残っていないことのソース走査テスト
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
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
/**
 * 走査する画面のディレクトリ: 組織の管理画面のルートグループと、管理画面の枠の外に置いた組織の画面
 * (オーナーの譲渡の承諾の画面 /org/transfer-accept/[proposal_id]。一般メンバーも開くので (main) に置く。#2068)
 */
const SCAN_ROOTS = ['src/app/(org)', 'src/app/(main)/org'];

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

describe('組織の管理画面 (src/app/(org)) に英語だけの固定の文言が無い', () => {
  const files = listScreenFiles();
  const findings = files.flatMap((file) => findEnglishOnlyCopy(file, fs.readFileSync(path.join(ROOT, file), 'utf8')));

  it('走査する画面のファイルがある (サイドバーのレイアウトとダッシュボードを含む)', () => {
    expect(files).toContain('src/app/(org)/layout.tsx');
    expect(files).toContain('src/app/(org)/org/dashboard/page.tsx');
    expect(files).toContain('src/app/(main)/org/transfer-accept/[proposal_id]/page.tsx');
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
