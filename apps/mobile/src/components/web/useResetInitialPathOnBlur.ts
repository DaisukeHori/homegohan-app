import { useEffect } from 'react';
import { useLocalSearchParams, useNavigation } from 'expo-router';

/** タブ画面の navigation のうち、使う部分 */
type TabNavigation = {
  addListener: (type: 'blur', listener: () => void) => () => void;
  setParams?: (params: Record<string, unknown>) => void;
  getParent?: () => { isFocused?: () => boolean } | undefined;
};

/**
 * 他のタブへ移ったら、このタブに残っている initialPath を消す (#1049 F7-15)。
 *
 * initialPath は「そのページを開いてこのタブに入る」ための一回きりの指定 (WebView 内のタブ間リンクや
 * 通知のタップで渡される)。タブの route の params に残ったままだと、
 *  - あとで同じ指定を渡し直しても、値が変わらないので WebView が動かない
 *  - タブの先頭へ移りたいだけの移動でも、古い指定が優先されて先頭に戻れない
 * ことがある。タブを離れた時点で指定を消し、次に入るときは新しい指定か、タブの先頭から始める。
 *
 * 'blur' は、別のタブへ移ったときだけでなく、タブ画面の上にネイティブの画面 (設定、AI 相談など) を
 * 重ねたときにも届く。後者で消すと、戻ったときにページが先頭に戻ってしまうので、
 * 「タブを持つ親の画面が、今も一番手前にある」(= タブ同士の移動である) ときだけ消す。
 * 親の画面が取れない・状態が分からない場合は消さない (今までどおりの挙動に倒す)。
 */
export function useResetInitialPathOnBlur(): void {
  const navigation = useNavigation() as unknown as TabNavigation;
  const params = useLocalSearchParams<{ initialPath?: string }>();
  const hasInitialPath = Boolean(params.initialPath);

  useEffect(() => {
    if (!hasInitialPath) return;
    const unsubscribe = navigation.addListener('blur', () => {
      const tabsAreStillOnTop = navigation.getParent?.()?.isFocused?.() === true;
      if (!tabsAreStillOnTop) return;
      navigation.setParams?.({ initialPath: undefined });
    });
    return unsubscribe;
  }, [navigation, hasInitialPath]);
}
