/**
 * #1312 アクティブな買い物リストの作成・差し替えを、DB 関数の外から行わないための ソース走査 contract テスト
 *
 * shopping_lists には「ユーザーごとにアクティブ (status = 'active') なリストは 1 つだけ」という部分ユニーク索引
 * idx_shopping_lists_active_unique がある。リストを作る処理やアーカイブする処理を、別々の HTTP 呼び出し
 * (SELECT -> INSERT、UPDATE -> INSERT) で行うと、同時に来た別の経路と交差して 23505 で失敗する
 * (#1312: 買い物リストの再生成が「レシピから追加」と交差して failed になった)。
 * そのため、作成と差し替えは DB 関数を通す。どちらもユーザーごとの排他ロックを取る。
 *   - public.get_or_create_active_shopping_list : add-recipe・AI 相談の add_to_shopping_list (src/lib/shopping-list/active-list.ts)
 *   - public.replace_active_shopping_list       : 買い物リストの再生成 (supabase/functions/_shared/shopping-list-replace.ts)
 *
 * このテストは、src/・supabase/functions/・apps/mobile のソースを読み、shopping_lists テーブルへの
 * insert / upsert / update / delete を直接呼んでいる箇所が無いことを確かめる (走査は TypeScript の構文木。
 * コメントや文字列の中の記述には反応しない)。新しい経路を足してこのテストが落ちたら、まず上の DB 関数を使えないか考える。
 * 使えない正当な理由があるときだけ、EXEMPT_DIRECT_WRITES に理由を書いて足す。
 * DB 関数の振る舞い (ロック・原子性・権限) は tests/integration/security/shopping-list-active-lock.test.ts で確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['src', 'supabase/functions', 'apps/mobile/src', 'apps/mobile/app'];
const SKIP_DIRS = new Set(['node_modules', '.next', '__tests__', '__mocks__']);
const WRITE_METHODS = new Set(['insert', 'upsert', 'update', 'delete']);
const TABLE = 'shopping_lists';

/**
 * shopping_lists への直接の書き込みを許す箇所と、その理由。キーは "<ファイル>:<メソッド>"。
 * 今は無い (作成と差し替えは DB 関数、食材 shopping_list_items の書き込みは別テーブル)。
 */
const EXEMPT_DIRECT_WRITES: Record<string, string> = {};

interface DirectWrite {
  method: string;
  line: number;
}

/** `<...>.from('shopping_lists')...<insert|upsert|update|delete>(...)` の形の呼び出しを探す */
function findDirectShoppingListWrites(source: string, fileName = 'file.ts'): DirectWrite[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: DirectWrite[] = [];

  // メソッドチェーンの左側をたどり、`.from('shopping_lists')` があるかを調べる
  const chainStartsFromTable = (start: ts.Expression): boolean => {
    let current: ts.Expression = start;
    for (;;) {
      if (ts.isCallExpression(current)) {
        const callee = current.expression;
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'from') {
          const first = current.arguments[0];
          if (first && ts.isStringLiteralLike(first) && first.text === TABLE) return true;
        }
        current = callee;
      } else if (
        ts.isPropertyAccessExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isParenthesizedExpression(current) ||
        ts.isAwaitExpression(current)
      ) {
        current = current.expression;
      } else {
        return false;
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (WRITE_METHODS.has(method) && chainStartsFromTable(node.expression.expression)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push({ method, line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(d|test|spec)\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe('findDirectShoppingListWrites (走査の確認)', () => {
  it('shopping_lists への insert / upsert / update / delete を、チェーンが複数行でも検出する', () => {
    const source = `
      await supabase.from('shopping_lists').insert({ user_id });
      await supabase
        .from("shopping_lists")
        .update({ status: 'archived' })
        .eq('user_id', userId)
        .eq('status', 'active');
      const { data } = await admin.from('shopping_lists').upsert(row).select('id').single();
      await admin.from(\`shopping_lists\`).delete().eq('id', id);
    `;

    expect(findDirectShoppingListWrites(source).map((w) => w.method)).toEqual(['insert', 'update', 'upsert', 'delete']);
  });

  it('読み取りや別のテーブル (shopping_list_items など) への書き込みは検出しない', () => {
    const source = `
      const a = await supabase.from('shopping_lists').select('id').eq('user_id', userId).maybeSingle();
      await supabase.from('shopping_list_items').insert(items);
      await supabase.from('shopping_list_requests').update({ status: 'failed' }).eq('id', id);
      await supabase.rpc('replace_active_shopping_list', { p_user_id: userId });
    `;

    expect(findDirectShoppingListWrites(source)).toEqual([]);
  });

  it('コメントや文字列の中の記述には反応しない', () => {
    const source = `
      // await supabase.from('shopping_lists').insert({ user_id })
      const doc = "supabase.from('shopping_lists').update({ status: 'archived' })";
    `;

    expect(findDirectShoppingListWrites(source)).toEqual([]);
  });
});

describe('shopping_lists への直接の書き込み (#1312)', () => {
  const files = SCAN_ROOTS.flatMap((root) => collectSourceFiles(path.join(ROOT, root)));

  it('走査が機能している: 十分な数のソースを読んでいて、shopping_lists を読んでいる既知のファイルを見つけている', () => {
    const mentioning = files
      .filter((file) => fs.readFileSync(file, 'utf-8').includes(TABLE))
      .map((file) => path.relative(ROOT, file).split(path.sep).join('/'));

    // 走査が壊れて何も読めなくなったときに、下の contract が空振りで通ってしまわないようにする
    expect(files.length).toBeGreaterThan(100);
    expect(mentioning).toEqual(
      expect.arrayContaining(['src/app/api/shopping-list/route.ts', 'src/lib/ai/consultation-action-executor.ts']),
    );
  });

  it('アクティブなリストの作成・差し替えは DB 関数を通し、shopping_lists へ直接 insert / upsert / update / delete しない', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      if (!source.includes(TABLE)) continue; // 読まなくてよいファイルは構文木を作らない
      const relative = path.relative(ROOT, file).split(path.sep).join('/');
      for (const write of findDirectShoppingListWrites(source, relative)) {
        if (`${relative}:${write.method}` in EXEMPT_DIRECT_WRITES) continue;
        violations.push(`${relative}:${write.line} (.${write.method})`);
      }
    }

    expect(
      violations,
      'アクティブな買い物リストの作成・差し替えは、DB 関数 get_or_create_active_shopping_list / replace_active_shopping_list を通すこと ' +
        '(別々の呼び出しにすると、再生成と「レシピから追加」が交差して一意制約違反になる。#1312)。' +
        '通せない正当な理由があるときだけ、このテストの EXEMPT_DIRECT_WRITES に理由を書いて足す: ' +
        violations.join(', '),
    ).toEqual([]);
  });

  it('除外リストが古くなっていない (残っている項目は、まだその書き込みが存在する)', () => {
    const stale = Object.keys(EXEMPT_DIRECT_WRITES).filter((key) => {
      const separator = key.lastIndexOf(':');
      const relative = key.slice(0, separator);
      const method = key.slice(separator + 1);
      const full = path.join(ROOT, relative);
      if (!fs.existsSync(full)) return true;
      return !findDirectShoppingListWrites(fs.readFileSync(full, 'utf-8'), relative).some((w) => w.method === method);
    });

    expect(stale, `もう存在しない書き込みは EXEMPT_DIRECT_WRITES から消すこと: ${stale.join(', ')}`).toEqual([]);
  });
});
