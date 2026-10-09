// 設定エラーの画面 (#1182)
//
// 必須の環境変数 (EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY) が入っていないビルドで、
// app/_layout.tsx が Provider を立ち上げる代わりに出す。以前は存在しない接続先 (placeholder) でアプリを起動し続け、
// ログイン画面が出るのにログインが接続エラーで失敗するだけで、原因が分からなかった。
//
// 守ること:
//  - Provider の外で描画される (ルートの layout が、Provider を立ち上げる前に返す)。ErrorFallback と同じく
//    useAuth / useProfile / useSafeAreaInsets などの hooks を使わない。
//  - 出すのは環境変数の「名前」だけ。値は出さない (読まない)。
//  - 利用者が直せる問題ではない (ビルドを作り直す必要がある) ので、再試行のボタンは出さない。

import { Text, View } from "react-native";

import { colors, radius, spacing } from "../theme";

export type ConfigErrorScreenProps = {
  /** 足りない環境変数の名前 */
  missing: readonly string[];
};

export function ConfigErrorScreen({ missing }: ConfigErrorScreenProps) {
  return (
    <View
      testID="config-error-screen"
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.bg,
        paddingHorizontal: spacing["2xl"],
      }}
    >
      <View accessibilityRole="alert" style={{ alignItems: "center", marginBottom: spacing["3xl"] }}>
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
          アプリの設定が不足しています
        </Text>
        <Text style={{ fontSize: 14, lineHeight: 21, color: colors.textLight, textAlign: "center" }}>
          このアプリには、サーバーに接続するための設定が入っていません。{"\n"}
          お手数ですが、アプリを最新版に更新するか、運営までお問い合わせください。
        </Text>
      </View>

      {missing.length > 0 ? (
        <View testID="config-error-missing" style={{ alignItems: "center" }}>
          {/* 12px の小さい文字なので、背景 (colors.bg) の上で AA (4.5:1) に届く textLight にする (textMuted は届かない) */}
          <Text style={{ fontSize: 12, lineHeight: 18, color: colors.textLight, textAlign: "center" }}>
            開発者向け: 次の環境変数がビルドに入っていません
          </Text>
          {missing.map((name) => (
            <Text
              key={name}
              selectable
              style={{ fontSize: 12, lineHeight: 18, color: colors.textLight, textAlign: "center" }}
            >
              {name}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
