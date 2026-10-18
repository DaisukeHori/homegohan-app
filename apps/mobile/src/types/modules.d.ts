declare module "react-native-markdown-display" {
  import type { ComponentProps } from "react";
  import type { StyleSheet, TextStyle, ViewStyle } from "react-native";

  type MarkdownStyles = {
    [key: string]: TextStyle | ViewStyle;
  };

  type MarkdownProps = {
    children: string;
    style?: MarkdownStyles;
    onLinkPress?: (url: string) => boolean;
  };

  const Markdown: React.ComponentType<MarkdownProps>;
  export default Markdown;
}

// react-native-webview 14.0.1 の index.d.ts は `class WebView<P = undefined> extends Component<WebViewProps & P>` で、
// 既定の P = undefined が props 全体を never にする (WebViewProps & undefined)。使う側が <WebView ... /> と書けなくなるので、
// 13.13.5 までと同じ形 (props は WebViewProps そのまま) に置き換える。props と event の型は、パッケージ自身の lib/WebViewTypes.d.ts を使う (#1591)。
// 実体 (lib/WebView.ios.js ほか) は変えない。ref の型 (useRef<WebView>) と injectJavaScript などの命令は 13.13.5 の宣言のまま。
declare module "react-native-webview" {
  import type { Component } from "react";
  import type { AndroidWebViewProps, IOSWebViewProps, WindowsWebViewProps } from "react-native-webview/lib/WebViewTypes";

  export type { FileDownload, WebViewMessageEvent, WebViewNavigation } from "react-native-webview/lib/WebViewTypes";

  export type WebViewProps = IOSWebViewProps & AndroidWebViewProps & WindowsWebViewProps;

  export class WebView<P = unknown> extends Component<WebViewProps & P> {
    /** webview の履歴を 1 つ戻る */
    goBack: () => void;
    /** webview の履歴を 1 つ進む */
    goForward: () => void;
    /** 今のページを読み込み直す */
    reload: () => void;
    /** 今のページの読み込みを止める */
    stopLoading(): void;
    /** JavaScript の文字列を実行する */
    injectJavaScript: (script: string) => void;
    /** 描画されているページにフォーカスする */
    requestFocus: () => void;
    /** webview へメッセージを送る */
    postMessage: (message: string) => void;
    /** (Android) 入力欄の自動補完のポップアップを消す */
    clearFormData?: () => void;
    /** リソースのキャッシュを消す (キャッシュはアプリ単位なので、使っている WebView すべてに効く) */
    clearCache: (includeDiskFiles: boolean) => void;
    /** (Android) webview の内部の戻る/進むの履歴を消す */
    clearHistory?: () => void;
  }

  export default WebView;
}

// @react-native-masked-view/masked-view 0.3.2 の型は `Constructor<ReactNative.NativeMethods>` を継承していて、NativeMethods は
// react-native 0.87 で消えた。継承元が壊れ、<MaskedView ... /> が JSX の部品として使えなくなるので、使う部分 (props) だけを宣言し直す (#1591)。
declare module "@react-native-masked-view/masked-view" {
  import type { Component, ReactElement } from "react";
  import type { ViewProps } from "react-native";

  export type MaskedViewProps = ViewProps & {
    maskElement: ReactElement;
    androidRenderingMode?: "software" | "hardware";
  };

  export default class MaskedView extends Component<MaskedViewProps> {}
}
