import { NotoSansJP_400Regular } from '@expo-google-fonts/noto-sans-jp/400Regular';
import { NotoSansJP_500Medium } from '@expo-google-fonts/noto-sans-jp/500Medium';
import { NotoSansJP_700Bold } from '@expo-google-fonts/noto-sans-jp/700Bold';

import { fontFamilies } from './fonts';
import type { NotoSansJpFamily } from './fonts';

/**
 * 実行時に読み込む (expo-font の useFonts) Noto Sans JP の字形のファイル (#588)。
 *
 * パッケージの入口 (@expo-google-fonts/noto-sans-jp) からではなく、字形ごとの入口から読む。
 * 入口のファイルは 9 つの字形 (Thin〜Black、1 つ約 5.7 MB) を全部 require するので、
 * そこから読むと使わない 6 つの字形もアプリと OTA の更新に入ってしまうため。
 * ネイティブに埋め込まない (app.json の expo-font のプラグインを使わない) ので、ネイティブのビルドを
 * 作り直さずに OTA の更新で届く。
 */
export const notoSansJpFontSources: Record<NotoSansJpFamily, number> = {
  [fontFamilies.regular]: NotoSansJP_400Regular,
  [fontFamilies.medium]: NotoSansJP_500Medium,
  [fontFamilies.bold]: NotoSansJP_700Bold,
};
