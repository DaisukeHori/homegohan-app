// ハンズオンツアーの analytics に載せる platform (#1642)
// Canonical: docs/design/family/09-onboarding-handson-tour/22-analytics.md §2.2 (共通 properties の platform: 'web' | 'ios' | 'android')
//
// 以前は Step 0〜4 の各画面が platform: 'ios' を直接書いていて、Android の端末でも 'ios' を送っていた。
// 実際に動いている端末 (react-native の Platform.OS) から取る。

import { Platform } from 'react-native';
import type { HandsonTourEventPayload } from '@homegohan/handson-tour-shared';

/** analytics の共通 properties の platform が許す値 (packages/handson-tour-shared の CommonPropertiesSchema と同じ) */
export type TourAnalyticsPlatform = HandsonTourEventPayload<'handson_tour_step_viewed'>['platform'];

/**
 * Platform.OS を analytics の platform に読み替える。
 * このアプリ (Expo) を作るのは iOS と Android だけ。Expo の web で動かしたときは 'web'。
 * Platform.OS が取りうるほかの値 (windows / macos) はこのアプリでは起きないので、iOS 側に寄せる。
 */
export function tourAnalyticsPlatformOf(os: typeof Platform.OS): TourAnalyticsPlatform {
  switch (os) {
    case 'android':
      return 'android';
    case 'web':
      return 'web';
    default:
      return 'ios';
  }
}

/** いま動いている端末の platform (呼んだ時点の Platform.OS から取る) */
export function tourAnalyticsPlatform(): TourAnalyticsPlatform {
  return tourAnalyticsPlatformOf(Platform.OS);
}
