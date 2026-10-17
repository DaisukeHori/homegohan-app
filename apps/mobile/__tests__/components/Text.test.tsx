/**
 * Text.test.tsx — 文字の共通の部品が Noto Sans JP の字形を当てる (#588)
 *
 * src/components/ui/Text.tsx の Text / TextInput は、app/_layout.tsx の FontsReadyProvider が
 * 「読み込めた」と言っている間だけ、fontWeight を字形 (Regular / Medium / Bold) に置き換えて描く。
 * それ以外 (読み込みに失敗・Provider の外) はシステムの字形のまま、渡された style で描く。
 */

import React, { createRef } from 'react';
import { StyleSheet, Text as RNText, TextInput as RNTextInput } from 'react-native';
import type { TextInputInstance, TextInstance, TextStyle } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { FontsReadyProvider, Text, TextInput } from '../../src/components/ui/Text';
import { typography } from '../../src/theme';

function styleOf(element: { props: { style?: unknown } }): TextStyle {
  return StyleSheet.flatten(element.props.style as TextStyle) ?? {};
}

describe('Text — 字形を読み込めたとき', () => {
  it('fontWeight だけの style は、太字の字形に置き換わり、fontWeight は外れる', () => {
    render(
      <FontsReadyProvider ready>
        <Text style={{ fontSize: 16, fontWeight: '700' }}>見出し</Text>
      </FontsReadyProvider>,
    );
    const style = styleOf(screen.getByText('見出し'));
    expect(style.fontFamily).toBe('NotoSansJP_700Bold');
    expect(style.fontSize).toBe(16);
    expect(style).not.toHaveProperty('fontWeight');
  });

  it('太さの指定が無ければ Regular、500 は Medium', () => {
    render(
      <FontsReadyProvider ready>
        <Text>本文</Text>
        <Text style={{ fontWeight: '500' }}>ラベル</Text>
      </FontsReadyProvider>,
    );
    expect(styleOf(screen.getByText('本文')).fontFamily).toBe('NotoSansJP_400Regular');
    expect(styleOf(screen.getByText('ラベル')).fontFamily).toBe('NotoSansJP_500Medium');
  });

  it('typography のトークンの字形はそのまま当たる', () => {
    render(
      <FontsReadyProvider ready>
        <Text style={typography.caption}>注記</Text>
      </FontsReadyProvider>,
    );
    expect(styleOf(screen.getByText('注記')).fontFamily).toBe('NotoSansJP_500Medium');
  });

  it('入れ子の Text は、太さの指定が無ければ親の字形を引き継ぐ (Regular で上書きしない)', () => {
    render(
      <FontsReadyProvider ready>
        <Text testID="outer" style={{ fontWeight: '700' }}>
          太字の中の<Text testID="inherit" style={{ color: 'red' }}>赤字</Text>と
          <Text testID="own" style={{ fontWeight: '400' }}>細字</Text>
        </Text>
      </FontsReadyProvider>,
    );
    expect(styleOf(screen.getByTestId('outer')).fontFamily).toBe('NotoSansJP_700Bold');
    const inherit = styleOf(screen.getByTestId('inherit'));
    expect(inherit).not.toHaveProperty('fontFamily');
    expect(inherit.color).toBe('red');
    expect(styleOf(screen.getByTestId('own')).fontFamily).toBe('NotoSansJP_400Regular');
  });

  it('TextInput も字形を当てる (入力した文字と placeholder)', () => {
    render(
      <FontsReadyProvider ready>
        <TextInput testID="input" style={{ fontSize: 15, fontWeight: '600' }} placeholder="名前" />
      </FontsReadyProvider>,
    );
    const style = styleOf(screen.getByTestId('input'));
    expect(style.fontFamily).toBe('NotoSansJP_700Bold');
    expect(style).not.toHaveProperty('fontWeight');
  });
});

describe('Text — 読み込みに失敗・Provider の外 (システムの字形)', () => {
  it('fontWeight を残し、字形名は入れない', () => {
    render(
      <FontsReadyProvider ready={false}>
        <Text style={{ fontWeight: '800' }}>強調</Text>
      </FontsReadyProvider>,
    );
    const style = styleOf(screen.getByText('強調'));
    expect(style.fontWeight).toBe('800');
    expect(style).not.toHaveProperty('fontFamily');
  });

  it('Provider の外では、読み込めていない扱い (typography の太字は fontWeight に戻す)', () => {
    render(<Text style={typography.h1}>大見出し</Text>);
    const style = styleOf(screen.getByText('大見出し'));
    expect(style).not.toHaveProperty('fontFamily');
    expect(style.fontWeight).toBe('700');
    expect(style.fontSize).toBe(typography.h1.fontSize);
  });
});

describe('Text / TextInput — react-native の部品と同じに使える', () => {
  it('ref は react-native の部品 (TextInput は focus できる)', () => {
    const inputRef = createRef<TextInputInstance>();
    const textRef = createRef<TextInstance>();
    render(
      <FontsReadyProvider ready>
        <TextInput ref={inputRef} testID="input" />
        <Text ref={textRef}>文字</Text>
      </FontsReadyProvider>,
    );
    expect(typeof inputRef.current?.focus).toBe('function');
    expect(textRef.current).not.toBeNull();
  });

  it('style 以外の props (numberOfLines・onPress・accessibilityRole) はそのまま渡す', () => {
    const onPress = jest.fn();
    render(
      <Text numberOfLines={2} onPress={onPress} accessibilityRole="link">
        リンク
      </Text>,
    );
    const element = screen.getByText('リンク');
    expect(element.props.numberOfLines).toBe(2);
    expect(element.props.accessibilityRole).toBe('link');
    fireEvent.press(element);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
