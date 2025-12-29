import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";

export default function OnboardingComplete() {
  return (
    <View style={{ flex: 1, padding: 20, justifyContent: "center", gap: 16, alignItems: "center" }}>
      <Text style={{ fontSize: 42 }}>✨</Text>
      <Text style={{ fontSize: 26, fontWeight: "800" }}>準備完了！</Text>
      <Text style={{ color: "#666", textAlign: "center" }}>
        あなたに合わせた目標を設定しました。さっそく今日の食事を記録していきましょう。
      </Text>

      <Pressable
        onPress={() => router.replace("/(tabs)/home")}
        style={{ backgroundColor: "#333", paddingVertical: 14, paddingHorizontal: 18, borderRadius: 999 }}
      >
        <Text style={{ color: "white", fontWeight: "800" }}>ホームへ</Text>
      </Pressable>
    </View>
  );
}



