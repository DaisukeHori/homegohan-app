/**
 * #1867: 今の URL で文書を読み込み直す (src/components/navigation/HashHistoryEntryBridge.tsx の描き直しの最後の手段)。
 * window.location はテストで差し替えられない (jsdom で reload を spy できない) ので、呼び出しをこの 1 つの関数に分けて、テストではこのモジュールを差し替える。
 */
export function reloadCurrentDocument(): void {
  window.location.reload();
}
