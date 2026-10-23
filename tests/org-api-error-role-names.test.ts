// @vitest-environment node
/**
 * /api/org の失敗の本文の文に、英字の役割名・項目名 (owner / admin / member / name / id / user_id / role) を出さないことの見張り (#1917)
 *
 * 問題:
 *   全 API の走査 (tests/api-error-japanese-scan.test.ts) は「日本語を 1 文字も含まない文」だけを違反にするので、
 *   'owner/admin のみ招待可能です'・'name は必須です'・'id は必須です' のように、日本語に英字の役割名・項目名が混じった文は通る。
 *   組織の管理画面は本文の文をそのまま見せることがあるため、英字の役割名を日本語 (オーナー・管理者・部署の名前 など) にした。
 *
 * このテストが確かめること (構文木で読む。コメントとログの文は見ない):
 *   1. /api/org の route の本文 (`NextResponse.json` / `Response.json` の 1 つ目の引数と challengeError の文) の中の文字列
 *   2. /api/org が import する本文の文の定数のファイル (src/lib/org-api-errors.ts) の文字列
 *   3. 招待の本文の項目ごとの文の表 (src/lib/membership/org-invite.ts の INVALID_BODY_MESSAGES。表を引く形は全 API の走査が見ない)
 *   のうち日本語を含むものに、英字の役割名・項目名が単語として入っていない。
 * 限界: 本文の文を別の関数の戻り値で作るもの (上の 3 以外) は見ない。見張りであって網羅の証明ではない。
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { JAPANESE, routeFilesUnder, sourceOf } from './helpers/api-error-text-scan';

/** 英字の役割名・項目名 (単語として。'ownership_transfer' や 'ID' は含まない) */
const ENGLISH_ROLE_OR_FIELD = /(?<![A-Za-z0-9_])(owner|admin|member|name|id|user_id|role|organization_id|department_id)(?![A-Za-z0-9_])/;
const ORG_API_DIR = 'src/app/api/org';
const ORG_MESSAGE_CONSTANT_FILES = ['src/lib/org-api-errors.ts'] as const;
const ORG_INVITE_FILE = 'src/lib/membership/org-invite.ts';
const ORG_INVITE_MESSAGE_TABLE = 'INVALID_BODY_MESSAGES';
const RESPONSE_CLASSES = new Set(['NextResponse', 'Response']);
/** 本文の文を引数で受け取る関数と、その文の引数の位置 (tests/helpers/api-error-text-scan.ts の BODY_TEXT_CALLS と同じ) */
const BODY_TEXT_CALLS: ReadonlyMap<string, number> = new Map([['challengeError', 1]]);

interface FoundText {
  file: string;
  line: number;
  text: string;
}

/** node の下の文字列 (テンプレートは文字の部分をつなぐ) を集める */
function textsUnder(file: string, sf: ts.SourceFile, node: ts.Node, out: FoundText[]): void {
  const push = (text: string, at: ts.Node) =>
    out.push({ file, line: sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1, text });
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) push(n.text, n);
    else if (ts.isTemplateExpression(n)) push([n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(' '), n);
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/** route の本文の中の文字列 */
function responseBodyTexts(file: string): FoundText[] {
  const sf = sourceOf(file);
  const out: FoundText[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'json' &&
        ts.isIdentifier(callee.expression) &&
        RESPONSE_CLASSES.has(callee.expression.text) &&
        node.arguments[0]
      ) {
        textsUnder(file, sf, node.arguments[0], out);
      } else if (ts.isIdentifier(callee)) {
        const index = BODY_TEXT_CALLS.get(callee.text);
        const arg = index === undefined ? undefined : node.arguments[index];
        if (arg) textsUnder(file, sf, arg, out);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** ファイルの `export const 名前 = '…'` の文字列 */
function exportedConstTexts(file: string): FoundText[] {
  const sf = sourceOf(file);
  const out: FoundText[] = [];
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (decl.initializer && (ts.isStringLiteral(decl.initializer) || ts.isNoSubstitutionTemplateLiteral(decl.initializer))) {
        textsUnder(file, sf, decl.initializer, out);
      }
    }
  }
  return out;
}

/** ファイルの `const 名前 = { … }` の表の中の文字列 (表が無ければ空) */
function constTableTexts(file: string, name: string): FoundText[] {
  const sf = sourceOf(file);
  const out: FoundText[] = [];
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) textsUnder(file, sf, decl.initializer, out);
    }
  }
  return out;
}

const withEnglishRoleOrField = (found: readonly FoundText[]) =>
  found
    .filter((f) => JAPANESE.test(f.text) && ENGLISH_ROLE_OR_FIELD.test(f.text))
    .map((f) => `${f.file}:${f.line} 「${f.text}」`);

describe('英字の役割名・項目名の判定', () => {
  it('以前の文を拾い、日本語の役割名・大文字の ID・別の語の一部は拾わない', () => {
    for (const old of ['owner/admin のみ招待可能です', 'owner のみ譲渡提案が可能です', 'name は必須です (100 文字以内)', 'id は必須です', 'user_id が必要です', 'role は admin または member のみ指定できます']) {
      expect(ENGLISH_ROLE_OR_FIELD.test(old), old).toBe(true);
    }
    for (const ok of ['オーナー・管理者だけが招待できます', 'チャレンジの ID を指定してください', 'ownership_transfer_proposals の行が見つかりません', '開始日と終了日は YYYY-MM-DD の形式で']) {
      expect(ENGLISH_ROLE_OR_FIELD.test(ok), ok).toBe(false);
    }
  });
});

describe('/api/org の失敗の本文の文に、英字の役割名・項目名が無い', () => {
  const routeFiles = routeFilesUnder(ORG_API_DIR);
  const routeTexts = routeFiles.flatMap(responseBodyTexts);

  it('走査する route と文がある (招待・除名・譲渡の提案・部署を含む)', () => {
    expect(routeFiles).toEqual(
      expect.arrayContaining([
        'src/app/api/org/members/route.ts',
        'src/app/api/org/invites/route.ts',
        'src/app/api/org/invites/[id]/revoke/route.ts',
        'src/app/api/org/members/[user_id]/remove/route.ts',
        'src/app/api/org/owner-transfer/propose/route.ts',
        'src/app/api/org/departments/route.ts',
      ]),
    );
    expect(routeTexts.some((f) => f.text.startsWith('部署の名前を入力してください'))).toBe(true);
    expect(routeTexts.some((f) => f.text === '部署を指定してください')).toBe(true);
  });

  it('route の本文の文', () => {
    expect(withEnglishRoleOrField(routeTexts)).toEqual([]);
  });

  it('本文の文の定数 (src/lib/org-api-errors.ts)', () => {
    const texts = ORG_MESSAGE_CONSTANT_FILES.flatMap(exportedConstTexts);
    expect(texts.map((f) => f.text)).toEqual(
      expect.arrayContaining([
        'オーナー・管理者だけが招待できます',
        'オーナー・管理者だけがメンバーを除名できます',
        'オーナー・管理者だけが招待を取り消せます',
        'オーナーだけが譲渡を提案できます',
      ]),
    );
    expect(withEnglishRoleOrField(texts)).toEqual([]);
  });

  it('招待の本文の項目ごとの文の表 (src/lib/membership/org-invite.ts)', () => {
    const texts = constTableTexts(ORG_INVITE_FILE, ORG_INVITE_MESSAGE_TABLE);
    expect(texts.map((f) => f.text)).toContain('役割は「管理者」か「メンバー」を指定してください');
    expect(withEnglishRoleOrField(texts)).toEqual([]);
  });
});
