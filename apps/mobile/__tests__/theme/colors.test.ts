/**
 * colors.test.ts
 * src/theme/colors.ts の主要トークン値を検証する
 */

import { STATUS_COLOR_TOKENS } from '@homegohan/shared';
import { colors } from '../../src/theme/colors';

describe('colors トークン', () => {
  it('accent は #E07A5F', () => {
    expect(colors.accent).toBe('#E07A5F');
  });

  it('accentDark は #C4634C', () => {
    expect(colors.accentDark).toBe('#C4634C');
  });

  it('danger は #D64545', () => {
    expect(colors.danger).toBe('#D64545');
  });

  it('bg は #F7F6F3', () => {
    expect(colors.bg).toBe('#F7F6F3');
  });

  it('text は #2D2D2D', () => {
    expect(colors.text).toBe('#2D2D2D');
  });

  it('success は #6B9B6B', () => {
    expect(colors.success).toBe('#6B9B6B');
  });

  it('error は #F44336', () => {
    expect(colors.error).toBe('#F44336');
  });

  it('border は #E8E8E8', () => {
    expect(colors.border).toBe('#E8E8E8');
  });

  it('streak は #FF6B35', () => {
    expect(colors.streak).toBe('#FF6B35');
  });

  it('purple は #7C6BA0', () => {
    expect(colors.purple).toBe('#7C6BA0');
  });
});

// #590: 状態色は packages/shared の STATUS_COLOR_TOKENS が唯一の定義元 (Web の home・health・pantry と共通)。
// 塗りの値は以前この colors.ts に直書きしていた A 系のままで、モバイルの見た目は変わらない。
// Web 側の値の一致は、Web のテスト (src/__tests__/config/status-color-tokens.test.ts) が確かめる。
describe('状態色 (#590): 共通のトークンと同じ値', () => {
  const tokenKeys = Object.keys(STATUS_COLOR_TOKENS) as (keyof typeof STATUS_COLOR_TOKENS)[];

  // 文字用 (successText / warningText / dangerText) も含め、トークンの全部が colors に入っている
  it.each(tokenKeys)('%s は共通のトークンと同じ', (key) => {
    expect(colors[key]).toBe(STATUS_COLOR_TOKENS[key]);
  });

  it('塗りの色は、以前この colors.ts に直書きしていた A 系の値のまま', () => {
    expect({
      success: colors.success,
      successLight: colors.successLight,
      warning: colors.warning,
      warningLight: colors.warningLight,
      error: colors.error,
      errorLight: colors.errorLight,
      danger: colors.danger,
      dangerLight: colors.dangerLight,
    }).toEqual({
      success: '#6B9B6B',
      successLight: '#EDF5ED',
      warning: '#E5A84B',
      warningLight: '#FEF9EE',
      error: '#F44336',
      errorLight: '#FFEBEE',
      danger: '#D64545',
      dangerLight: '#FDECEC',
    });
  });
});
