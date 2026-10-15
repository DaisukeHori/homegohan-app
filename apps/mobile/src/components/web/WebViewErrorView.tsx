import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { colors } from '../../theme/colors';

/**
 * WebView の読み込みに失敗したときに出す画面 (#1612 / #1049 F7-15)。
 *
 * 以前は失敗したときの表示が何も無く、オフライン・DNS の失敗・時間切れではライブラリの既定の英語の文が出るだけ、
 * サーバーが 5xx を返したときはサーバーのエラーページがそのまま出て、どちらもやり直す手段が無かった
 * (iOS で起動時にオフラインだと about:blank のまま止まり、戻れるのはタブの再タップだけだった)。
 */

export type WebViewFailure =
  /** 端末側の読み込みの失敗 (オフライン・DNS・接続・TLS・時間切れなど)。WebView の onError / renderError */
  | { kind: 'network' }
  /** サーバーが 5xx (503 を除く) を返した。WebView の onHttpError。503 は Web のページ (メンテナンス中の画面など) をそのまま見せる (useWebViewHttpFailure.ts の shouldCoverHttpStatus) */
  | { kind: 'server'; statusCode: number };

export const WEB_VIEW_ERROR_TITLE = '画面を読み込めませんでした';
export const WEB_VIEW_RETRY_LABEL = '再読み込み';

/** 失敗の種類ごとの案内の文 */
export function describeWebViewFailure(failure: WebViewFailure): string {
  if (failure.kind === 'server') {
    return `サーバーでエラーが起きました (エラー ${failure.statusCode})。しばらくしてから、もう一度お試しください。`;
  }
  return '通信に失敗しました。ネットワークの接続を確かめて、もう一度お試しください。';
}

interface Props {
  failure: WebViewFailure;
  /** 「再読み込み」を押したとき。WebView を認証ブリッジから作り直す (WebViewScreen を参照) */
  onRetry: () => void;
  testID?: string;
}

export const WebViewErrorView: React.FC<Props> = ({ failure, onRetry, testID = 'webview-error' }) => (
  <View
    testID={testID}
    accessibilityRole="alert"
    // WebView の上に重ねて全面を覆う (読み込めていない WebView・サーバーのエラーページを見せない)
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
    <Text testID={`${testID}-message`} style={{ fontSize: 14, lineHeight: 21, color: colors.textLight, textAlign: 'center' }}>
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
