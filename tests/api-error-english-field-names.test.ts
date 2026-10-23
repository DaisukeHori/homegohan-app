// @vitest-environment node
/**
 * API の失敗の本文の文に、英字の項目名・役割名を括弧の外に出さないことの見張り (#1917 の続き)
 *
 * 問題:
 *   全 API の走査 (tests/api-error-japanese-scan.test.ts) は「日本語を 1 文字も含まない文」だけを違反にするので、
 *   'id の形式が正しくありません'・'family_id は必須です'・'永久 BAN は super_admin のみ実行可能です' のように、
 *   日本語の文に英字の項目名・役割名だけが混じった文は通る。異常な入力のときだけ、こうした文が画面に出うる。
 *   /api/org だけは tests/org-api-error-role-names.test.ts が見ていたが、ほかの配下には見張りが無かった。
 *
 * 決まり:
 *   項目名は「日本語の名前 (英字の項目名)」の形で、英字の項目名を括弧に入れて添える (src/lib/health-api-messages.ts の
 *   healthFieldLabel・'日付 (date)' と同じ形)。API を呼ぶ人が直す場所を探せるように英字の項目名は残すが、括弧の外は日本語にする。
 *
 * このテストが確かめること (構文木で読む。コメントとログの文は見ない):
 *   1. 判定 (englishIdentifiersOutsideParentheses) と走査 (findErrorTexts) が、以前の文と自前の本文の関数の文を拾い、
 *      括弧に入れた項目名・大文字の語・形式の名前・JSON の値は拾わない
 *   2. src/app/api の全 route (相手が機械の配下を除く) の失敗の本文の文に、括弧の外の英字の項目名・役割名が無い
 *   3. 自前の本文の関数の一覧 (ROUTE_ERROR_TEXT_CALLS) の関数が実在し、その位置の引数が文 (message) である
 * 限界: 本文の文を表 (オブジェクト) から引くもの・関数の戻り値で作るもの・入力の検証の関数が返す文は見ない
 *   (健康の記録の入力の検証は tests/health-api-messages.test.ts が値で確かめる)。見張りであって網羅の証明ではない。
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  API_ROUTES_ROOT,
  englishIdentifiersOutsideParentheses,
  findErrorTexts,
  isUnderDir,
  routeFilesUnder,
  sourceOf,
  walkFiles,
} from './helpers/api-error-text-scan';
import { MACHINE_FACING_ERROR_TEXT_PATHS } from './helpers/api-error-japanese-scope';

/**
 * route の中で失敗の本文を作る自前の関数と、その文の引数の位置 (0 から数える)。
 * 走査の部品の既定 (challengeError) に加えて見る。新しく `function xxx(status, code, message)` のような関数で本文を作るなら、ここに足す
 */
const ROUTE_ERROR_TEXT_CALLS: ReadonlyMap<string, number> = new Map([
  ['errorResponse', 2],
  ['errorBody', 1],
  ['errorJson', 1],
  ['badRequest', 0],
  ['notSupportedResponse', 0],
]);
/** 自前の本文の関数を探す配下 */
const TEXT_CALL_SOURCE_DIRS = ['src/app/api', 'src/lib'] as const;
/** 本文の文を受け取る引数の名前 */
const MESSAGE_PARAMETER_NAME = 'message';

const isMachineFacing = (file: string) =>
  MACHINE_FACING_ERROR_TEXT_PATHS.some(({ path: p }) => file === p || isUnderDir(file, p));

const violationsOf = (files: readonly string[]) =>
  files
    .flatMap((file) => findErrorTexts(file, { extraTextCalls: ROUTE_ERROR_TEXT_CALLS }))
    .filter((found) => englishIdentifiersOutsideParentheses(found.text).length > 0)
    .map((found) => `${found.file}:${found.line} 「${found.text}」`);

describe('判定: 括弧の外の英字の項目名・役割名', () => {
  it('以前の文を拾う', () => {
    expect(englishIdentifiersOutsideParentheses('id の形式が正しくありません')).toEqual(['id']);
    expect(englishIdentifiersOutsideParentheses('family_id と to_user_id は必須です')).toEqual(['family_id', 'to_user_id']);
    expect(englishIdentifiersOutsideParentheses('永久 BAN は super_admin のみ実行可能です')).toEqual(['super_admin']);
    expect(englishIdentifiersOutsideParentheses('指定した owner は退会の手続き中です')).toEqual(['owner']);
    expect(englishIdentifiersOutsideParentheses('ratingは1〜5の整数で入力してください')).toEqual(['rating']);
    expect(englishIdentifiersOutsideParentheses('daily_note は文字列か null で指定してください')).toEqual(['daily_note']);
  });

  it('括弧に入れた項目名・大文字の語・形式の名前・JSON の値・日本語を含まない文は拾わない', () => {
    for (const ok of [
      'ID (id) の形式が正しくありません',
      '家族のグループ (family_id) と譲渡先の利用者 (to_user_id) は必須です',
      '永久 BAN はスーパー管理者 (super_admin) のみ実行可能です',
      '日付 (date)はYYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付で指定してください',
      '1 日のメモ (daily_note) は文字列か null で指定してください',
      '通知 (enabled) は true か false で指定してください',
      '下書き (draft) のプランは PATCH API で価格を変更してください',
      '通知のトークン (expo_push_token) が Expo の通知のトークンの形ではありません',
      '全角の括弧の中（family_id）も括弧の中',
      '入れ子 (外 (family_id) の中) も括弧の中',
      'Unauthorized',
    ]) {
      expect(englishIdentifiersOutsideParentheses(ok), ok).toEqual([]);
    }
  });
});

describe('走査: 自前の本文の関数の文も集める', () => {
  const FIXTURE_FILE = 'src/app/api/__fixture__/route.ts';
  const FIXTURE = `
    import { NextResponse } from 'next/server';
    function errorResponse(status: number, code: string, message: string) {
      return NextResponse.json({ error: { code, message } }, { status });
    }
    export async function POST() {
      if (a) return errorResponse(400, 'VALIDATION_ERROR', 'id が不正です');
      if (b) return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'family_id は必須です' } }, { status: 400 });
      if (c) return NextResponse.json({ error: '組織の名前 (name) は必須です' }, { status: 400 });
      console.error('family_id のログは見ない');
      return NextResponse.json({ ok: true });
    }
  `;

  it('route の本文の文と errorResponse の文を拾い、括弧に入れた項目名とログは拾わない', () => {
    const found = findErrorTexts(FIXTURE_FILE, { extraTextCalls: ROUTE_ERROR_TEXT_CALLS, text: FIXTURE })
      .filter((f) => englishIdentifiersOutsideParentheses(f.text).length > 0)
      .map((f) => f.text);
    expect(found.sort()).toEqual(['family_id は必須です', 'id が不正です'].sort());
  });

  it('既定の走査 (追加の関数なし) は errorResponse の文を見ない (追加の一覧が要る理由)', () => {
    const texts = findErrorTexts(FIXTURE_FILE, { text: FIXTURE }).map((f) => f.text);
    expect(texts).not.toContain('id が不正です');
    expect(texts).toContain('family_id は必須です');
  });
});

describe('自前の本文の関数の一覧 (ROUTE_ERROR_TEXT_CALLS) は実在する', () => {
  const files = TEXT_CALL_SOURCE_DIRS.flatMap((dir) => walkFiles(dir, (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)));

  it.each([...ROUTE_ERROR_TEXT_CALLS])('%s は、%i 番目 (0 から) の引数が message の関数として宣言されている', (name, index) => {
    const declarations: ts.FunctionDeclaration[] = [];
    for (const file of files) {
      for (const statement of sourceOf(file).statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) declarations.push(statement);
      }
    }
    expect(declarations.length, name).toBeGreaterThan(0);
    for (const declaration of declarations) {
      const parameter = declaration.parameters[index];
      expect(parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : null, name).toBe(MESSAGE_PARAMETER_NAME);
    }
  });
});

describe('src/app/api の失敗の本文の文に、括弧の外の英字の項目名・役割名が無い', () => {
  const files = routeFilesUnder(API_ROUTES_ROOT).filter((file) => !isMachineFacing(file));

  it('走査する route がある (健康の記録・家族・運営・super_admin を含む)', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'src/app/api/health/checkups/[id]/route.ts',
        'src/app/api/family/members/[member_id]/remove/route.ts',
        'src/app/api/admin/organizations/route.ts',
        'src/app/api/super-admin/settings/route.ts',
      ]),
    );
  });

  it('違反が 0 件', () => {
    expect(violationsOf(files)).toEqual([]);
  });
});
