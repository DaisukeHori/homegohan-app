import { router } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../src/lib/api";

export default function HealthQuickRecordPage() {
  const [recordDate, setRecordDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [weight, setWeight] = useState("");
  const [moodScore, setMoodScore] = useState("");
  const [sleepQuality, setSleepQuality] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit() {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      const body: any = { record_date: recordDate };
      if (weight) body.weight = parseFloat(weight);
      if (moodScore) body.mood_score = parseInt(moodScore, 10);
      if (sleepQuality) body.sleep_quality = parseInt(sleepQuality, 10);

      const res = await api.post<any>("/api/health/records/quick", body);
      Alert.alert("記録しました", res?.message ?? "保存しました。");
      router.replace("/health/record");
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>クイック入力</Text>

      <View style={{ gap: 6 }}>
        <Text style={{ fontWeight: "900" }}>日付</Text>
        <TextInput
          value={recordDate}
          onChangeText={setRecordDate}
          placeholder="YYYY-MM-DD"
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
        />
      </View>

      <View style={{ gap: 6 }}>
        <Text style={{ fontWeight: "900" }}>体重 (kg)</Text>
        <TextInput
          value={weight}
          onChangeText={setWeight}
          keyboardType="decimal-pad"
          placeholder="例: 60.2"
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
        />
      </View>

      <View style={{ gap: 6 }}>
        <Text style={{ fontWeight: "900" }}>気分 (1-5)</Text>
        <TextInput
          value={moodScore}
          onChangeText={setMoodScore}
          keyboardType="number-pad"
          placeholder="例: 4"
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
        />
      </View>

      <View style={{ gap: 6 }}>
        <Text style={{ fontWeight: "900" }}>睡眠 (1-5)</Text>
        <TextInput
          value={sleepQuality}
          onChangeText={setSleepQuality}
          keyboardType="number-pad"
          placeholder="例: 3"
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
        />
      </View>

      <Pressable
        onPress={submit}
        style={{
          padding: 14,
          borderRadius: 12,
          alignItems: "center",
          backgroundColor: isSubmitting ? "#999" : "#333",
          marginTop: 8,
        }}
      >
        <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "保存中..." : "保存"}</Text>
      </Pressable>

      <Pressable onPress={() => router.back()} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>戻る</Text>
      </Pressable>
    </ScrollView>
  );
}



