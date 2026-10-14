/**
 * 利用者別の localStorage のキー (Web とモバイルアプリの WebView で共有。#1037)
 *
 * ログイン中の利用者に属する localStorage のキーを、ここ 1 か所に列挙する。
 * 共有端末で次にログインする別の利用者へ前の利用者の設定・生成の進行状況が残らないよう、ログアウトで消す。
 *
 * 消す側は 2 つあり、どちらもこの一覧を読む (一覧を二重に持たない)。
 *   - Web: src/lib/user-storage.ts の clearUserScopedLocalStorage()。Web の画面のログアウト・退会で、signOut の前に呼ぶ
 *   - モバイルアプリ: apps/mobile/src/lib/webViewUserStorageCleanup.ts。ネイティブのログアウト・退会のあと、
 *     次に WebView を開いたとき、Web のページが読み込まれる前に、注入する JS で同じキーを消す
 *     (アプリの中のログアウト・退会はネイティブの設定画面だけで行い、Web の画面の掃除の経路を通らないため)
 *
 * キーを足すときは、ここに足すだけでよい (後ろに ID が付くキーは USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES に接頭辞を足す)。
 * Web とモバイルアプリの両方の掃除が自動で追随する
 * (src/__tests__/lib/user-scoped-storage-keys.test.ts と apps/mobile/__tests__/lib/web-view-user-storage-cleanup.test.ts が検査する)。
 */

/** ログイン中の利用者に属する localStorage のキー。ログアウトで消す */
export const USER_SCOPED_LOCAL_STORAGE_KEYS: readonly string[] = [
  // AI generate modal – range settings (v4_range_days, v4_include_existing)
  'v4_range_days',
  'v4_include_existing',
  // In-progress generation state trackers
  'v4MenuGenerating',
  'weeklyMenuGenerating',
  'singleMealGenerating',
  'shoppingListRegenerating',
  // Profile reminder dismissal
  'profile_reminder_dismissed',
];

/**
 * 家族の表示の切り替え (誰の献立を見せるか) を家族ごとに覚えるキーの接頭辞 (src/hooks/useFamilyView.ts)。
 * 実際のキーは `${接頭辞}${familyId}`。
 */
export const FAMILY_VIEW_STATE_KEY_PREFIX = 'familyViewState_';

/**
 * ログイン中の利用者に属する localStorage のキーの接頭辞 (#1599)。
 * キーの後ろに ID が付くもの (家族ごとなど) は、決まったキーの一覧 (USER_SCOPED_LOCAL_STORAGE_KEYS) に書けないので、
 * 接頭辞で消す。消す側 (Web の clearUserScopedLocalStorage・モバイルアプリが WebView に注入する掃除の JS) は、
 * localStorage のキーのうち、この接頭辞で始まるものもすべて消す。
 */
export const USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES: readonly string[] = [
  // 家族の表示の切り替え。選んだのはログイン中の利用者で、値には前の利用者の家族の members の ID が入る。
  // 同じ家族の別の利用者がこの端末でログインすると、前の利用者が選んだ絞り込みがそのまま掛かる
  FAMILY_VIEW_STATE_KEY_PREFIX,
];

/**
 * 利用者別の localStorage を消したこと (= サインアウト) を知らせる window のイベント。
 * localStorage に無い、メモリに持っている利用者別の状態 (外国の AI 事業者への提供の同意の状況など、
 * src/hooks/useAiConsent.tsx) を、同じタブで次にログインする別の利用者へ引き継がないために、持ち主が聞いて捨てる。
 */
export const USER_SCOPED_STORAGE_CLEARED_EVENT = 'homegohan:user-scoped-storage-cleared';
