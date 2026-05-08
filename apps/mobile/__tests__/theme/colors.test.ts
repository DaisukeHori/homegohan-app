/**
 * colors.test.ts
 * src/theme/colors.ts の主要トークン値を検証する
 */

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
