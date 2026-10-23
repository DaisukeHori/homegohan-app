/**
 * Apple のログインのボタン (docs/design/mobile/08-sign-in-with-apple.md §10.1)。
 * OS が描く AppleAuthenticationButton (Apple の見た目・言語・VoiceOver) を使う。出す条件 (iOS・スイッチ・端末の対応) を満たさないときは何も描かない。
 * 高さは同じ画面の Google のボタンと同じにする (HIG: ほかのログインのボタンより小さくしない。R-1)。画面は useAuthProviderButtonHeight の
 * height をこの部品の height に、onGoogleButtonLayout を Google のボタンの onLayout に渡し、Google のボタンの style に
 * minHeight: AUTH_PROVIDER_BUTTON_MIN_HEIGHT を足す。
 */
import * as AppleAuthentication from "expo-apple-authentication";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import type { LayoutChangeEvent } from "react-native";

import { isAppleSignInAvailable } from "../../lib/appleSignIn";
import { radius } from "../../theme";

/**
 * ログイン・新規登録の画面の Apple と Google のボタンの下限の高さ (pt)。Google のボタンには minHeight として、Apple のボタンには
 * useAuthProviderButtonHeight の初めの値と下限として使う。
 * 根拠: Google のボタンの中身なりの高さ (paddingVertical 14 × 2 + 枠 1 × 2 + アイコン 20 と 15pt の題名の行の高さの大きいほう) は
 * 標準の文字の大きさで約 50〜52 (行の高さは書体の値で決まる見積もり。設計書 §0.2 F-17) なので、それより大きい 56 にして、標準では
 * 2 つのボタンがちょうどこの高さで並ぶようにする (Apple のボタンが測った高さを待たずに同じ高さで出る)。56 は Web のボタンの高さと
 * HIG の例 (56pt) と同じ。HIG の最小 30pt を満たす。見た目の値で、運用で変える値ではないので環境変数にしない。
 */
export const AUTH_PROVIDER_BUTTON_MIN_HEIGHT = 56;
/** 押せないときの薄さ (Google のボタンの pressed / isSubmitting と同じ 0.7) */
const DISABLED_OPACITY = 0.7;

export type AppleSignInButtonKind = "sign_in" | "sign_up";

const BUTTON_TYPE: Record<AppleSignInButtonKind, AppleAuthentication.AppleAuthenticationButtonType> = {
  sign_in: AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN,
  sign_up: AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP,
};

/**
 * Apple のボタンの高さを、同じ画面の Google のボタンの実際の高さに合わせる (R-1)。
 * 端末の文字の大きさの設定で Google の題名が大きくなりボタンが伸びたときも (RN の Text は既定で設定に従う。設計書 §0.2 F-17)、
 * Apple のボタンを同じ高さにする (OS が描く Apple のボタンの高さは style でしか決まらない。F-16)。
 * height の初めの値と下限は AUTH_PROVIDER_BUTTON_MIN_HEIGHT (Google のボタンの minHeight と同じ)。
 */
export function useAuthProviderButtonHeight(): { height: number; onGoogleButtonLayout: (event: LayoutChangeEvent) => void } {
  const [height, setHeight] = useState<number>(AUTH_PROVIDER_BUTTON_MIN_HEIGHT);
  const onGoogleButtonLayout = useCallback((event: LayoutChangeEvent) => {
    setHeight(Math.max(AUTH_PROVIDER_BUTTON_MIN_HEIGHT, event.nativeEvent.layout.height));
  }, []);
  return { height, onGoogleButtonLayout };
}

export function AppleSignInButton(props: { kind: AppleSignInButtonKind; onPress: () => void; disabled: boolean; testID: string; height: number }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    isAppleSignInAvailable().then((value) => alive && setAvailable(value));
    return () => {
      alive = false;
    };
  }, []);
  if (!available) return null;
  return (
    <View testID={props.testID} pointerEvents={props.disabled ? "none" : "auto"} style={{ opacity: props.disabled ? DISABLED_OPACITY : 1 }}>
      <AppleAuthentication.AppleAuthenticationButton
        buttonType={BUTTON_TYPE[props.kind]}
        buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE_OUTLINE}
        cornerRadius={radius.lg}
        style={{ width: "100%", height: props.height }}
        onPress={props.onPress}
      />
    </View>
  );
}
