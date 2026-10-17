/**
 * #1797 手動のプラン付与 段 C: /admin/users/{id} の page が節 ManualPlanGrantSection を、実行者が super_admin で対象が自分でないときだけ描く配線 (billing/02 §8.7・§10・テスト 34)
 *
 * ソースを TypeScript の構文木で読み (コメント・文字列の中は見ない)、次を見る:
 *   - ManualPlanGrantSection を '@/components/admin/ManualPlanGrantSection' から import している
 *   - canGrantManualPlan の定義が `isSuperAdmin && actor.id !== profile.id`
 *   - JSX の ManualPlanGrantSection がファイルに 1 つだけで、`canGrantManualPlan && <ManualPlanGrantSection userId={profile.id} />` の右辺として描かれる
 *   - isSuperAdmin は actor.roles.includes('super_admin') で作られ、requireRoleForPage の呼び出しは 1 つのまま (operator-page-guard-wiring が引数を見る)
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PAGE = 'src/app/admin/users/[id]/page.tsx';
const SECTION = 'ManualPlanGrantSection';
const SECTION_MODULE = '@/components/admin/ManualPlanGrantSection';
const GATE_NAME = 'canGrantManualPlan';
const GATE_EXPRESSION = 'isSuperAdmin && actor.id !== profile.id';
const IS_SUPER_ADMIN_EXPRESSION = "actor.roles.includes('super_admin')";

function load(): ts.SourceFile {
  const source = fs.readFileSync(path.join(ROOT, PAGE), 'utf-8');
  return ts.createSourceFile(PAGE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** 空白を 1 つにそろえたソース */
function textOf(node: ts.Node, sf: ts.SourceFile): string {
  return node.getText(sf).replace(/\s+/g, ' ');
}

function constInitializer(sf: ts.SourceFile, name: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found.push(textOf(node.initializer, sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('/admin/users/[id] の手動のプラン付与の節の配線 (#1797 段 C)', () => {
  it(`src/app/admin/users/[id]/page.tsx imports ${SECTION} and renders it only under isSuperAdmin && actor.id !== profile.id`, () => {
    const sf = load();

    // import
    const imports: string[] = [];
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const named = statement.importClause?.namedBindings;
      if (named && ts.isNamedImports(named) && named.elements.some((element) => element.name.text === SECTION)) {
        imports.push(statement.moduleSpecifier.text);
      }
    }
    expect(imports).toEqual([SECTION_MODULE]);

    // 出す条件: super_admin かつ対象が自分でない (isSuperAdmin は roles から作る)
    expect(constInitializer(sf, GATE_NAME)).toEqual([GATE_EXPRESSION]);
    expect(constInitializer(sf, 'isSuperAdmin')).toEqual([IS_SUPER_ADMIN_EXPRESSION]);

    // JSX: 節は 1 か所だけで、条件 && 節 の右辺。userId は対象の profile.id
    const jsx: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(sf) === SECTION) jsx.push(node);
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(jsx).toHaveLength(1);
    const element = jsx[0];
    const parent = element.parent;
    const guarded = ts.isJsxElement(parent) ? parent.parent : parent;
    expect(ts.isBinaryExpression(guarded)).toBe(true);
    const binary = guarded as ts.BinaryExpression;
    expect(binary.operatorToken.kind).toBe(ts.SyntaxKind.AmpersandAmpersandToken);
    expect(textOf(binary.left, sf)).toBe(GATE_NAME);
    expect(textOf(binary.right, sf)).toBe(`<${SECTION} userId={profile.id} />`);
    expect(ts.isJsxExpression(binary.parent)).toBe(true);
  });
});
