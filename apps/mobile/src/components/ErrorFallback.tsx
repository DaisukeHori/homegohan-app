// 画面の描画中に起きた例外を受ける、エラー画面 (#1207)
//
// expo-router は、ルートのファイル (_layout.tsx を含む) が `export function ErrorBoundary` を持っていると、
// その中の画面で起きた描画の例外をそこで受けて、{ error, retry } を渡す。持っていないと例外は誰にも
// 受けられず、アプリ全体がクラッシュ (白い画面) する。各 _layout.tsx がこの部品を返す ErrorBoundary を
// エクスポートする。
//
// 守ること:
//  - Provider の外でも描画できるようにする。ルートの境界は、Provider ごとルートの layout を置き換えて
//    描画される。そのため useAuth / useProfile / useSafeAreaInsets などの hooks は使わない。
//  - 例外の文面・スタックは画面に出さない。
//  - 例外は表示時に 1 回だけ記録する (src/lib/error-report.ts)。記録の失敗でこの画面を壊さない。
//  - 「再試行」は expo-router が渡す retry (画面を作り直す)。
//  - 「ホームへ戻る」(homeHref を渡した境界だけ) は、同じ画面が毎回同じ例外を投げる場合の逃げ道。
//    移動先は、この境界がある区画の「外」にすること。router.replace は expo-router の中でキューに積まれて
//    あとから実行されるので、区画の中への移動は、その区画のナビゲーターが壊れている間は効かない
//    (区画の外なら、ルートの Stack が動いているので確実に移動でき、移動すればこの境界ごと外れる)。
//    ルートの境界にはナビゲーションが残っていないので、逃げ道は出さない (再試行だけ)。

import { router } from "expo-router";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";

import { reportBoundaryError } from "../lib/error-report";
import { colors, radius, spacing } from "../theme";

export type ErrorFallbackProps = {
  /** expo-router が渡す例外 */
  error: Error;
  /** expo-router が渡す、画面を作り直す関数 */
  retry: () => Promise<void> | void;
  /** どの境界か。記録に残す */
  boundary: string;
  /** 指定すると「逃げ道」のボタンを出す。移動先 (この境界がある区画の外の画面。例: '/') */
  homeHref?: string;
  /** 逃げ道のボタンの文言 */
  homeLabel?: string;
};

export function ErrorFallback({
  error,
  retry,
  boundary,
  homeHref,
  homeLabel = "ホームへ戻る",
}: ErrorFallbackProps) {
  useEffect(() => {
    reportBoundaryError(boundary, error);
  }, [boundary, error]);

  const runRetry = () => {
    try {
      void Promise.resolve(retry()).catch(() => {});
    } catch {
      // ignore
    }
  };

  const goHome = () => {
    if (homeHref) {
      try {
        router.replace(homeHref as never);
        // 移動すれば、この境界ごと外れる。作り直しは要らない (作り直すと、同じ画面がまた例外を投げて重複して記録される)
        return;
      } catch {
        // ナビゲーションが使えないときは、作り直しだけでも試す
      }
    }
    runRetry();
  };

  return (
    <View
      testID="error-fallback"
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.bg,
        paddingHorizontal: spacing["2xl"],
      }}
    >
      <View
        accessibilityRole="alert"
        style={{ alignItems: "center", marginBottom: spacing["3xl"] }}
      >
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: radius.full,
            backgroundColor: colors.errorLight,
            alignItems: "center",
            justifyContent: "center",
            marginBottom: spacing["2xl"],
          }}
        >
          <Text style={{ fontSize: 32, color: colors.error }}>!</Text>
        </View>
        <Text
          accessibilityRole="header"
          style={{ fontSize: 20, fontWeight: "700", color: colors.text, marginBottom: spacing.sm }}
        >
          エラーが発生しました
        </Text>
        <Text style={{ fontSize: 14, lineHeight: 21, color: colors.textLight, textAlign: "center" }}>
          画面の表示中に問題が起きました。{"\n"}もう一度お試しください。
        </Text>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: spacing.md }}>
        <Pressable
          testID="error-fallback-retry"
          accessibilityRole="button"
          accessibilityLabel="再試行"
          onPress={runRetry}
          style={({ pressed }) => ({
            backgroundColor: pressed ? colors.accentDark : colors.accent,
            paddingVertical: spacing.md,
            paddingHorizontal: spacing["2xl"],
            borderRadius: radius.full,
          })}
        >
          <Text style={{ color: "#FFFFFF", fontSize: 15, fontWeight: "700" }}>再試行</Text>
        </Pressable>

        {homeHref ? (
          <Pressable
            testID="error-fallback-home"
            accessibilityRole="button"
            accessibilityLabel={homeLabel}
            onPress={goHome}
            style={({ pressed }) => ({
              backgroundColor: pressed ? "#E0E0E0" : "#EEEEEE",
              paddingVertical: spacing.md,
              paddingHorizontal: spacing["2xl"],
              borderRadius: radius.full,
            })}
          >
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: "700" }}>{homeLabel}</Text>
          </Pressable>
        ) : null}
      </View>

      <Text
        style={{
          marginTop: spacing["2xl"],
          fontSize: 12,
          lineHeight: 18,
          color: colors.textMuted,
          textAlign: "center",
        }}
      >
        直らないときは、アプリを一度終了して開き直してください。
      </Text>
    </View>
  );
}
