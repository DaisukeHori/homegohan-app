/**
 * #1435 規約の同意まわりのテストは、環境変数を vi.stubEnv (+ stubSupabasePublicEnv) で入れる
 *
 * 以前は流儀が 3 通りあった (process.env の直接の書き換え・`delete process.env.X`・vi.stubEnv)。
 * 直接の書き換えと delete は vi.unstubAllEnvs で元に戻らないので、テストを動かした環境の値 (開発者のシェルの
 * LEGAL_CONSENT_ENFORCE など) を消したり書き換えたりしたまま、ほかのテストへ漏らす。
 * 未設定を作るときも vi.stubEnv(name, undefined) にする (unstubAllEnvs で元の値に戻る)。
 *
 * 対象は、名前に legal-consent を含むテスト (tests/ と lib/supabase/__tests__/) と、同意の経路のテスト
 * (auth-callback-legal-consent・signup-legal-consent)。全リポジトリの一括の書き換えはしない (この Issue の範囲外)。
 *
 * 走査は TypeScript の構文木で行うので、コメントや文字列の中の `delete process.env.X` には反応しない。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** 走査するテストの置き場と、ファイル名の条件 */
const SCAN_DIRS = ['tests', path.join('lib', 'supabase', '__tests__')];
const TARGET_NAME_PATTERN = /legal-consent.*\.test\.tsx?$/;

/** 走査の対象に必ず入っているはずのファイル (置き場や名前が変わって空振りしないための番兵) */
const MUST_INCLUDE = [
  path.join('tests', 'legal-consent-gate.test.ts'),
  path.join('tests', 'legal-consent-banner.test.tsx'),
  path.join('tests', 'signup-legal-consent.test.tsx'),
  path.join('tests', 'auth-callback-legal-consent.test.ts'),
  path.join('lib', 'supabase', '__tests__', 'middleware-legal-consent.test.ts'),
  path.join('lib', 'supabase', '__tests__', 'middleware-legal-consent-matrix.test.ts'),
];

function parse(source: string, fileName: string) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** `process.env` そのものか */
function isProcessEnv(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'env' &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process'
  );
}

/** `process.env.X` / `process.env['X']` か */
function isProcessEnvMember(node: ts.Expression): boolean {
  return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isProcessEnv(node.expression);
}

/** 代入の演算子 (=, ??=, ||= など) か */
function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/**
 * process.env を直接書き換えている箇所の行番号 (1 始まり):
 * `delete process.env.X` と、`process.env.X = ...` (`process.env['X'] = ...` と複合代入を含む)
 */
function findDirectEnvWrites(source: string, fileName = 'file.ts'): number[] {
  const sf = parse(source, fileName);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    const isDelete = ts.isDeleteExpression(node) && isProcessEnvMember(node.expression);
    const isAssign =
      ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind) && isProcessEnvMember(node.left);
    if (isDelete || isAssign) lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

function collectTargetFiles(): string[] {
  return SCAN_DIRS.flatMap((dir) =>
    fs
      .readdirSync(path.join(ROOT, dir))
      .filter((name) => TARGET_NAME_PATTERN.test(name))
      .map((name) => path.join(dir, name)),
  );
}

describe('findDirectEnvWrites (検出の仕組み)', () => {
  it('delete・代入・添字・複合代入を見つけ、読み取り・vi.stubEnv・コメント・文字列は見つけない', () => {
    const source = [
      'delete process.env.A;', // 1
      "process.env.B = 'on';", // 2
      "process.env['C'] = 'on';", // 3
      "process.env.D ??= 'x';", // 4
      "delete process.env['E'];", // 5
      'const f = process.env.F;', // 6: 読み取り
      "vi.stubEnv('G', undefined);", // 7
      '// delete process.env.H;', // 8: コメント
      "const s = 'process.env.I = 1';", // 9: 文字列
      "if (process.env.J === 'on') {}", // 10: 比較
    ].join('\n');

    expect(findDirectEnvWrites(source)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('規約の同意まわりのテストは、環境変数を vi.stubEnv で入れる (#1435)', () => {
  const files = collectTargetFiles();

  it('走査の対象が空でない (置き場や名前が変わっても空振りしない)', () => {
    for (const file of MUST_INCLUDE) expect(files, `${file} が走査の対象に入っている`).toContain(file);
  });

  it('process.env を直接書き換えていない (delete process.env.X・process.env.X = ... が 0 件)', () => {
    const offenders = files.flatMap((file) =>
      findDirectEnvWrites(fs.readFileSync(path.join(ROOT, file), 'utf-8'), file).map((line) => `${file}:${line}`),
    );

    // 失敗したら vi.stubEnv(name, value) に置き換える。未設定は vi.stubEnv(name, undefined)。
    // 戻すのは afterEach(() => vi.unstubAllEnvs())。Supabase の公開用の変数が要るなら stubSupabasePublicEnv() を呼ぶ
    expect(offenders).toEqual([]);
  });
});
