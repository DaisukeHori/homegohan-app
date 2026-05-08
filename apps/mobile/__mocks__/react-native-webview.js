/**
 * react-native-webview Jest モック
 *
 * RNCWebViewModule はネイティブバイナリに依存するため、Jest 環境では
 * このスタブに差し替えて TurboModuleRegistry エラーを回避する。
 */
const React = require('react');
const { View } = require('react-native');

const WebView = (props) => {
  return React.createElement(View, { testID: props.testID ?? 'webview-mock' });
};

module.exports = { WebView };
