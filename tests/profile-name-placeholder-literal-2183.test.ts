// @vitest-environment node
/**
 * 仮置きの名前は共有の定数 PROFILE_NAME_PLACEHOLDER で書く (#2183 Z2-b)
 *
 * 問題:
 *   「名前が無い」ときに user_profiles.nickname へ入れる仮置き 'Guest' の正本は packages/shared/src/profile-name.ts の
 *   PROFILE_NAME_PLACEHOLDER で、「名前が無い」の判定 (normalizeProfileName) もこれと比べる。ところが入れる側
 *   (POST /api/profile・オンボーディングの保存と完了・モバイルの初期設定) は 'Guest' をリテラルで書いていたので、
 *   正本を変えると入れる値と判定がずれる。
 *
 * 決まり (このテストが固定する):
 *   1. 入れる側は PROFILE_NAME_PLACEHOLDER を参照し、'Guest' の文字列のリテラルを書かない
 *   2. Web・モバイル・共有のパッケージの製品コードに 'Guest' の文字列のリテラルは、正本と下の例外のほかに無い (コメントは数えない)
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PROFILE_NAME_PLACEHOLDER } from '@homegohan/shared';

const REPO_ROOT = path.resolve(__dirname, '..');

/** 仮置きの名前を入れる側 (#2183 Z2-b で定数の参照にしたもの) */
const PLACEHOLDER_WRITERS = [
  'src/app/api/profile/route.ts',
  'src/app/api/onboarding/progress/route.ts',
  'src/app/api/onboarding/complete/route.ts',
  'apps/mobile/app/onboarding/questions.tsx',
];

/** 走査する製品コードの根 */
const SCAN_ROOTS = ['src', 'lib', 'apps/mobile/app', 'apps/mobile/src', 'packages/shared/src', 'packages/core/src', 'packages/handson-tour-shared/src'];

/** 'Guest' のリテラルを書いてよいファイル → 理由 */
const LITERAL_ALLOWED: ReadonlyMap<string, string> = new Map([
  ['packages/shared/src/profile-name.ts', '仮置きの名前の正本 (PROFILE_NAME_PLACEHOLDER の定義)'],
  [
    'src/app/api/support/stats/route.ts',
    '運営の問い合わせの一覧で、名前の無い問い合わせ者に出す表示の既定の文言 (保存する仮置きではない。名前が無いかは normalizeProfileName で判定済み)',
  ],
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', '__tests__', '.next', 'dist']);

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(file);
}

function listSources(root: string): string[] {
  const absolute = path.join(REPO_ROOT, root);
  if (!fs.existsSync(absolute)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.posix.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) out.push(...listSources(relative));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts') && !isTestFile(entry.name)) {
      out.push(relative);
    }
  }
  return out;
}

/** ファイルの中の、値が target の文字列のリテラル (テンプレートの文字を含む。コメントは構文木に入らないので数えない) の行 */
function stringLiteralLines(file: string, target: string): number[] {
  const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  // 文字が 1 つも無いファイルは構文木を作らない (走査を速くする。リテラルがあれば必ず文字も含む)
  if (!source.includes(target)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === target) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    if (ts.isJsxText(node) && node.text.trim() === target) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

/** ファイルが PROFILE_NAME_PLACEHOLDER を @homegohan/shared から import して使っているか */
function importsAndUsesPlaceholder(file: string): boolean {
  const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let imported = false;
  let uses = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@homegohan/shared' &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some((element) => element.name.text === 'PROFILE_NAME_PLACEHOLDER')
    ) {
      imported = true;
    } else if (ts.isIdentifier(node) && node.text === 'PROFILE_NAME_PLACEHOLDER' && !ts.isImportSpecifier(node.parent)) {
      uses += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return imported && uses > 0;
}

describe('仮置きの名前は PROFILE_NAME_PLACEHOLDER で書く (#2183 Z2-b)', () => {
  it('正本の値は今までどおり Guest (挙動は変わらない)', () => {
    expect(PROFILE_NAME_PLACEHOLDER).toBe('Guest');
  });

  it.each(PLACEHOLDER_WRITERS)('%s は PROFILE_NAME_PLACEHOLDER を参照し、Guest のリテラルを書かない', (file) => {
    expect(stringLiteralLines(file, PROFILE_NAME_PLACEHOLDER)).toEqual([]);
    expect(importsAndUsesPlaceholder(file)).toBe(true);
  });

  it('製品コードに Guest のリテラルは、正本と例外のほかに無い', () => {
    const files = SCAN_ROOTS.flatMap(listSources);
    // 走査の根が消えて空振りしないこと (入れる側の 4 つは走査の範囲に入っている)
    for (const writer of PLACEHOLDER_WRITERS) expect(files, writer).toContain(writer);
    const offenders = files
      .filter((file) => !LITERAL_ALLOWED.has(file))
      .flatMap((file) => stringLiteralLines(file, PROFILE_NAME_PLACEHOLDER).map((line) => `${file}:${line}`));
    expect(offenders).toEqual([]);
  });

  it('例外のファイルには今も Guest のリテラルがある (要らなくなった例外を残さない)', () => {
    for (const file of LITERAL_ALLOWED.keys()) {
      expect(stringLiteralLines(file, PROFILE_NAME_PLACEHOLDER).length, file).toBeGreaterThan(0);
    }
  });
});
