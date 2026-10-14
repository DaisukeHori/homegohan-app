/**
 * #1103 (項目 3・4): coupon_redemptions / experiment_assignments / recipe_flags の RLS が
 * supabase/migrations に定義されていること (正本がリポジトリにあること) を確かめる。
 *
 * 以前は recipe_flags などの RLS の定義がリポジトリの migration に無く、本番と database.types.ts にしか
 * 無かった (#1041 のレビュー)。#1281 で本番スキーマを最初の migration に統合したので、いまは定義がある。
 * このテストは、migration を古い順に読んだ最終状態で、次が成り立つことを固定する (DB は使わない)。
 *   - 3 つのテーブルとも RLS が有効 (後から DISABLE していない)
 *   - 期待するポリシーが、期待するコマンド (SELECT / INSERT / UPDATE / DELETE) で定義され、後から DROP されていない
 *   - coupon_redemptions と experiment_assignments には、書き込み (INSERT / UPDATE、coupon_redemptions は DELETE も) の
 *     ポリシーを足していない。書き込みは service_role (apply_coupon RPC #1224・割り当て処理 #1041) だけが行う。
 * 実際に PostgREST から何ができるかは tests/integration/rls/coupon-experiment-recipe-flags-rls.test.ts が確かめる。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'supabase', 'migrations');

/** migration を version の順に読み、コメント行を除いて 1 つの文字列にする */
function loadMigrations(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) =>
      readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n'),
    )
    .join('\n');
}

const SQL = loadMigrations();

/** 識別子は "..." で囲まれていても囲まれていなくてもよい */
function ident(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `"?${escaped}"?`;
}

function tableRef(table: string): string {
  return `(?:${ident('public')}\\.)?${ident(table)}`;
}

type PolicyCommand = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';

/** 最終状態で残っているポリシー (名前 → コマンド)。CREATE と DROP を出てきた順に適用する */
function policiesOf(table: string): Map<string, PolicyCommand> {
  const policies = new Map<string, PolicyCommand>();
  const pattern = new RegExp(
    `(CREATE\\s+POLICY\\s+("[^"]+"|\\w+)\\s+ON\\s+${tableRef(table)}(?=\\s)([\\s\\S]*?);)|(DROP\\s+POLICY\\s+(?:IF\\s+EXISTS\\s+)?("[^"]+"|\\w+)\\s+ON\\s+${tableRef(table)}\\s*;)`,
    'gi',
  );
  for (const match of SQL.matchAll(pattern)) {
    if (match[1]) {
      const name = match[2].replace(/"/g, '');
      const command = /\bFOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i.exec(match[3])?.[1]?.toUpperCase() ?? 'ALL';
      policies.set(name, command as PolicyCommand);
    } else {
      policies.delete(match[5].replace(/"/g, ''));
    }
  }
  return policies;
}

/** RLS の有効 / 無効を最後に切り替えた文が ENABLE か */
function rlsEnabled(table: string): boolean {
  const pattern = new RegExp(`ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${tableRef(table)}\\s+(ENABLE|DISABLE)\\s+ROW\\s+LEVEL\\s+SECURITY`, 'gi');
  const toggles = [...SQL.matchAll(pattern)].map((m) => m[1].toUpperCase());
  return toggles.length > 0 && toggles[toggles.length - 1] === 'ENABLE';
}

describe('#1103 RLS の正本が supabase/migrations にある', () => {
  it.each(['coupon_redemptions', 'experiment_assignments', 'recipe_flags'])('%s は RLS が有効', (table) => {
    expect(rlsEnabled(table)).toBe(true);
  });

  it('coupon_redemptions: SELECT のポリシーだけ (書き込みは apply_coupon RPC だけ)', () => {
    expect(Object.fromEntries(policiesOf('coupon_redemptions'))).toEqual({
      coupon_redemptions_select: 'SELECT',
    });
  });

  it('experiment_assignments: super_admin の SELECT / DELETE だけ (割り当ては service_role だけが作る)', () => {
    expect(Object.fromEntries(policiesOf('experiment_assignments'))).toEqual({
      experiment_assignments_select_super_admin: 'SELECT',
      experiment_assignments_delete_super_admin: 'DELETE',
    });
  });

  it('recipe_flags: 本人の INSERT・本人と admin の SELECT・admin の UPDATE (DELETE は無い)', () => {
    expect(Object.fromEntries(policiesOf('recipe_flags'))).toEqual({
      'Anyone can create recipe flags': 'INSERT',
      'Users and admins can view recipe flags': 'SELECT',
      'Admins can update recipe flags': 'UPDATE',
    });
  });

  it('recipe_flags の INSERT は reporter_id = auth.uid() の行だけを許す', () => {
    const create = new RegExp(
      `CREATE\\s+POLICY\\s+"Anyone can create recipe flags"\\s+ON\\s+${tableRef('recipe_flags')}([\\s\\S]*?);`,
      'i',
    ).exec(SQL);
    expect(create?.[1]).toMatch(/WITH\s+CHECK\s*\(\s*\(\s*"?reporter_id"?\s*=\s*"?auth"?\."?uid"?\(\)\s*\)\s*\)/i);
  });
});
