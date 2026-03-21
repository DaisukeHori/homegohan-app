import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, Input, PageHeader, SectionHeader } from "../../../src/components/ui";
import { colors, spacing, radius } from "../../../src/theme";
import { getApi } from "../../../src/lib/api";

const MOOD_OPTIONS = [
  { value: 1, label: "1", emoji: "😞" },
  { value: 2, label: "2", emoji: "😕" },
  { value: 3, label: "3", emoji: "😐" },
  { value: 4, label: "4", emoji: "😊" },
  { value: 5, label: "5", emoji: "😄" },
];

const SLEEP_OPTIONS = [
  { value: 1, label: "1", emoji: "😴" },
  { value: 2, label: "2", emoji: "🥱" },
  { value: 3, label: "3", emoji: "😌" },
  { value: 4, label: "4", emoji: "😊" },
  { value: 5, label: "5", emoji: "🌟" },
];

export default function HealthQuickRecordPage() {
  const [recordDate, setRecordDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [weight, setWeight] = useState("");
  const [moodScore, setMoodScore] = useState<number | null>(null);
  const [sleepQuality, setSleepQuality] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit() {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      const body: any = { record_date: recordDate };
      if (weight) body.weight = parseFloat(weight);
      if (moodScore) body.mood_score = moodScore;
      if (sleepQuality) body.sleep_quality = sleepQuality;

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
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="クイック記録" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      {/* 日付 */}
      <Input
        label="日付"
        value={recordDate}
        onChangeText={setRecordDate}
        placeholder="YYYY-MM-DD"
      />

      {/* 体重 */}
      <Card>
        <View style={{ gap: spacing.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <View style={{ width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.purpleLight, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="scale" size={18} color={colors.purple} />
            </View>
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>体重</Text>
          </View>
          <Input
            value={weight}
            onChangeText={setWeight}
            keyboardType="decimal-pad"
            placeholder="60.2"
          />
          <Text style={{ fontSize: 12, color: colors.textMuted }}>kg</Text>
        </View>
      </Card>

      {/* 気分 */}
      <Card>
        <View style={{ gap: spacing.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <View style={{ width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.successLight, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="happy" size={18} color={colors.success} />
            </View>
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>気分</Text>
          </View>
          <View style={{ flexDirection: "row", gap: spacing.sm, justifyContent: "space-around" }}>
            {MOOD_OPTIONS.map((opt) => {
              const selected = moodScore === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => setMoodScore(opt.value)}
                  style={{
                    alignItems: "center",
                    gap: 4,
                    padding: spacing.sm,
                    borderRadius: radius.md,
                    backgroundColor: selected ? colors.successLight : "transparent",
                    borderWidth: 1,
                    borderColor: selected ? colors.success : "transparent",
                    minWidth: 50,
                  }}
                >
                  <Text style={{ fontSize: 24 }}>{opt.emoji}</Text>
                  <Text style={{ fontSize: 12, fontWeight: "700", color: selected ? colors.success : colors.textMuted }}>{opt.value}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </Card>

      {/* 睡眠 */}
      <Card>
        <View style={{ gap: spacing.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <View style={{ width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.blueLight, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="bed" size={18} color={colors.blue} />
            </View>
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>睡眠の質</Text>
          </View>
          <View style={{ flexDirection: "row", gap: spacing.sm, justifyContent: "space-around" }}>
            {SLEEP_OPTIONS.map((opt) => {
              const selected = sleepQuality === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => setSleepQuality(opt.value)}
                  style={{
                    alignItems: "center",
                    gap: 4,
                    padding: spacing.sm,
                    borderRadius: radius.md,
                    backgroundColor: selected ? colors.blueLight : "transparent",
                    borderWidth: 1,
                    borderColor: selected ? colors.blue : "transparent",
                    minWidth: 50,
                  }}
                >
                  <Text style={{ fontSize: 24 }}>{opt.emoji}</Text>
                  <Text style={{ fontSize: 12, fontWeight: "700", color: selected ? colors.blue : colors.textMuted }}>{opt.value}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </Card>

      <Button onPress={submit} loading={isSubmitting}>
        {isSubmitting ? "保存中..." : "記録を保存"}
      </Button>
    </ScrollView>
    </View>
  );
}
