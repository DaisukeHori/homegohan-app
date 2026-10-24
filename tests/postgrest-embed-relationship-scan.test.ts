// @vitest-environment node
/**
 * #1917 src の select の埋め込み (`rel(cols)`) が、PostgREST が解決できる関係かの「見張り」
 *
 * 問題:
 *   PostgREST は埋め込みの関係を外部キーで見つける。外部キーが無い関係の埋め込みは PGRST200、外部キーが 2 本以上あって
 *   どれか決まらない埋め込みは PGRST201 で、その select はいつも失敗する。DB をモックする単体テストではこれが見えない。
 *   レシピの API が `user_profiles(nickname)` (recipes / recipe_comments の user_id の外部キーは auth.users 宛) と
 *   `recipe_likes(user_id)` (recipe_likes → recipes の外部キーは recipe_id・recipe_uuid の 2 本) を埋め込んでいたため、
 *   一覧はログイン中いつも空 (失敗を空の 200 で隠していた)、詳細とコメントはいつも 500 になっていた。
 *
 * 決まり:
 *   埋め込みは、外部キーでちょうど 1 本につながった関係にだけ使う。2 本以上あるときは `!<外部キー名>` か `!<列名>` で 1 本に絞る。
 *   つながっていないもの (user_profiles の名前など) は、別のクエリで引く (src/lib/recipes/viewer-lookups.ts・src/app/api/support/stats/route.ts)。
 *
 * 数えるもの (TypeScript の構文木で読む。コメント・ほかの文字列は見ない):
 *   `.from('<テーブル>')` から続く `.select('<文字列>')` の埋め込みを (入れ子も) 読み、スキーマの模型
 *   (tests/helpers/schema-snapshot.ts: 本番スキーマのベースライン + それより新しい migration) の public の外部キーで関係を数える。
 *   親から埋め込み先への外部キー (多対一) と、埋め込み先から親への外部キー (一対多) を合わせて
 *   - 0 本で、両方を指す外部キーを持つ中間のテーブルも無い → PGRST200
 *   - 2 本以上 (ヒントで 1 本に絞っていない) → PGRST201
 *   `!inner` / `!left` は結合の種類なので、絞り込みのヒントに数えない。
 *
 * この検査の限界 (捕まえない・数えないもの。網羅は目指さない):
 *   - select の引数が文字列リテラルでないもの (変数・式の入ったテンプレート文字列)
 *   - from と select が 1 つの式の連なりでないもの (`const q = db.from('t'); q.select(...)`)
 *   - スキーマの模型に無いテーブル・ビュー (migration の解析はベストエフォート) と、自分自身への埋め込み — 数えずに飛ばす
 *   - 外部キーの名前は Postgres の既定の名前 (<テーブル>_<列>_fkey) だけを知っている (それ以外の名前のヒントは 0 本に見える)
 *   - 中間のテーブルを通す関係 (多対多) は、両方への外部キーを持つテーブルがあれば解決できるとみなす (主キーの条件は見ない)
 *   - supabase/functions (Edge Function) は走査しない
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { loadSchemaModel, type SchemaTable } from './helpers/schema-snapshot';

const ROOT = path.resolve(__dirname, '..');
/** 走査する場所 (アプリのコード。テストは除く) */
const SCAN_ROOTS = ['src', 'lib'];
/** 結合の種類のヒント (関係を絞るヒントではない) */
const JOIN_HINTS = new Set(['inner', 'left']);
/**
 * src の全域で確かめた埋め込みの数の下限。検査が何も読まずに緑になるのを防ぐ (2026-10-24 の時点で 60 を超える。
 * 埋め込みを減らしてこれを割ったら、実数を数え直して下げる)
 */
const MIN_CHECKED_EMBEDS = 40;

const schema: Map<string, SchemaTable> = loadSchemaModel();

interface Finding {
  file: string;
  line: number;
  code: 'PGRST200' | 'PGRST201';
  text: string;
}

interface ScanResult {
  findings: Finding[];
  /** 関係を確かめた埋め込みの数 */
  checked: number;
}

interface Relationship {
  /** 外部キーを持つテーブル */
  fkTable: string;
  /** 外部キーの列 */
  column: string;
}

function listSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** supabase-js と同じく、引用符の外の空白を除く */
function stripWhitespace(select: string): string {
  let quoted = false;
  let out = '';
  for (const ch of select) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && /\s/.test(ch)) continue;
    out += ch;
  }
  return out;
}

/** 括弧の外にあるカンマで分ける */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

interface Embed {
  relation: string;
  hints: string[];
  columns: string;
}

/** 'alias:rel!hint!inner(cols)' (先頭の '...' も可) を分ける。埋め込みでなければ null */
function parseEmbed(item: string): Embed | null {
  const text = item.startsWith('...') ? item.slice('...'.length) : item;
  const open = text.indexOf('(');
  if (open < 0 || !text.endsWith(')')) return null;
  const head = text.slice(0, open).match(/^(?:[A-Za-z_]\w*:)?([A-Za-z_]\w*)((?:![A-Za-z_]\w*)*)$/);
  if (!head) return null;
  return { relation: head[1], hints: head[2].split('!').filter(Boolean), columns: text.slice(open + 1, -1) };
}

const isPublicRefTo = (table: string) => (fk: { refSchema: string; refTable: string }) =>
  fk.refSchema === 'public' && fk.refTable === table;

/** parent と relation を直接つなぐ外部キー (多対一と一対多) */
function directRelationships(parent: SchemaTable, relation: SchemaTable): Relationship[] {
  return [
    ...parent.foreignKeys.filter(isPublicRefTo(relation.name)).map((fk) => ({ fkTable: parent.name, column: fk.column })),
    ...relation.foreignKeys.filter(isPublicRefTo(parent.name)).map((fk) => ({ fkTable: relation.name, column: fk.column })),
  ];
}

/** parent と relation の両方への外部キーを持つ、ほかのテーブル (多対多の中間) があるか */
function hasJunction(parent: string, relation: string): boolean {
  for (const table of schema.values()) {
    if (table.name === parent || table.name === relation) continue;
    if (table.foreignKeys.some(isPublicRefTo(parent)) && table.foreignKeys.some(isPublicRefTo(relation))) return true;
  }
  return false;
}

/** ヒントが外部キーの列名か、Postgres の既定の外部キー名 (<テーブル>_<列>_fkey) か */
function hintMatches(relationship: Relationship, hint: string): boolean {
  return hint === relationship.column || hint === `${relationship.fkTable}_${relationship.column}_fkey`;
}

/** select の文字列の埋め込みを (入れ子も) 確かめる。parent が模型に無ければ何もしない */
function checkSelect(
  parentName: string,
  select: string,
  report: (code: Finding['code'], text: string) => void,
): number {
  const parent = schema.get(parentName);
  if (!parent) return 0;
  let checked = 0;
  for (const item of splitTopLevel(select)) {
    const embed = parseEmbed(item);
    if (!embed) continue;
    const relation = schema.get(embed.relation);
    if (!relation || relation.name === parent.name) continue;

    checked += 1;
    const fkHints = embed.hints.filter((hint) => !JOIN_HINTS.has(hint));
    const candidates = directRelationships(parent, relation).filter((r) => fkHints.every((hint) => hintMatches(r, hint)));
    if (candidates.length === 0 && !(fkHints.length === 0 && hasJunction(parent.name, relation.name))) {
      report('PGRST200', `${parent.name} → ${item}`);
    } else if (candidates.length > 1) {
      report('PGRST201', `${parent.name} → ${item} (${candidates.map((c) => `${c.fkTable}.${c.column}`).join(' / ')})`);
    }
    checked += checkSelect(relation.name, embed.columns, report);
  }
  return checked;
}

/** `.select(...)` の呼び出しの手前の連なりをたどり、`.from('<テーブル>')` のテーブル名を返す */
function fromTableOf(receiver: ts.Expression): string | null {
  let current: ts.Expression = receiver;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      if (current.expression.name.text === 'from') {
        const arg = current.arguments[0];
        return arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : null;
      }
      current = current.expression.expression;
    } else {
      return null;
    }
  }
}

function scanSource(text: string, relative: string): ScanResult {
  const kind = relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, kind);
  const findings: Finding[] = [];
  let checked = 0;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'select'
    ) {
      const arg = node.arguments[0];
      const table = fromTableOf(node.expression.expression);
      if (table && arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        checked += checkSelect(table, stripWhitespace(arg.text), (code, detail) =>
          findings.push({ file: relative, line, code, text: detail }),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { findings, checked };
}

/** 検査そのものが働くことを確かめるための見本 */
function scanSnippet(code: string): Finding[] {
  return scanSource(code, 'snippet/route.ts').findings;
}

describe('src の select の埋め込みは、PostgREST が解決できる関係だけ (#1917)', () => {
  it('src・lib の全域に、外部キーの無い (PGRST200)・外部キーが決まらない (PGRST201) 埋め込みが無い', () => {
    const files = SCAN_ROOTS.flatMap((root) => listSourceFiles(path.join(ROOT, root)));
    expect(files.length).toBeGreaterThan(0);
    const results = files.map((file) => scanSource(fs.readFileSync(file, 'utf-8'), path.relative(ROOT, file)));
    const findings = results.flatMap((r) => r.findings);
    expect(findings.map((f) => `${f.file}:${f.line} [${f.code}] ${f.text}`)).toEqual([]);
    // 何も読まずに緑になっていない
    expect(results.reduce((sum, r) => sum + r.checked, 0)).toBeGreaterThanOrEqual(MIN_CHECKED_EMBEDS);
  });

  it('外部キーの無い埋め込み (recipes → user_profiles。user_id の外部キーは auth.users 宛) を PGRST200 として見つける', () => {
    const findings = scanSnippet(`
      export async function GET() {
        return db.from('recipes').select('*, user_profiles(nickname)').eq('id', id);
      }
    `);
    expect(findings.map((f) => f.code)).toEqual(['PGRST200']);
  });

  it('入れ子の埋め込みも見る (recipes → recipe_comments → user_profiles)。改行と空白の入った select も読む', () => {
    const findings = scanSnippet(`
      export async function GET() {
        return db
          .from('recipes')
          .select(\`
            *,
            recipe_comments (
              id,
              user_profiles(nickname)
            )
          \`)
          .maybeSingle();
      }
    `);
    expect(findings.map((f) => [f.code, f.text])).toEqual([['PGRST200', 'recipe_comments → user_profiles(nickname)']]);
  });

  it('外部キーが 2 本ある埋め込み (recipes → recipe_likes: recipe_id・recipe_uuid) をヒント無しで使うと PGRST201', () => {
    const findings = scanSnippet(`db.from('recipes').select('*, recipe_likes(user_id)')`);
    expect(findings.map((f) => f.code)).toEqual(['PGRST201']);
  });

  it.each([
    ['外部キー名のヒント', `db.from('recipes').select('*, recipe_likes!recipe_likes_recipe_id_fkey(user_id)')`],
    ['列名のヒント', `db.from('recipes').select('*, recipe_likes!recipe_uuid(user_id)')`],
  ])('%s で 1 本に絞った埋め込みは数えない', (_name, code) => {
    expect(scanSnippet(code)).toEqual([]);
  });

  it('ヒントがどの外部キーにも当たらないときは PGRST200 (ヒントの書き損じ)', () => {
    expect(scanSnippet(`db.from('recipes').select('*, recipe_likes!no_such_fkey(user_id)')`).map((f) => f.code)).toEqual([
      'PGRST200',
    ]);
  });

  it.each([
    ['多対一 (!inner は結合の種類で、ヒントに数えない)', `db.from('planned_meals').select('id, user_daily_meals!inner(user_id)')`],
    ['一対多 (埋め込み先が親への外部キーを持つ)', `db.from('user_daily_meals').select('*, planned_meals (*)')`],
    ['外部キーが 1 本の一対多の入れ子 (recipes → recipe_comments)', `db.from('recipes').select('*, recipe_comments(id, user_id)')`],
    ['埋め込みの無い select', `db.from('recipes').select('*', { count: 'exact', head: true })`],
  ])('%s は数えない', (_name, code) => {
    expect(scanSnippet(code)).toEqual([]);
  });

  it('ローカル Supabase で PGRST200 と確かめた埋め込み (tests/schema-checked-db.test.ts の inquiries → user_profiles) も見つける', () => {
    expect(scanSnippet(`db.from('inquiries').select('id, user_profiles(nickname)')`).map((f) => f.code)).toEqual(['PGRST200']);
  });
});
