/**
 * #1041 (F4-13) 回帰防止テスト
 * src/lib/experiments/assignment.ts — 決定的ハッシュ variant 割当エンジン
 *
 * 従来は experiments.status を running にしても variant を割り当てる処理が
 * 存在せず、experiment_assignments が常に空のままだった (runtime で無効)。
 */
import { describe, expect, it } from 'vitest';
import {
  ExperimentNotRunningError,
  InvalidVariantsError,
  getOrAssignVariant,
  parseVariants,
  selectVariantKey,
} from '@/lib/experiments/assignment';
import { createFakeSupabase } from './helpers/fake-supabase';

describe('parseVariants', () => {
  it('正しい形式をパースする', () => {
    const variants = parseVariants([
      { key: 'control', weight: 50 },
      { key: 'treatment', weight: 50 },
    ]);
    expect(variants).toHaveLength(2);
  });

  it('配列でない場合は InvalidVariantsError', () => {
    expect(() => parseVariants({ key: 'x' })).toThrow(InvalidVariantsError);
  });

  it('key/weight の型が不正な場合は InvalidVariantsError', () => {
    expect(() => parseVariants([{ key: 'x', weight: 'not-a-number' }])).toThrow(InvalidVariantsError);
  });

  it('空配列は InvalidVariantsError', () => {
    expect(() => parseVariants([])).toThrow(InvalidVariantsError);
  });
});

describe('selectVariantKey', () => {
  const variants = [
    { key: 'control', weight: 50 },
    { key: 'treatment', weight: 50 },
  ];

  it('同一 experimentId + userId の組では常に同じ variant を返す (決定的)', () => {
    const a = selectVariantKey(variants, 'exp-1', 'user-1');
    const b = selectVariantKey(variants, 'exp-1', 'user-1');
    expect(a).toBe(b);
  });

  it('異なる userId では異なる variant に分散し得る (100人中両方の variant が出現する)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(selectVariantKey(variants, 'exp-1', `user-${i}`));
    }
    expect(seen.has('control')).toBe(true);
    expect(seen.has('treatment')).toBe(true);
  });

  it('weight 0 の variant は選ばれない', () => {
    const skewed = [
      { key: 'never', weight: 0 },
      { key: 'always', weight: 100 },
    ];
    for (let i = 0; i < 50; i++) {
      expect(selectVariantKey(skewed, 'exp-2', `user-${i}`)).toBe('always');
    }
  });

  it('weight が全て 0 以下の場合は InvalidVariantsError', () => {
    expect(() => selectVariantKey([{ key: 'x', weight: 0 }], 'exp-3', 'user-1')).toThrow(InvalidVariantsError);
  });
});

describe('getOrAssignVariant', () => {
  const experiment = { id: 'exp-1', status: 'running', variants: [{ key: 'a', weight: 1 }, { key: 'b', weight: 1 }] };

  it('running でない実験は ExperimentNotRunningError を throw する (割当を作らない)', async () => {
    const supabase = createFakeSupabase({});
    await expect(
      getOrAssignVariant(supabase as never, { ...experiment, status: 'draft' }, 'user-1'),
    ).rejects.toBeInstanceOf(ExperimentNotRunningError);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('既存の割当があればそれを返す (sticky、再割当しない)', async () => {
    const supabase = createFakeSupabase({
      experiment_assignments: [{ data: { variant_key: 'a' }, error: null }],
    });
    const result = await getOrAssignVariant(supabase as never, experiment, 'user-1');
    expect(result).toBe('a');
  });

  it('割当が無ければ新規作成し、その variant_key を返す', async () => {
    const supabase = createFakeSupabase({
      experiment_assignments: [
        { data: null, error: null }, // 既存チェック: なし
        { data: { variant_key: 'b' }, error: null }, // insert().select().single()
      ],
    });
    const result = await getOrAssignVariant(supabase as never, experiment, 'user-2');
    expect(['a', 'b']).toContain(result);
  });

  it('insert 時に競合が起きた場合は再取得して既存の sticky な割当を返す', async () => {
    const supabase = createFakeSupabase({
      experiment_assignments: [
        { data: null, error: null }, // 既存チェック: なし
        { data: null, error: { message: 'duplicate key' } }, // insert 失敗 (競合)
        { data: { variant_key: 'a' }, error: null }, // 再取得
      ],
    });
    const result = await getOrAssignVariant(supabase as never, experiment, 'user-3');
    expect(result).toBe('a');
  });

  it('DB エラー時は例外を throw する (fail-closed)', async () => {
    const supabase = createFakeSupabase({
      experiment_assignments: [{ data: null, error: { message: 'connection error' } }],
    });
    await expect(getOrAssignVariant(supabase as never, experiment, 'user-4')).rejects.toBeTruthy();
  });
});
