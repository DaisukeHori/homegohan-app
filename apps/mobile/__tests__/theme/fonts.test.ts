/**
 * fonts.test.ts — 文字の字形を Noto Sans JP の Regular / Medium / Bold に置き換える (#588)
 *
 * src/theme/fonts.ts の resolveFontStyle は、共通の部品 (src/components/ui/Text.tsx) とタブの見出しが使う。
 *  - 読み込めたら: fontWeight から字形を決めて fontFamily に入れ、fontWeight は外す (Android の疑似太字を避ける)
 *  - 読み込み前・失敗なら: システムの字形のまま。Noto の字形名は外し、太さは fontWeight に残す
 *  - 別の書体・入れ子で太さの指定が無いものは触らない
 */

import { StyleSheet } from 'react-native';
import type { TextStyle } from 'react-native';

import { fontFaceForWeight, fontFamilies, notoFaceOfFamily, resolveFontStyle } from '../../src/theme/fonts';
import type { FontFace } from '../../src/theme/fonts';

const READY = { fontsReady: true, inheritFromParent: false };
const NOT_READY = { fontsReady: false, inheritFromParent: false };

function flat(style: ReturnType<typeof resolveFontStyle>): TextStyle {
  return StyleSheet.flatten(style) ?? {};
}

describe('fontFamilies — web (next/font) と同じ 3 つの字形', () => {
  it('Regular / Medium / Bold の expo-font の名前', () => {
    expect(fontFamilies).toEqual({
      regular: 'NotoSansJP_400Regular',
      medium: 'NotoSansJP_500Medium',
      bold: 'NotoSansJP_700Bold',
    });
  });
});

describe('fontFaceForWeight — CSS の字形の選び方と同じ (400 以下は Regular・500 は Medium・600 以上は Bold)', () => {
  const cases: Array<[TextStyle['fontWeight'], FontFace]> = [
    [undefined, 'regular'],
    ['normal', 'regular'],
    ['regular', 'regular'],
    ['ultralight', 'regular'],
    ['thin', 'regular'],
    ['light', 'regular'],
    ['condensed', 'regular'],
    ['100', 'regular'],
    ['200', 'regular'],
    ['300', 'regular'],
    ['400', 'regular'],
    [100, 'regular'],
    [400, 'regular'],
    ['medium', 'medium'],
    ['500', 'medium'],
    [500, 'medium'],
    ['semibold', 'bold'],
    ['600', 'bold'],
    [600, 'bold'],
    ['bold', 'bold'],
    ['condensedBold', 'bold'],
    ['700', 'bold'],
    [700, 'bold'],
    ['heavy', 'bold'],
    ['800', 'bold'],
    ['black', 'bold'],
    ['900', 'bold'],
    [900, 'bold'],
  ];
  it.each(cases)('fontWeight %j → %s', (weight, face) => {
    expect(fontFaceForWeight(weight)).toBe(face);
  });
});

describe('notoFaceOfFamily', () => {
  it('Noto Sans JP の字形名なら字形、別の書体・未指定なら undefined', () => {
    expect(notoFaceOfFamily('NotoSansJP_400Regular')).toBe('regular');
    expect(notoFaceOfFamily('NotoSansJP_500Medium')).toBe('medium');
    expect(notoFaceOfFamily('NotoSansJP_700Bold')).toBe('bold');
    expect(notoFaceOfFamily('monospace')).toBeUndefined();
    expect(notoFaceOfFamily(undefined)).toBeUndefined();
  });
});

describe('resolveFontStyle — 読み込めたとき', () => {
  it('fontWeight だけの style は、対応する字形に置き換え、fontWeight を外す', () => {
    const resolved = flat(resolveFontStyle({ fontSize: 16, fontWeight: '700', color: 'red' }, READY));
    expect(resolved).toEqual({ fontSize: 16, color: 'red', fontFamily: 'NotoSansJP_700Bold' });
    expect(resolved).not.toHaveProperty('fontWeight');
  });

  it('600 / 800 / 900 も Bold、500 は Medium', () => {
    expect(flat(resolveFontStyle({ fontWeight: '600' }, READY)).fontFamily).toBe('NotoSansJP_700Bold');
    expect(flat(resolveFontStyle({ fontWeight: '800' }, READY)).fontFamily).toBe('NotoSansJP_700Bold');
    expect(flat(resolveFontStyle({ fontWeight: '900' }, READY)).fontFamily).toBe('NotoSansJP_700Bold');
    expect(flat(resolveFontStyle({ fontWeight: '500' }, READY)).fontFamily).toBe('NotoSansJP_500Medium');
  });

  it('太さの指定が無ければ Regular を入れる (style が無いときも)', () => {
    expect(flat(resolveFontStyle({ fontSize: 14 }, READY))).toEqual({ fontSize: 14, fontFamily: 'NotoSansJP_400Regular' });
    expect(flat(resolveFontStyle(undefined, READY))).toEqual({ fontFamily: 'NotoSansJP_400Regular' });
  });

  it('配列の style は重ねた結果で決める (後ろの fontWeight が勝つ)', () => {
    const resolved = flat(resolveFontStyle([{ fontWeight: '700' }, { fontWeight: '400', fontSize: 12 }], READY));
    expect(resolved).toEqual({ fontSize: 12, fontFamily: 'NotoSansJP_400Regular' });
  });

  it('typography のトークン (字形名) はそのまま、fontWeight の指定があればそちらが優先する', () => {
    expect(flat(resolveFontStyle({ fontFamily: 'NotoSansJP_500Medium' }, READY)).fontFamily).toBe('NotoSansJP_500Medium');
    const overridden = flat(resolveFontStyle([{ fontFamily: 'NotoSansJP_400Regular' }, { fontWeight: '700' }], READY));
    expect(overridden).toEqual({ fontFamily: 'NotoSansJP_700Bold' });
  });

  it('別の書体を指定している style は触らない (fontWeight も残す)', () => {
    const style = { fontFamily: 'monospace', fontWeight: '700' as const };
    expect(resolveFontStyle(style, READY)).toBe(style);
  });
});

describe('resolveFontStyle — 読み込み前・失敗したとき (システムの字形)', () => {
  it('Noto の字形名が無い style は、渡されたものをそのまま返す (fontWeight も残す)', () => {
    const style = [{ fontWeight: '800' as const }, { color: 'red' }];
    expect(resolveFontStyle(style, NOT_READY)).toBe(style);
    expect(resolveFontStyle(undefined, NOT_READY)).toBeUndefined();
  });

  it('Noto の字形名は外し、字形名で表していた太さを fontWeight に残す', () => {
    expect(flat(resolveFontStyle({ fontFamily: 'NotoSansJP_700Bold', fontSize: 24 }, NOT_READY))).toEqual({
      fontSize: 24,
      fontWeight: '700',
    });
    expect(flat(resolveFontStyle({ fontFamily: 'NotoSansJP_500Medium' }, NOT_READY))).toEqual({ fontWeight: '500' });
    const regular = flat(resolveFontStyle({ fontFamily: 'NotoSansJP_400Regular', fontSize: 14 }, NOT_READY));
    expect(regular).toEqual({ fontSize: 14 });
  });

  it('字形名と fontWeight が両方あれば fontWeight を残す', () => {
    const resolved = flat(resolveFontStyle([{ fontFamily: 'NotoSansJP_400Regular' }, { fontWeight: '800' }], NOT_READY));
    expect(resolved).toEqual({ fontWeight: '800' });
  });
});

describe('resolveFontStyle — 入れ子の Text (親の字形を引き継ぐ)', () => {
  const NESTED_READY = { fontsReady: true, inheritFromParent: true };

  it('太さも字形名も指定していなければ触らない (Regular を入れて親の太字を消さない)', () => {
    const style = { color: 'red' };
    expect(resolveFontStyle(style, NESTED_READY)).toBe(style);
    expect(resolveFontStyle(undefined, NESTED_READY)).toBeUndefined();
  });

  it('太さを指定していれば、その字形に置き換える', () => {
    expect(flat(resolveFontStyle({ fontWeight: 'bold' }, NESTED_READY))).toEqual({ fontFamily: 'NotoSansJP_700Bold' });
    expect(flat(resolveFontStyle({ fontWeight: 'normal' }, NESTED_READY))).toEqual({ fontFamily: 'NotoSansJP_400Regular' });
  });
});
