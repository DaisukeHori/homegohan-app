import { useEffect } from 'react';
import { useNavigation } from 'expo-router';

/**
 * この hook が navigation で使うもの。useNavigation() の既定の型はルートのナビゲーターの型で、
 * 'blur' の購読・setParams・親の取得をこの形で持たないので、使う部分だけを型で宣言して useNavigation の型引数に渡す。
 * getState / getParent は、ナビゲーターの外 (テストの差し替えなど) では無いことがあるので、任意にする。
 */
type InitialPathNavigation = {
  addListener: (event: 'blur', callback: () => void) => () => void;
  setParams: (params: { initialPath?: string }) => void;
  /** この画面を持つナビゲーターの状態。タブのナビゲーターなら type が 'tab' */
  getState?: () => { type?: string } | undefined;
  /** タブのナビゲーターを持つ親の画面 (ルートのスタックの '(tabs)') */
  getParent?: () => { isFocused: () => boolean } | undefined;
};

/** React Navigation のタブのナビゲーターの状態の type */
const TAB_NAVIGATOR_STATE_TYPE = 'tab';

/**
 * 他のタブへ移ったら、このタブに残っている initialPath を消す (#1612 / #1049 F7-15)。
 *
 * initialPath は「そのページを開いてこのタブに入る」ための一回きりの指定 (WebView の中のタブ間のリンクや deep link で渡される)。
 * タブの route の params に残ったままだと、
 *   - あとで同じ指定を渡し直しても、値が変わらないので WebView が読み込み直さない
 *     (例: 献立のタブを買い物リストのモーダル付きで開く → 別のタブへ → もう一度同じリンク → モーダルが開かない)
 *   - パラメータを付けずにタブへ移る (router.push(<タブ>)) と、古い指定がそのまま残る
 * ことがある。タブを離れた時点で指定を消し、次に入るときは新しい指定か、タブの先頭から始める。
 * 消すと WebViewScreen の effectivePath がタブの先頭に戻り、裏で読み込み直す (認証ブリッジからやり直す)。
 *
 * 'blur' は、別のタブへ移ったときだけでなく、タブの画面の上にネイティブの画面 (設定・AI の同意など) を重ねたときにも届く。
 * 後者で消すと、戻ったときにページが先頭に戻ってしまうので、
 *   - この画面がタブのナビゲーターの中にあり (タブ以外の WebViewScreen = /settings/ai-consent などでは何もしない)
 *   - タブを持つ親の画面が今も一番手前にある (= タブ同士の移動である)
 * ときだけ消す。状態が分からない場合は消さない (今までどおりの挙動に倒す)。
 */
export function useResetInitialPathOnBlur(hasInitialPath: boolean): void {
  const navigation = useNavigation<InitialPathNavigation>();

  useEffect(() => {
    if (!hasInitialPath) return undefined;
    const unsubscribe = navigation.addListener('blur', () => {
      if (navigation.getState?.()?.type !== TAB_NAVIGATOR_STATE_TYPE) return;
      const tabsAreStillOnTop = navigation.getParent?.()?.isFocused() === true;
      if (!tabsAreStillOnTop) return;
      navigation.setParams({ initialPath: undefined });
    });
    return unsubscribe;
  }, [navigation, hasInitialPath]);
}
