/**
 * colors.test.ts
 * src/theme/colors.ts の主要トークン値を検証する
 */

import { colors } from '../../src/theme/colors';

describe('colors トークン', () => {
  it('accent は #FF8A65', () => {
    expect(colors.accent).toBe('#FF8A65');
  });

  it('accentDark は #C4634C', () => {
    expect(colors.accentDark).toBe('#C4634C');
  });

  it('danger は #D64545', () => {
    expect(colors.danger).toBe('#D64545');
  });

  it('bg は #FFFFFF', () => {
    expect(colors.bg).toBe('#FFFFFF');
  });

  it('text は #1A1A1A', () => {
    expect(colors.text).toBe('#1A1A1A');
  });

  it('success は #4CAF50', () => {
    expect(colors.success).toBe('#4CAF50');
  });

  it('error は #F44336', () => {
    expect(colors.error).toBe('#F44336');
  });

  it('border は #EEEEEE', () => {
    expect(colors.border).toBe('#EEEEEE');
  });

  it('streak は #FF6B35', () => {
    expect(colors.streak).toBe('#FF6B35');
  });

  it('purple は #7C4DFF', () => {
    expect(colors.purple).toBe('#7C4DFF');
  });
});
