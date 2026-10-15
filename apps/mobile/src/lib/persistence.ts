/**
 * App の永続化キー定義。
 * WEB の localStorage キーと対応している。
 * 書いていた画面 (週の献立・単品の作り直し・買い物リストの作り直しのネイティブの画面) は、通常の操作で届かない画面として消した (#1598)。
 * 以前の版が端末に書いた値が残っていることがあるので、ログアウトで消すキー (src/lib/user-storage.ts) として一覧を残す。
 * v4_range_days は src/components/menu/V4GenerateModal.tsx が今も書く。
 *
 * - weeklyMenuGenerating: 週間献立 AI 生成中フラグ（2 分 TTL）
 * - singleMealGenerating: 単品 AI 生成中フラグ（2 分 TTL）
 * - shoppingListRegenerating: 買い物リスト再生成中フラグ（5 分 TTL）
 * - v4_range_days: V4Modal の期間モード設定（永続）
 *
 * V4 献立の生成中の状態 (Web の localStorage の v4MenuGenerating) は、アプリでは端末に保存しない
 * (読む処理が無かったため。#1049 F7-20。src/hooks/useV4MenuGeneration.ts)。
 */
export const PERSISTENCE_KEYS = {
  weeklyMenuGenerating: { key: 'weeklyMenuGenerating', ttl: 2 * 60 * 1000 },
  singleMealGenerating: { key: 'singleMealGenerating', ttl: 2 * 60 * 1000 },
  shoppingListRegenerating: { key: 'shoppingListRegenerating', ttl: 5 * 60 * 1000 },
  v4_range_days: { key: 'v4_range_days', ttl: Infinity },
} as const;
