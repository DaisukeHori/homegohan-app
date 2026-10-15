// react-native (0.79) は index.js で Networking (Libraries/Network/RCTNetworking) を公開しているが、
// TypeScript の型 (types/index.d.ts) には載っていない。使う部分 (clearCookies) だけを型で宣言する (#1612 F7-16)。
//   - iOS: NSHTTPCookieStorage の Cookie をすべて消す。消す Cookie が無ければ false を返す (Libraries/Network/RCTNetworking.mm)
//   - Android: WebView の CookieManager.removeAllCookies に転送する (ReactAndroid の ForwardingCookieHandler.kt)
// 実行時に無い場合に備え、使う側 (webViewUserStorageCleanup.ts) は関数であることを確かめてから呼ぶ。
import "react-native";

declare module "react-native" {
  export const Networking:
    | {
        clearCookies: (callback: (result: boolean) => void) => void;
      }
    | undefined;
}
