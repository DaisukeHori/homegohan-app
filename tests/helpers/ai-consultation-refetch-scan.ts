/**
 * AI 相談の取り直しの網羅の検査 (#2195 V1) が使う、ソースの静的な読み取り (TypeScript の構文木)。
 *
 * 読むもの:
 *   - 宣言の単位の依存: ある宣言 (関数・変数・クラス・case の節など) から、その中で名前で参照している
 *     同じファイルの最上位の宣言と、import した宣言 (src・lib・packages と supabase/functions の中のファイル) をたどる。
 *     JSX の部品 (<Foo />) も名前の参照として数える。import 先は、その名前の宣言だけをたどる (ファイルの全部はたどらない)
 *   - supabase の表の読み書き: `.from('<表>')` から続く連なりのメソッドで分ける
 *     (insert / update / upsert / delete があれば書き込み・select があれば読み取り・どちらも無ければ「不明」)。
 *     `.storage.from(...)` (ファイルの置き場) と Array.from / Buffer.from は数えない
 *   - API の URL: '/api/' で始まる文字列 (テンプレート文字列の式の部分は '*')
 *   - Edge Function の呼び出し: `.functions.invoke(...)`
 *
 * この読み取りの限界 (たどらないもの):
 *   - 名前の参照でない依存 (動的な import・文字列で組み立てた URL のうち '/api/' のリテラルを含まないもの・
 *     '/api/x' の定数に後ろを足した URL は、定数の部分の URL として数える)
 *   - 内側の範囲で同じ名前を付け直したもの (外の宣言を参照したものとして数える。多めに数える向き)
 *   - `.from(<変数>)` (表の名前がリテラルでないもの)・`.rpc(...)` の中で読み書きする表
 *   - node_modules と、パスの別名で解けない import
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export type TableAccessKind = 'read' | 'write' | 'unknown';

export interface TableAccess {
  table: string;
  kind: TableAccessKind;
  /**
   * 読み書きする列。読み取りは select の文字列の列 (埋め込みの関係の中は数えない)、書き込みは insert / update / upsert に
   * 渡したオブジェクトのリテラルのキー。'*'・リテラルでないもの・書き込みでない連なりは null (どの列もありうる)
   */
  columns: readonly string[] | null;
  /** 書き込みの値がリテラルでないとき、その式 (識別子なら名前)。検査が値の出どころを確かめるのに使う */
  writeArg: ts.Expression | null;
  /** リポジトリの根からの相対パスと行 (表示用) */
  at: string;
}

export interface ScanFindings {
  tables: TableAccess[];
  /** '/api/' で始まる URL の型 (テンプレートの式は '*'・? 以降は外す) */
  apiUrls: Set<string>;
  /** `.functions.invoke(...)` を呼んでいるか */
  invokesEdgeFunction: boolean;
  /** `.rpc('<名前>')` で呼んだ DB の関数 (名前 → 最初の場所)。名前が文字列の定数でも、定数の値に解く。解けないものは '?<式>' */
  rpcs: Map<string, string>;
  /** たどった宣言 (ファイル#名前) */
  visited: Set<string>;
}

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete']);
const READ_METHOD = 'select';
const NOT_TABLE_FROM_RECEIVERS = new Set(['Array', 'Buffer']);
const STORAGE_PROPERTY = 'storage';
const API_URL_PREFIX = '/api/';
const TEMPLATE_WILDCARD = '*';
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'] as const;
/** パスの別名 (tsconfig.json の paths・vitest.config.ts の resolve.alias と同じ) */
const PATH_ALIASES: readonly { prefix: string; bases: readonly string[] }[] = [
  { prefix: '@/', bases: ['src', '.'] },
  { prefix: '@homegohan/shared/', bases: ['packages/shared/src'] },
  { prefix: '@homegohan/core/', bases: ['packages/core/src'] },
];
const PACKAGE_ENTRIES: Readonly<Record<string, string>> = {
  '@homegohan/shared': 'packages/shared/src/index.ts',
  '@homegohan/core': 'packages/core/src/index.ts',
};
/** モジュールの最上位の文 (宣言でないもの。Deno.serve(...) など) を表す名前 */
const MODULE_INIT = '<module-init>';
/** 定数の値を解くときにたどる参照の数の上限 (import・別名の連なり。循環で止まらないための安全弁) */
const MAX_CONSTANT_HOPS = 8;
/** 名前空間の import (import * as x) を表す名前 */
const NAMESPACE = '*';

interface ImportBinding {
  spec: string;
  name: string;
}

interface ParsedModule {
  rel: string;
  sf: ts.SourceFile;
  decls: Map<string, ts.Node[]>;
  imports: Map<string, ImportBinding>;
  localExports: Map<string, string>;
  reexports: Map<string, ImportBinding>;
  starReexports: string[];
}

export class SourceScanner {
  private readonly modules = new Map<string, ParsedModule | null>();

  constructor(private readonly root: string) {}

  /** リポジトリの根からの相対パスのファイルを読む (無ければ null) */
  module(rel: string): ParsedModule | null {
    if (this.modules.has(rel)) return this.modules.get(rel) ?? null;
    const abs = path.join(this.root, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      this.modules.set(rel, null);
      return null;
    }
    const text = fs.readFileSync(abs, 'utf8');
    const kind = rel.endsWith('.tsx') || rel.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
    const parsed = indexModule(rel, sf);
    this.modules.set(rel, parsed);
    return parsed;
  }

  /** import の指定をリポジトリの中のファイルに解く (解けなければ null) */
  resolveSpec(fromRel: string, spec: string): string | null {
    if (spec in PACKAGE_ENTRIES) return PACKAGE_ENTRIES[spec];
    const candidates: string[] = [];
    if (spec.startsWith('.')) {
      candidates.push(path.posix.join(path.posix.dirname(fromRel), spec));
    } else {
      for (const alias of PATH_ALIASES) {
        if (!spec.startsWith(alias.prefix)) continue;
        const rest = spec.slice(alias.prefix.length);
        for (const base of alias.bases) candidates.push(path.posix.normalize(path.posix.join(base, rest)));
      }
    }
    for (const base of candidates) {
      const tries = [base, ...SOURCE_EXTENSIONS.map((ext) => base + ext), ...SOURCE_EXTENSIONS.map((ext) => `${base}/index${ext}`)];
      for (const t of tries) {
        const abs = path.join(this.root, t);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return t;
      }
    }
    return null;
  }

  newFindings(): ScanFindings {
    return { tables: [], apiUrls: new Set(), invokesEdgeFunction: false, rpcs: new Map(), visited: new Set() };
  }

  /** ファイルの名前付きの宣言 (export の名前。'default' も) からたどる */
  scanExport(rel: string, exportName: string, out: ScanFindings): void {
    const key = `${rel}#export:${exportName}`;
    if (out.visited.has(key)) return;
    out.visited.add(key);
    const mod = this.module(rel);
    if (!mod) return;
    if (exportName === NAMESPACE) {
      for (const name of mod.decls.keys()) this.scanDecl(mod, name, out);
      return;
    }
    if (mod.decls.has(exportName)) {
      this.scanDecl(mod, exportName, out);
      return;
    }
    const local = mod.localExports.get(exportName);
    if (local !== undefined) {
      this.scanName(mod, local, out);
      return;
    }
    const re = mod.reexports.get(exportName);
    if (re) {
      const target = this.resolveSpec(rel, re.spec);
      if (target) this.scanExport(target, re.name, out);
      return;
    }
    for (const spec of mod.starReexports) {
      const target = this.resolveSpec(rel, spec);
      if (target) this.scanExport(target, exportName, out);
    }
  }

  /** ファイルの全部 (最上位の宣言と文のすべて) からたどる */
  scanWholeModule(rel: string, out: ScanFindings): void {
    this.scanExport(rel, NAMESPACE, out);
  }

  /** 任意の節 (case の節など) からたどる。node は rel のファイルの構文木の一部 */
  scanNode(rel: string, node: ts.Node, out: ScanFindings): void {
    const mod = this.module(rel);
    if (!mod) return;
    this.walk(mod, node, out);
  }

  /** 式が文字列のリテラルか、文字列のリテラルで初期化した定数 (import した定数も) なら、その値 */
  stringValueOf(mod: ParsedModule, expr: ts.Expression, depth = 0): string | null {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (!ts.isIdentifier(expr) || depth > MAX_CONSTANT_HOPS) return null;
    return this.constantOf(mod, expr.text, depth + 1);
  }

  private constantOf(mod: ParsedModule, name: string, depth: number): string | null {
    for (const node of mod.decls.get(name) ?? []) {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        let init: ts.Expression = node.initializer;
        while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
        return this.stringValueOf(mod, init, depth);
      }
    }
    const local = mod.localExports.get(name);
    if (local !== undefined && local !== name) return this.constantOf(mod, local, depth + 1);
    const imp = mod.imports.get(name) ?? mod.reexports.get(name);
    const specs = imp ? [imp.spec] : mod.starReexports;
    for (const spec of specs) {
      const target = this.resolveSpec(mod.rel, spec);
      const tmod = target ? this.module(target) : null;
      if (!tmod) continue;
      const v = this.constantOf(tmod, imp ? imp.name : name, depth + 1);
      if (v !== null) return v;
    }
    return null;
  }

  private scanDecl(mod: ParsedModule, name: string, out: ScanFindings): void {
    const key = `${mod.rel}#${name}`;
    if (out.visited.has(key)) return;
    out.visited.add(key);
    for (const node of mod.decls.get(name) ?? []) this.walk(mod, node, out);
  }

  private scanName(mod: ParsedModule, name: string, out: ScanFindings): void {
    if (mod.decls.has(name)) {
      this.scanDecl(mod, name, out);
      return;
    }
    const imp = mod.imports.get(name);
    if (!imp) return;
    const target = this.resolveSpec(mod.rel, imp.spec);
    if (target) this.scanExport(target, imp.name, out);
  }

  private walk(mod: ParsedModule, node: ts.Node, out: ScanFindings): void {
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && isReference(n)) {
        this.scanName(mod, n.text, out);
      } else if (ts.isCallExpression(n)) {
        const access = tableAccessOf(n);
        if (access) {
          const { line } = mod.sf.getLineAndCharacterOfPosition(n.getStart(mod.sf));
          out.tables.push({ ...access, at: `${mod.rel}:${line + 1}` });
        }
        if (isEdgeFunctionInvoke(n)) out.invokesEdgeFunction = true;
        const rpcArg = rpcNameArgOf(n);
        if (rpcArg) {
          const name = this.stringValueOf(mod, rpcArg) ?? `?${rpcArg.getText(mod.sf)}`;
          if (!out.rpcs.has(name)) {
            const { line } = mod.sf.getLineAndCharacterOfPosition(n.getStart(mod.sf));
            out.rpcs.set(name, `${mod.rel}:${line + 1}`);
          }
        }
      } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        if (n.text.startsWith(API_URL_PREFIX)) out.apiUrls.add(normalizeUrl(n.text));
      } else if (ts.isTemplateExpression(n)) {
        if (n.head.text.startsWith(API_URL_PREFIX)) {
          const text = n.head.text + n.templateSpans.map((s) => TEMPLATE_WILDCARD + s.literal.text).join('');
          out.apiUrls.add(normalizeUrl(text));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }
}

function normalizeUrl(text: string): string {
  const cut = text.search(/[?#]/);
  return cut === -1 ? text : text.slice(0, cut);
}

/** 名前の参照か (プロパティの名前・宣言の名前・import の名前などは参照ではない) */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)) && p.name === id)
    return false;
  if (ts.isJsxAttribute(p) && p.name === id) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p) || ts.isExpressionWithTypeArguments(p)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

function tableAccessOf(call: ts.CallExpression): Omit<TableAccess, 'at'> | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'from') return null;
  const receiver = callee.expression;
  if (ts.isIdentifier(receiver) && NOT_TABLE_FROM_RECEIVERS.has(receiver.text)) return null;
  if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === STORAGE_PROPERTY) return null;
  const [arg] = call.arguments;
  if (!arg || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) return null;
  const methods: string[] = [];
  const calls: ts.CallExpression[] = [];
  let cur: ts.Node = call;
  while (
    cur.parent &&
    ts.isPropertyAccessExpression(cur.parent) &&
    cur.parent.expression === cur &&
    cur.parent.parent &&
    ts.isCallExpression(cur.parent.parent) &&
    cur.parent.parent.expression === cur.parent
  ) {
    methods.push(cur.parent.name.text);
    calls.push(cur.parent.parent);
    cur = cur.parent.parent;
  }
  const writeAt = methods.findIndex((m) => WRITE_METHODS.has(m));
  if (writeAt !== -1) {
    const payload = calls[writeAt].arguments[0];
    const literal = payload ? objectLiteralOf(payload) : null;
    return {
      table: arg.text,
      kind: 'write',
      columns: literal ? literalKeys(literal) : methods[writeAt] === 'delete' ? [] : null,
      writeArg: literal || !payload ? null : payload,
    };
  }
  const selectAt = methods.indexOf(READ_METHOD);
  if (selectAt !== -1) {
    const sel = calls[selectAt].arguments[0];
    const columns = sel === undefined ? null : ts.isStringLiteral(sel) || ts.isNoSubstitutionTemplateLiteral(sel) ? selectColumns(sel.text) : null;
    return { table: arg.text, kind: 'read', columns, writeArg: null };
  }
  return { table: arg.text, kind: 'unknown', columns: null, writeArg: null };
}

/** 配列のリテラルなら最初の要素 (insert / upsert の行の並び) */
function objectLiteralOf(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  let e = expr;
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  if (ts.isObjectLiteralExpression(e)) return e;
  if (ts.isArrayLiteralExpression(e) && e.elements.length > 0 && e.elements.every((el) => objectLiteralOf(el) !== null)) {
    return objectLiteralOf(e.elements[0]);
  }
  return null;
}

/** オブジェクトのリテラルのキー (広げた式 (...x) があればどの列もありうるので null) */
function literalKeys(obj: ts.ObjectLiteralExpression): string[] | null {
  const keys: string[] = [];
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) return null;
    const name = p.name;
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) keys.push(name.text);
    else return null;
  }
  return keys;
}

/**
 * select の文字列の列 (トップレベルだけ。埋め込み `rel(cols)` の中は別の表なので数えない)。
 * `別名:列`・`列::型`・`列->>キー` は列の名前だけにする。'*' があれば null (どの列もありうる)
 */
export function selectColumns(text: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let token = '';
  const flush = () => {
    const t = token.trim();
    token = '';
    if (t === '') return;
    if (t.includes('(')) return;
    const alias = /^[A-Za-z0-9_]+:(?!:)(.*)$/.exec(t);
    const body = alias ? alias[1] : t;
    out.push(body.split('::')[0].split('->')[0].trim());
  };
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      flush();
      continue;
    }
    token += ch;
  }
  flush();
  return out.includes('*') ? null : out;
}

function rpcNameArgOf(call: ts.CallExpression): ts.Expression | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'rpc') return null;
  return call.arguments[0] ?? null;
}

function isEdgeFunctionInvoke(call: ts.CallExpression): boolean {
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'invoke' &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === 'functions'
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name)));
}

function indexModule(rel: string, sf: ts.SourceFile): ParsedModule {
  const decls = new Map<string, ts.Node[]>();
  const imports = new Map<string, ImportBinding>();
  const localExports = new Map<string, string>();
  const reexports = new Map<string, ImportBinding>();
  const starReexports: string[] = [];
  const add = (name: string, node: ts.Node) => {
    const list = decls.get(name) ?? [];
    list.push(node);
    decls.set(name, list);
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      if (!clause || clause.isTypeOnly || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const spec = st.moduleSpecifier.text;
      if (clause.name) imports.set(clause.name.text, { spec, name: 'default' });
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) imports.set(nb.name.text, { spec, name: NAMESPACE });
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (el.isTypeOnly) continue;
          imports.set(el.name.text, { spec, name: (el.propertyName ?? el.name).text });
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue;
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      if (!st.exportClause) {
        if (spec) starReexports.push(spec);
        continue;
      }
      if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          if (el.isTypeOnly) continue;
          const local = (el.propertyName ?? el.name).text;
          if (spec) reexports.set(el.name.text, { spec, name: local });
          else localExports.set(el.name.text, local);
        }
      } else if (spec) {
        reexports.set(st.exportClause.name.text, { spec, name: NAMESPACE });
      }
      continue;
    }
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) {
      if (st.name) add(st.name.text, st);
      if (hasModifier(st, ts.SyntaxKind.DefaultKeyword)) add('default', st);
      continue;
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) for (const n of bindingNames(d.name)) add(n, d);
      continue;
    }
    if (ts.isEnumDeclaration(st)) {
      add(st.name.text, st);
      continue;
    }
    if (ts.isExportAssignment(st)) {
      add('default', st.expression);
      continue;
    }
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isModuleDeclaration(st)) continue;
    add(MODULE_INIT, st);
  }
  return { rel, sf, decls, imports, localExports, reexports, starReexports };
}

/** ディレクトリの中のファイルを再帰で並べる (リポジトリの根からの相対パス・/ 区切り) */
export function listFiles(root: string, relDir: string, accept: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(child);
      } else if (accept(child)) out.push(child);
    }
  };
  walk(relDir);
  return out.sort();
}

/** route.ts の場所を URL の区切りに直す (ルートのグループ (x) は URL に出ない) */
export function routeSegmentsOf(routeRel: string, apiRoot: string): string[] {
  const dir = path.posix.dirname(path.posix.relative(apiRoot, routeRel));
  return ['api', ...dir.split('/').filter((s) => s !== '' && s !== '.' && !/^\(.*\)$/.test(s))];
}

/**
 * URL の型 (テンプレートの式は '*') が route の区切りに当たるか。
 * '*' を含む区切りは動的な区切り ([id]) と catch-all にだけ当てる (静的な区切りには当てない。Next.js は静的な区切りを先に選ぶが、
 * 式の値は id などなので、静的な名前の route を指すことは無いとみなす)
 */
export function urlMatchesRoute(url: string, routeSegs: readonly string[]): boolean {
  const urlSegs = url.split('/').filter((s) => s !== '');
  for (let i = 0; i < routeSegs.length; i += 1) {
    const r = routeSegs[i];
    if (/^\[\[?\.\.\./.test(r)) return urlSegs.length >= i + (r.startsWith('[[') ? 0 : 1);
    const u = urlSegs[i];
    if (u === undefined) return false;
    const dynamic = /^\[.+\]$/.test(r);
    if (u.includes(TEMPLATE_WILDCARD)) {
      if (!dynamic) return false;
      continue;
    }
    if (!dynamic && u !== r) return false;
  }
  return urlSegs.length === routeSegs.length;
}

/** 文字列の値を持つ最上位の識別子 (switch の case のラベル) を case の節から取る */
export function caseLabelOf(clause: ts.CaseClause): string | null {
  const e = clause.expression;
  return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : null;
}

/** 関数 fnName の本体の switch (判別の式が discriminant の形のもの) の case の節を返す */
export function switchCasesOf(sf: ts.SourceFile, fnName: string, discriminant: string): ts.CaseClause[] {
  let found: ts.CaseClause[] = [];
  const visit = (n: ts.Node, inFn: boolean): void => {
    const nowIn = inFn || (ts.isFunctionDeclaration(n) && n.name?.text === fnName);
    if (nowIn && ts.isSwitchStatement(n) && n.expression.getText(sf) === discriminant) {
      found = n.caseBlock.clauses.filter(ts.isCaseClause);
      return;
    }
    ts.forEachChild(n, (c) => visit(c, nowIn));
  };
  visit(sf, false);
  return found;
}
