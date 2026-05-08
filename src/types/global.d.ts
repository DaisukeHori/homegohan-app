/**
 * グローバル window 拡張型定義
 *
 * Bug-5 (#21): weekly メニューページが現在表示中の日付を window.__weeklyCurrentDate に
 * publish し、AIChatBubble 等の別コンポーネントが参照する。
 */
export {};

declare global {
  interface Window {
    __weeklyCurrentDate?: string;
  }
}
