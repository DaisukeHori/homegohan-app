import { router } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";

// モバイル版: 初回ウェルカム画面 (OB-UI-06)
export default function OnboardingWelcome() {
  return (
    <ScrollView
      contentContainerStyle={{
        flexGrow: 1,
        padding: 24,
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
      style={{ backgroundColor: "#FFF7ED" }}
    >
      {/* アイコン */}
      <View
        style={{
          width: 100,
          height: 100,
          borderRadius: 50,
          backgroundColor: "#FF8A65",
          justifyContent: "center",
          alignItems: "center",
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.15,
          shadowRadius: 12,
          elevation: 8,
        }}
      >
        <Text style={{ fontSize: 40 }}>🍳</Text>
      </View>

      {/* タイトル */}
      <View style={{ alignItems: "center", gap: 8 }}>
        <Text
          style={{
            fontSize: 28,
            fontWeight: "800",
            color: "#1F2937",
            textAlign: "center",
          }}
        >
          はじめまして！
        </Text>
        <Text
          style={{
            fontSize: 16,
            color: "#6B7280",
            textAlign: "center",
            lineHeight: 24,
          }}
        >
          私はあなたの食生活をサポートする{"\n"}
          AI栄養士「ほめゴハン」です。
        </Text>
      </View>

      {/* 説明カード */}
      <View
        style={{
          backgroundColor: "rgba(255,255,255,0.8)",
          borderRadius: 16,
          padding: 20,
          width: "100%",
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.05,
          shadowRadius: 8,
          elevation: 2,
        }}
      >
        <Text
          style={{
            fontSize: 14,
            color: "#4B5563",
            textAlign: "center",
            lineHeight: 22,
            marginBottom: 12,
          }}
        >
          あなたに最適な食事プランを作成するため、{"\n"}
          いくつか質問させてください。
        </Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
          }}
        >
          <Text style={{ fontSize: 12, color: "#9CA3AF" }}>⏱️</Text>
          <Text style={{ fontSize: 12, color: "#9CA3AF" }}>所要時間: 約3〜5分</Text>
        </View>
      </View>

      {/* ボタン */}
      <View style={{ width: "100%", gap: 12, marginTop: 8 }}>
        <Pressable
          onPress={() => router.push("/onboarding/questions")}
          style={{
            backgroundColor: "#333",
            paddingVertical: 18,
            borderRadius: 999,
            alignItems: "center",
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.2,
            shadowRadius: 8,
            elevation: 4,
          }}
        >
          <Text style={{ color: "white", fontWeight: "700", fontSize: 16 }}>
            はじめる
          </Text>
        </Pressable>

        <Pressable
          onPress={() => router.replace("/(tabs)/home")}
          style={{ alignItems: "center", paddingVertical: 12 }}
        >
          <Text style={{ color: "#9CA3AF", fontSize: 14 }}>あとで設定する</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
