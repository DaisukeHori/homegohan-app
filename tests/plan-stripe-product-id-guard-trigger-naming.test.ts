// @vitest-environment node
/**
 * Stripe の商品の ID を守るトリガーの呼び名の番兵 (ソース走査。#2128 docs-1031c の R2 指摘 1)
 *
 * supabase/migrations/20261030160000_plan_stripe_product_id_price_change_guard.sql は、関数
 * guard_plan_stripe_product_id_price_change と、それを呼ぶトリガー trg_guard_plan_stripe_product_id_price_change を作る。
 * コメント・文書で関数の名前を「トリガー」と呼ぶと、DB でトリガーを探す人 (pg_trigger の tgname) が見つけられない。
 * #2128 は呼び名を「トリガー trg_guard_plan_stripe_product_id_price_change (関数 guard_plan_stripe_product_id_price_change)」に
 * そろえたが、R1 の修正は「トリガー」と関数の名前が別の行に分かれたコメント (「…DB のトリガー」の次の行が「 * guard_…」) を
 * 見落とした (1 行ずつの grep では見えない)。ここでは、
 *  1. migration から、トリガーの名前と、トリガーが呼ぶ関数の名前を読む (どちらもこのテストの定数と同じで、互いに違う)
 *  2. src・tests・docs (docs/design を除く)・apps・scripts・supabase (migrations・rollbacks・functions)・CLAUDE.md の全文で、
 *     「トリガー」のすぐ後 (空白・改行・コメントの行の頭の * や //・--・#・> と、` や ( だけを挟む) に関数の名前が来る所が無い
 *  3. 2. の見つけ方が、行をまたぐ書き方・` で囲む書き方・( で始める書き方を見つけ、直した書き方 (トリガーの名前を書き、
 *     関数の名前は「関数 …」と書く) には反応しないことを、写しの文で確かめる
 * を確かめる。docs/design (設計正典) はこのブランチでは直さない (operator/02 §17 の 1 か所は design-doc.patch で直す)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20261030160000_plan_stripe_product_id_price_change_guard.sql',
);
const FN = 'guard_plan_stripe_product_id_price_change';
const TRIGGER = 'trg_guard_plan_stripe_product_id_price_change';

/** 走査する場所 (リポジトリの根からの相対パス。ファイルでもディレクトリでもよい) */
const SCAN_ROOTS = ['src', 'tests', 'docs', 'apps', 'scripts', 'supabase', 'CLAUDE.md'];
/** 走査しない場所 (リポジトリの根からの相対パス)。docs/design は設計正典で、このブランチでは直さないため */
const SCAN_EXCLUDED = ['docs/design'];
/** 中に入らないディレクトリの名前 (依存・生成物) */
const SKIPPED_DIR_NAMES = new Set(['node_modules', '.next', '.expo', 'dist', 'build', 'coverage', 'Pods', '.turbo', '.git']);
/** 読むファイルの拡張子 (文字のファイル) */
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.md', '.mdx', '.sql', '.sh', '.yml', '.yaml']);

/** root (相対パス) の下の文字のファイル (相対パス。並べて返す) */
function textFilesUnder(root: string): string[] {
  const full = path.join(ROOT, root);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [root];
  const out: string[] = [];
  const walk = (rel: string) => {
    if (SCAN_EXCLUDED.includes(rel)) return;
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIR_NAMES.has(entry.name)) walk(child);
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(child);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** 正規表現の特別な文字を逃がす */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 「トリガー」のすぐ後に関数の名前 fn が来る所の行 (1 始まり。「トリガー」の行)。
 * 行の頭のコメントの印 (* ・ // ・ -- ・ # ・ >) は外してから見る (行の数は変えない) ので、行をまたいでも見つける。
 * 間に挟んでよいのは空白・改行・` ・ ( だけ (trg_… は挟めないので、トリガーの名前の中の fn には反応しない)。名前の後に英数字・_ が続くものは数えない。
 */
function triggerCalledByFunctionName(text: string, fn: string): number[] {
  const normalized = text.replace(/\n[ \t]*(?:\*(?!\/)|\/\/+|--+|#+|>)?/g, '\n');
  const pattern = new RegExp(`トリガー[\\s\`(]*${escapeRegExp(fn)}(?![A-Za-z0-9_])`, 'g');
  return [...normalized.matchAll(pattern)].map((match) => normalized.slice(0, match.index).split('\n').length);
}

describe('Stripe の商品の ID を守るトリガーの呼び名 (#2128 docs-1031c の R2 指摘 1)', () => {
  it('migration のトリガーはこのテストの名前で、呼ぶ関数もこのテストの名前 (トリガーと関数は別の名前)', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf-8').replace(/--.*$/gm, '');
    const created = [...sql.matchAll(/CREATE\s+TRIGGER\s+(\w+)[\s\S]*?EXECUTE\s+FUNCTION\s+public\.(\w+)\s*\(/g)].map(
      ([, trigger, fn]) => ({ trigger, fn }),
    );
    expect(created).toEqual([{ trigger: TRIGGER, fn: FN }]);
    expect(TRIGGER).not.toBe(FN);
  });

  it('src・tests・docs (docs/design を除く)・apps・scripts・supabase・CLAUDE.md で、関数の名前を「トリガー」と呼ぶ所が無い', () => {
    const files = SCAN_ROOTS.flatMap(textFilesUnder);
    expect(files, 'src・tests・supabase・CLAUDE.md のファイルを走査している').toEqual(
      expect.arrayContaining([
        'src/app/api/super-admin/plans/[id]/route.ts',
        'src/lib/super-admin/plan-price-change-reservation.ts',
        'src/lib/super-admin/plans-schemas.ts',
        'tests/integration/security/plan-deprecate-lock-price-change-reservation.test.ts',
        'supabase/migrations/20261030160000_plan_stripe_product_id_price_change_guard.sql',
        'CLAUDE.md',
      ]),
    );
    expect(files.filter((file) => file.startsWith('docs/design/')), 'docs/design は走査しない').toEqual([]);
    const found = files.flatMap((file) => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      if (!text.includes(FN)) return [];
      return triggerCalledByFunctionName(text, FN).map((line) => `${file}:${line}`);
    });
    expect(found).toEqual([]);
  });

  it('見つけ方が空振りしない: 行をまたぐ・` で囲む・( で始める書き方を見つけ、直した書き方には反応しない', () => {
    // 直す前の route.ts の書き方 (「DB のトリガー」の次の行に関数の名前)
    const splitComment = ` * そのあいだは DB のトリガー\n * ${FN} (supabase/migrations/…) が、`;
    expect(triggerCalledByFunctionName(splitComment, FN)).toEqual([1]);
    // 直す前の plan-price-change-reservation.ts の書き方 (次の行が ( で始まる)
    const parenthesized = `/**\n * …止めるトリガー\n * (${FN}。#2112 Z1-1) が RAISE する文`;
    expect(triggerCalledByFunctionName(parenthesized, FN)).toEqual([2]);
    // 直す前の operator/02 §17 の書き方 (` で囲む)
    expect(triggerCalledByFunctionName(`\`subscription_plans\` のトリガー \`${FN}\` (\`…\`)`, FN)).toEqual([1]);
    // SQL と // のコメントの行の継ぎ
    expect(triggerCalledByFunctionName(`-- 止めるトリガー\n--   ${FN}`, FN)).toEqual([1]);
    expect(triggerCalledByFunctionName(`// 止めるトリガー\n// ${FN}`, FN)).toEqual([1]);

    // 直した書き方 (トリガーの名前を書き、関数の名前は「関数 …」と書く) には反応しない
    expect(triggerCalledByFunctionName(` * DB のトリガー ${TRIGGER}\n * (関数 ${FN}。supabase/migrations/…) が、`, FN)).toEqual(
      [],
    );
    expect(triggerCalledByFunctionName(`のトリガー \`${TRIGGER}\` (関数 \`${FN}\`) (\`…\`)`, FN)).toEqual([]);
    // 関数を関数と呼ぶ書き方・トリガーと離れた所の関数の名前には反応しない
    expect(triggerCalledByFunctionName(`トリガーの関数 ${FN} が RAISE する`, FN)).toEqual([]);
    expect(triggerCalledByFunctionName(`-- 行トリガー ${TRIGGER}\n--   (関数 ${FN})`, FN)).toEqual([]);
  });
});
