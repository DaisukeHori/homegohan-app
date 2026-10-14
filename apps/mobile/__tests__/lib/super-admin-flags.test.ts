/**
 * super-admin-flags.test.ts
 * src/lib/super-admin-flags.ts の parseFeatureFlagsResponse() のテスト (#1137)
 *
 * GET /api/super-admin/flags の応答 ({ data: [...], meta }) を、画面で使う形にするところ。
 * 以前の画面は { flags: Record<string, boolean> } を期待していて、サーバーの形と合っていなかった。
 */
import { parseFeatureFlagsResponse } from '../../src/lib/super-admin-flags';

/** src/app/api/super-admin/flags/route.ts の GET が返す形 */
const SERVER_RESPONSE = {
  data: [
    {
      key: 'new_meal_ai_v2',
      description: '新しい食事 AI V2',
      enabled: true,
      rollout_strategy: { type: 'percentage', value: 25 },
      constraints: { min_user_age_days: 7 },
      active_user_count: 0,
      updated_at: '2026-07-11T00:00:00.000Z',
    },
    {
      key: 'beta_banner',
      description: '',
      enabled: false,
      rollout_strategy: null,
      constraints: null,
      active_user_count: 0,
      updated_at: '2026-07-10T00:00:00.000Z',
    },
  ],
  meta: { total: 2, page: 1, per_page: 2 },
};

describe('parseFeatureFlagsResponse', () => {
  it('{ data, meta } から key / description / enabled だけを取り出し、キー順に並べる', () => {
    expect(parseFeatureFlagsResponse(SERVER_RESPONSE)).toEqual([
      { key: 'beta_banner', description: '', enabled: false },
      { key: 'new_meal_ai_v2', description: '新しい食事 AI V2', enabled: true },
    ]);
  });

  it('rollout_strategy / constraints / active_user_count などは画面用の値に含めない', () => {
    const [flag] = parseFeatureFlagsResponse(SERVER_RESPONSE);
    expect(Object.keys(flag).sort()).toEqual(['description', 'enabled', 'key']);
  });

  it('フラグが 0 件の応答は空配列', () => {
    expect(parseFeatureFlagsResponse({ data: [], meta: { total: 0, page: 1, per_page: 0 } })).toEqual([]);
  });

  it('description が null / 欠落なら空文字にする', () => {
    const flags = parseFeatureFlagsResponse({
      data: [
        { key: 'a', description: null, enabled: true },
        { key: 'b', enabled: false },
      ],
    });
    expect(flags).toEqual([
      { key: 'a', description: '', enabled: true },
      { key: 'b', description: '', enabled: false },
    ]);
  });

  it('enabled が真偽値の true でなければ false として扱う (文字列の "true" や 1 を ON と誤認しない)', () => {
    const flags = parseFeatureFlagsResponse({
      data: [
        { key: 'a', enabled: 'true' },
        { key: 'b', enabled: 1 },
        { key: 'c', enabled: null },
        { key: 'd' },
        { key: 'e', enabled: true },
      ],
    });
    expect(flags.map((f) => [f.key, f.enabled])).toEqual([
      ['a', false],
      ['b', false],
      ['c', false],
      ['d', false],
      ['e', true],
    ]);
  });

  it('key が無い・文字列でない・空の行と、オブジェクトでない行は捨てる', () => {
    const flags = parseFeatureFlagsResponse({
      data: [null, 'text', 42, [], {}, { key: '' }, { key: 7, enabled: true }, { key: 'ok', enabled: true }],
    });
    expect(flags).toEqual([{ key: 'ok', description: '', enabled: true }]);
  });

  it('並べ替えはキーの文字コード順 (実行環境のロケールに左右されない)', () => {
    const flags = parseFeatureFlagsResponse({
      data: [{ key: 'b_2' }, { key: 'a_10' }, { key: 'a_2' }, { key: 'B' }],
    });
    expect(flags.map((f) => f.key)).toEqual(['B', 'a_10', 'a_2', 'b_2']);
  });

  it.each([
    ['旧形式 { flags: {...} }', { flags: { new_meal_ai_v2: true } }],
    ['data が配列でない', { data: { new_meal_ai_v2: true } }],
    ['data が無い', { meta: {} }],
    ['null', null],
    ['undefined', undefined],
    ['文字列', 'ok'],
  ])('想定外の形 (%s) は、空の一覧に見せかけずエラーにする', (_label, response) => {
    expect(() => parseFeatureFlagsResponse(response)).toThrow('機能フラグの応答の形式が想定と異なります。');
  });
});
