// personalize helper テスト
// Canonical: docs/design/family/09-onboarding-handson-tour/14-mocks-i18n.md §3.2

import { describe, it, expect } from 'vitest';
import { personalize } from '../src/personalize';

describe('personalize', () => {
  it('通常置換: {nickname} を置換する', () => {
    const result = personalize('{nickname} さん、ようこそ!', { nickname: '太郎' });
    expect(result).toBe('太郎 さん、ようこそ!');
  });

  it('多変数置換: 複数の placeholder を同時置換する', () => {
    const result = personalize(
      '{nickname} さんの目標 {target_kcal} kcal/日 の約 {percent}%',
      { nickname: '花子', target_kcal: 2000, percent: 39 },
    );
    expect(result).toBe('花子 さんの目標 2000 kcal/日 の約 39%');
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
  });

  it('30 文字超 nickname の truncate + "…" フォールバック', () => {
    const longNick = 'あ'.repeat(31);
    const result = personalize('{nickname} さん', { nickname: longNick });
    const truncated = 'あ'.repeat(30) + '…';
    expect(result).toBe(`${truncated} さん`);
    expect(result.includes(longNick)).toBe(false);
  });

  it('ちょうど 30 文字の nickname は truncate しない', () => {
    const nick30 = 'あ'.repeat(30);
    const result = personalize('{nickname} さん', { nickname: nick30 });
    expect(result).toBe(`${nick30} さん`);
    expect(result).not.toContain('…');
  });

  it('未指定 placeholder は残存する', () => {
    const result = personalize(
      '{nickname} さんの目標 {target_kcal} kcal',
      { nickname: '一郎' },
    );
    expect(result).toContain('{target_kcal}');
    expect(result).not.toContain('{nickname}');
    expect(result).toContain('一郎');
  });

  it('数値 0 は正しく文字列に変換される', () => {
    const result = personalize('{current} / {total}', { current: 0, total: 5 });
    expect(result).toBe('0 / 5');
  });

  it('template に placeholder がなければそのまま返す', () => {
    const result = personalize('こんにちは', { nickname: '太郎' });
    expect(result).toBe('こんにちは');
  });

  it('複数の同じ placeholder を置換する', () => {
    const result = personalize('{nickname} は {nickname} です', { nickname: '太郎' });
    expect(result).toBe('太郎 は 太郎 です');
  });
});
