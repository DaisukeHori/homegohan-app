// アプリの版 (app.json の expo.version) を取る (#1660)
//
// これまでハンズオンツアーの analytics は app_version を '1.0.0' と直書きしており、実際の版 (app.json の expo.version) と
// 食い違っていた。版は Expo の設定 (Constants.expoConfig.version) から取り、ここの関数にまとめる。
//   - readExpoAppVersion: 取れた版をそのまま返す (取れなければ null)。サーバーへのヘッダ (X-App-Version) など、無ければ送らない用途
//   - getAnalyticsAppVersion: analytics の共通項目 app_version 用。analytics の schema (CommonPropertiesSchema) は
//     "x.y.z" の形を要求するので、取れない・形が違うときは APP_VERSION_UNKNOWN を返す
//
// expo-application の nativeApplicationVersion は依存に無いため使わない (expo-constants は既に依存にある)。

import Constants from 'expo-constants';
import { CommonPropertiesSchema } from '@homegohan/handson-tour-shared';

/**
 * 版が取れないときに analytics に入れる値。
 * analytics の schema が "x.y.z" を要求するため形はそろえ、実在しない版 (0.0.0) にして「取れなかった」と分かるようにする。
 */
export const APP_VERSION_UNKNOWN = '0.0.0';

/** Expo の設定 (app.json の expo.version) にある版。取れなければ null (例外は投げない) */
export function readExpoAppVersion(): string | null {
  try {
    const version = Constants.expoConfig?.version;
    return typeof version === 'string' && version !== '' ? version : null;
  } catch {
    return null;
  }
}

/** analytics の app_version に入れる版。Expo の設定の版が "x.y.z" ならそれを、そうでなければ APP_VERSION_UNKNOWN */
export function getAnalyticsAppVersion(): string {
  const version = readExpoAppVersion();
  if (version !== null && CommonPropertiesSchema.shape.app_version.safeParse(version).success) {
    return version;
  }
  return APP_VERSION_UNKNOWN;
}
