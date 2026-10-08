import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { colors } from '../../theme/colors';

/**
 * WebView の読み込みに失敗したときに出す画面 (#1049 F7-15)。
 *
 * 以前は失敗時の表示が何も無く、オフライン・DNS 失敗・タイムアウトでは英語のライブラリ既定の文字が出るだけ、
 * サーバーが 5xx を返したときはサーバーのエラーページがそのまま出て、どちらも再試行の手段が無かった。
 */

export type WebViewFailure =
  /** 端末側の読み込み失敗 (オフライン・DNS・接続・TLS・タイムアウトなど) */
  | { kind: 'network' }
  /** サーバーが 5xx を返した */
  | { kind: 'server'; statusCode: number };

export const WEB_VIEW_ERROR_TITLE = '画面を読み込めませんでした';
export const WEB_VIEW_RETRY_LABEL = '再読み込み';

/** 失敗の種類ごとの案内文 */
export function describeWebViewFailure(failure: WebViewFailure): string {
  if (failure.kind === 'server') {
    return `サーバーに接続できませんでした (エラー ${failure.statusCode})。しばらくしてから、もう一度お試しください。`;
  }
  return '通信に失敗しました。ネットワークの接続を確認して、もう一度お試しください。';
}

interface Props {
  failure: WebViewFailure;
  /** 「再読み込み」を押したとき。WebView を認証ブリッジからやり直す */
  onRetry: () => void;
  testID?: string;
}

export const WebViewErrorView: React.FC<Props> = ({ failure, onRetry, testID = 'webview-error' }) => (
  <View
    testID={testID}
    // WebView の上に重ねて全面を覆う (中身が読み込めていない WebView を見せない)
    style={{
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: '#FFF',
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 32,
      gap: 12,
    }}
  >
    <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, textAlign: 'center' }}>
      {WEB_VIEW_ERROR_TITLE}
    </Text>
    <Text style={{ fontSize: 14, lineHeight: 21, color: colors.textLight, textAlign: 'center' }}>
      {describeWebViewFailure(failure)}
    </Text>
    <Pressable
      testID={`${testID}-retry`}
      accessibilityRole="button"
      accessibilityLabel={WEB_VIEW_RETRY_LABEL}
      onPress={onRetry}
      style={({ pressed }) => ({
        marginTop: 8,
        paddingVertical: 12,
        paddingHorizontal: 28,
        borderRadius: 9999,
        backgroundColor: pressed ? colors.accentDark : colors.accent,
      })}
    >
      <Text style={{ fontSize: 15, fontWeight: '700', color: '#FFFFFF' }}>{WEB_VIEW_RETRY_LABEL}</Text>
    </Pressable>
  </View>
);
