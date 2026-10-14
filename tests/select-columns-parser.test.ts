import { describe, expect, it } from 'vitest';

import { extractSelectRefs, parseSelectItem, splitTopLevel } from './helpers/select-columns';

// tests/integration/security/select-columns-exist.test.ts が使う、select 文字列の解釈の単体テスト

describe('splitTopLevel', () => {
  it('括弧の中のカンマでは区切らない', () => {
    expect(splitTopLevel('id, org:organizations(id, name, owner:users(id)), created_at')).toEqual([
      'id',
      'org:organizations(id, name, owner:users(id))',
      'created_at',
    ]);
  });

  it('改行や空の項目を取り除く', () => {
    expect(splitTopLevel('\n  id,\n  nickname,\n')).toEqual(['id', 'nickname']);
  });
});

describe('parseSelectItem', () => {
  it.each([
    ['nickname', { name: 'nickname', kind: 'column' }],
    ['name:nickname', { name: 'nickname', kind: 'column' }],
    ['created_at::date', { name: 'created_at', kind: 'column' }],
    ['metadata->>reason', { name: 'metadata', kind: 'column' }],
    ['alias:metadata->items->0', { name: 'metadata', kind: 'column' }],
    ['organizations(name)', { name: 'organizations', kind: 'relation' }],
    ['meal_plan_days!inner(user_id)', { name: 'meal_plan_days', kind: 'relation' }],
    ['owner:user_profiles!fk_owner(nickname)', { name: 'user_profiles', kind: 'relation' }],
  ])('%s', (item, expected) => {
    expect(parseSelectItem(item)).toEqual(expected);
  });

  it.each(['*', 'count()', 'total:count()', 'sum(amount)', '...organizations(name)', ''])(
    '%s は対象外 (null)',
    (item) => {
      expect(parseSelectItem(item)).toBeNull();
    },
  );
});

describe('extractSelectRefs', () => {
  it('.from() の直後の .select() から列とリレーションを取り出す (行番号つき)', () => {
    const source = [
      "const a = await supabase.from('user_profiles').select('family_id, nickname, display_name').eq('id', id);",
      'const b = await admin',
      "  .from('planned_meals')",
      '  .select(`',
      '    id,',
      '    meal_plan_days!inner(user_id)',
      '  `);',
    ].join('\n');

    expect(extractSelectRefs(source)).toEqual([
      { table: 'user_profiles', name: 'family_id', kind: 'column', line: 1 },
      { table: 'user_profiles', name: 'nickname', kind: 'column', line: 1 },
      { table: 'user_profiles', name: 'display_name', kind: 'column', line: 1 },
      { table: 'planned_meals', name: 'id', kind: 'column', line: 3 },
      { table: 'planned_meals', name: 'meal_plan_days', kind: 'relation', line: 3 },
    ]);
  });

  it('式を埋め込んだテンプレートリテラルや、from の後に別の操作がある select は対象外', () => {
    const source = [
      // eslint-disable-next-line no-template-curly-in-string
      "supabase.from('user_profiles').select(`id, ${extra}`);",
      "supabase.from('user_profiles').update({ nickname }).select('id, nickname');",
      'supabase.from(table).select("id");',
    ].join('\n');

    expect(extractSelectRefs(source)).toEqual([]);
  });

  it('select の第 2 引数 (count オプション) は見ない', () => {
    const source = "supabase.from('badges').select('id', { count: 'exact', head: true });";
    expect(extractSelectRefs(source)).toEqual([{ table: 'badges', name: 'id', kind: 'column', line: 1 }]);
  });
});
