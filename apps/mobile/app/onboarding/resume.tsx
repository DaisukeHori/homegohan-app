import { router } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { supabase } from "../../src/lib/supabase";
import { useProfile } from "../../src/providers/ProfileProvider";

// モバイル版: 再開ウェルカム画面 (OB-UI-04)
export default function OnboardingResume() {
  const { profile, refresh } = useProfile();
  const [isResetting, setIsResetting] = useState(false);

  const progress = profile?.onboardingProgress;
  const progressPercent = progress
    ? Math.round((progress.currentStep / progress.totalQuestions) * 100)
    : 0;

  const handleReset = () => {
    Alert.alert(
      "確認",
      "これまでの回答がすべてリセットされます。本当に最初からやり直しますか？",
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "リセット",
          style: "destructive",
          onPress: async () => {
            setIsResetting(true);
            try {
              const { data: auth } = await supabase.auth.getUser();
              if (auth.user) {
                await supabase
                  .from("user_profiles")
                  .update({
                    onboarding_started_at: null,
                    onboarding_progress: null,
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", auth.user.id);
                await refresh();
                router.replace("/onboarding/welcome");
              }
            } catch (error) {
              console.error("Reset failed:", error);
              Alert.alert("エラー", "リセットに失敗しました。");
            } finally {
              setIsResetting(false);
            }
          },
        },
      ]
    );
  };

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
        <Text style={{ fontSize: 40 }}>👋</Text>
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
          おかえりなさい{profile?.nickname ? `、\n${profile.nickname}さん` : ""}！
        </Text>
        <Text
          style={{
            fontSize: 16,
            color: "#6B7280",
            textAlign: "center",
            lineHeight: 24,
          }}
        >
          前回の設定の続きから再開しましょう
        </Text>
      </View>

      {/* 進捗カード */}
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
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <Text style={{ fontWeight: "700", color: "#4B5563" }}>設定の進捗</Text>
          <Text style={{ fontWeight: "700", color: "#FF8A65" }}>{progressPercent}%</Text>
        </View>
        <View
          style={{
            height: 8,
            backgroundColor: "#E5E7EB",
            borderRadius: 999,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              height: 8,
              width: `${progressPercent}%`,
              backgroundColor: "#FF8A65",
              borderRadius: 999,
            }}
          />
        </View>
        <Text
          style={{
            fontSize: 12,
            color: "#9CA3AF",
            textAlign: "center",
            marginTop: 8,
          }}
        >
          {progress?.currentStep || 0} / {progress?.totalQuestions || 0} 問完了
        </Text>
      </View>

      {/* ボタン */}
      <View style={{ width: "100%", gap: 12, marginTop: 8 }}>
        <Pressable
          onPress={() => router.push("/onboarding/questions?resume=true")}
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
            続きから再開
          </Text>
        </Pressable>

        <Pressable
          onPress={handleReset}
          disabled={isResetting}
          style={{
            borderWidth: 2,
            borderColor: "#E5E7EB",
            paddingVertical: 16,
            borderRadius: 999,
            alignItems: "center",
            opacity: isResetting ? 0.5 : 1,
          }}
        >
          <Text style={{ color: "#6B7280", fontWeight: "700", fontSize: 14 }}>
            {isResetting ? "リセット中..." : "最初からやり直す"}
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
