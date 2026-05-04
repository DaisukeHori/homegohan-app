import AsyncStorage from '@react-native-async-storage/async-storage';

interface StoredItem<T> {
  data: T;
  expiresAt: number;
}

/**
 * TTL 付きで AsyncStorage にデータを保存する。
 *
 * @param key   ストレージキー
 * @param data  保存するデータ
 * @param ttlMs 有効期限（ミリ秒）。Infinity を渡すと永続保存。
 */
export async function setItemWithTTL<T>(key: string, data: T, ttlMs: number): Promise<void> {
  const item: StoredItem<T> = { data, expiresAt: Date.now() + ttlMs };
  await AsyncStorage.setItem(key, JSON.stringify(item));
}

/**
 * TTL 付きで AsyncStorage からデータを取得する。
 * TTL が切れている場合は自動削除して null を返す。
 *
 * @param key ストレージキー
 * @returns   データ、または null（未存在・TTL 切れ）
 */
export async function getItemWithTTL<T>(key: string): Promise<T | null> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return null;
  const item: StoredItem<T> = JSON.parse(raw);
  if (Date.now() > item.expiresAt) {
    await AsyncStorage.removeItem(key);
    return null;
  }
  return item.data;
}

/**
 * AsyncStorage からアイテムを削除する。
 *
 * @param key ストレージキー
 */
export async function clearItem(key: string): Promise<void> {
  await AsyncStorage.removeItem(key);
}

/**
 * App の永続化キー定義。
 * WEB の localStorage キーと対応している。
 *
 * - weeklyMenuGenerating: 週間献立 AI 生成中フラグ（2 分 TTL）
 * - singleMealGenerating: 単品 AI 生成中フラグ（2 分 TTL）
 * - shoppingListRegenerating: 買い物リスト再生成中フラグ（5 分 TTL）
 * - v4MenuGenerating: V4 献立生成中状態 { requestId, totalSlots, startedAt }（30 分 TTL）
 * - v4_range_days: V4Modal の期間モード設定（永続）
 */
export const PERSISTENCE_KEYS = {
  weeklyMenuGenerating: { key: 'weeklyMenuGenerating', ttl: 2 * 60 * 1000 },
  singleMealGenerating: { key: 'singleMealGenerating', ttl: 2 * 60 * 1000 },
  shoppingListRegenerating: { key: 'shoppingListRegenerating', ttl: 5 * 60 * 1000 },
  v4MenuGenerating: { key: 'v4MenuGenerating', ttl: 30 * 60 * 1000 },
  v4_range_days: { key: 'v4_range_days', ttl: Infinity },
} as const;
