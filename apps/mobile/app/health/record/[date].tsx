import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, Input, LoadingState, PageHeader } from "../../../src/components/ui";
import { colors, spacing, radius } from "../../../src/theme";
import { getApi } from "../../../src/lib/api";

type HealthRecord = {
  id: string;
  record_date: string;
  weight: number | null;
  body_fat_percentage: number | null;
  systolic_bp: number | null;
  diastolic_bp: number | null;
  heart_rate: number | null;
  body_temp: number | null;
  sleep_hours: number | null;
  sleep_quality: number | null;
  water_intake: number | null;
  step_count: number | null;
  bowel_movement: number | null;
  overall_condition: number | null;
  mood_score: number | null;
  energy_level: number | null;
  stress_level: number | null;
  daily_note: string | null;
};

type PrevRecord = {
  weight: number | null;
  body_fat_percentage: number | null;
  systolic_bp: number | null;
  diastolic_bp: number | null;
};

function toNum(v: string): number | undefined {
  const s = v.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function toInt(v: string): number | undefined {
  const s = v.trim();
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function DiffIndicator({ current, previous, unit, lower }: { current: string; previous: number | null; unit: string; lower?: boolean }) {
  if (previous == null || !current.trim()) return null;
  const val = parseFloat(current);
  if (!Number.isFinite(val)) return null;
  const diff = val - previous;
  if (diff === 0) return null;
  const isGood = lower ? diff < 0 : diff > 0;
  return (
    <Text style={{ fontSize: 11, color: isGood ? colors.success : colors.error, fontWeight: "600" }}>
      {diff > 0 ? "+" : ""}{diff.toFixed(1)} {unit}
    </Text>
  );
}

const SCORE_OPTIONS: { value: number; emoji: string }[][] = [
  // overall_condition
  [
    { value: 1, emoji: "😫" },
    { value: 2, emoji: "😔" },
    { value: 3, emoji: "😐" },
    { value: 4, emoji: "🙂" },
    { value: 5, emoji: "😄" },
  ],
  // mood_score
  [
    { value: 1, emoji: "😢" },
    { value: 2, emoji: "😔" },
    { value: 3, emoji: "😐" },
    { value: 4, emoji: "😊" },
    { value: 5, emoji: "🥰" },
  ],
  // energy_level
  [
    { value: 1, emoji: "🪫" },
    { value: 2, emoji: "🔋" },
    { value: 3, emoji: "⚡" },
    { value: 4, emoji: "💪" },
    { value: 5, emoji: "🚀" },
  ],
  // stress_level
  [
    { value: 1, emoji: "😌" },
    { value: 2, emoji: "🙂" },
    { value: 3, emoji: "😐" },
    { value: 4, emoji: "😰" },
    { value: 5, emoji: "🤯" },
  ],
  // sleep_quality
  [
    { value: 1, emoji: "😵" },
    { value: 2, emoji: "😪" },
    { value: 3, emoji: "😴" },
    { value: 4, emoji: "😌" },
    { value: 5, emoji: "🌟" },
  ],
];

function ScoreSelector({
  label,
  value,
  onChange,
  options,
  selectedColor,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  options: { value: number; emoji: string }[];
  selectedColor: string;
}) {
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={{ fontSize: 13, color: colors.textLight }}>{label}</Text>
      <View style={{ flexDirection: "row", gap: spacing.xs ?? 4, justifyContent: "space-around" }}>
        {options.map((opt) => {
          const selected = value === opt.value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => onChange(selected ? null : opt.value)}
              style={{
                flex: 1,
                alignItems: "center",
                gap: 2,
                paddingVertical: spacing.sm,
                borderRadius: radius.md,
                backgroundColor: selected ? colors.accentLight : "transparent",
                borderWidth: 2,
                borderColor: selected ? colors.accent : "transparent",
              }}
            >
              <Text style={{ fontSize: 22 }}>{opt.emoji}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function HealthRecordDetailPage() {
  const params = useLocalSearchParams<{ date?: string | string[] }>();
  const date = useMemo(() => {
    const d = params.date;
    if (!d) return null;
    return Array.isArray(d) ? d[0] : d;
  }, [params.date]);

  const [record, setRecord] = useState<HealthRecord | null>(null);
  const [previous, setPrevious] = useState<PrevRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 体組成
  const [weight, setWeight] = useState("");
  const [bodyFat, setBodyFat] = useState("");
  // バイタル
  const [sys, setSys] = useState("");
  const [dia, setDia] = useState("");
  const [heartRate, setHeartRate] = useState("");
  const [bodyTemp, setBodyTemp] = useState("");
  // 生活習慣
  const [sleepHours, setSleepHours] = useState("");
  const [sleepQuality, setSleepQuality] = useState<number | null>(null);
  const [water, setWater] = useState("");
  const [steps, setSteps] = useState("");
  const [bowelMovement, setBowelMovement] = useState("");
  // 体調・メンタル
  const [overallCondition, setOverallCondition] = useState<number | null>(null);
  const [moodScore, setMoodScore] = useState<number | null>(null);
  const [energyLevel, setEnergyLevel] = useState<number | null>(null);
  const [stressLevel, setStressLevel] = useState<number | null>(null);
  // メモ
  const [note, setNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  function hydrateForm(r: HealthRecord | null) {
    setWeight(r?.weight == null ? "" : String(r.weight));
    setBodyFat(r?.body_fat_percentage == null ? "" : String(r.body_fat_percentage));
    setSys(r?.systolic_bp == null ? "" : String(r.systolic_bp));
    setDia(r?.diastolic_bp == null ? "" : String(r.diastolic_bp));
    setHeartRate(r?.heart_rate == null ? "" : String(r.heart_rate));
    setBodyTemp(r?.body_temp == null ? "" : String(r.body_temp));
    setSleepHours(r?.sleep_hours == null ? "" : String(r.sleep_hours));
    setSleepQuality(r?.sleep_quality ?? null);
    setWater(r?.water_intake == null ? "" : String(r.water_intake));
    setSteps(r?.step_count == null ? "" : String(r.step_count));
    setBowelMovement(r?.bowel_movement == null ? "" : String(r.bowel_movement));
    setOverallCondition(r?.overall_condition ?? null);
    setMoodScore(r?.mood_score ?? null);
    setEnergyLevel(r?.energy_level ?? null);
    setStressLevel(r?.stress_level ?? null);
    setNote(r?.daily_note ?? "");
  }

  async function load() {
    if (!date) return;
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ record: HealthRecord | null; previous: PrevRecord | null }>(`/api/health/records/${encodeURIComponent(date)}`);
      setRecord(res.record);
      setPrevious(res.previous);
      hydrateForm(res.record);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [date]);

  async function save() {
    if (!date || isSaving) return;
    setIsSaving(true);
    try {
      const body: any = {};
      const vWeight = toNum(weight);
      const vBodyFat = toNum(bodyFat);
      const vSys = toInt(sys);
      const vDia = toInt(dia);
      const vHeartRate = toInt(heartRate);
      const vBodyTemp = toNum(bodyTemp);
      const vSleep = toNum(sleepHours);
      const vWater = toInt(water);
      const vSteps = toInt(steps);
      const vBowel = toInt(bowelMovement);

      if (vWeight !== undefined) body.weight = vWeight;
      if (vBodyFat !== undefined) body.body_fat_percentage = vBodyFat;
      if (vSys !== undefined) body.systolic_bp = vSys;
      if (vDia !== undefined) body.diastolic_bp = vDia;
      if (vHeartRate !== undefined) body.heart_rate = vHeartRate;
      if (vBodyTemp !== undefined) body.body_temp = vBodyTemp;
      if (vSleep !== undefined) body.sleep_hours = vSleep;
      if (sleepQuality !== null) body.sleep_quality = sleepQuality;
      if (vWater !== undefined) body.water_intake = vWater;
      if (vSteps !== undefined) body.step_count = vSteps;
      if (vBowel !== undefined) body.bowel_movement = vBowel;
      if (overallCondition !== null) body.overall_condition = overallCondition;
      if (moodScore !== null) body.mood_score = moodScore;
      if (energyLevel !== null) body.energy_level = energyLevel;
      if (stressLevel !== null) body.stress_level = stressLevel;

      const noteTrimmed = note.trim();
      if (noteTrimmed) body.daily_note = noteTrimmed;

      const api = getApi();
      await api.put(`/api/health/records/${encodeURIComponent(date)}`, body);
      Alert.alert("保存しました", "健康記録を更新しました。");
      await load();
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  }

  async function remove() {
    if (!date) return;
    Alert.alert("削除", "この日の記録を削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.del(`/api/health/records/${encodeURIComponent(date)}`);
            Alert.alert("削除しました", "記録を削除しました。");
            router.replace("/health/record");
          } catch (e: any) {
            Alert.alert("削除失敗", e?.message ?? "削除に失敗しました。");
          }
        },
      },
    ]);
  }

  if (!date) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <PageHeader title="健康記録詳細" />
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
          <Card variant="error">
            <Text style={{ color: colors.error }}>日付が指定されていません。</Text>
          </Card>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="健康記録詳細" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <Card variant="error">
          <Text style={{ color: colors.error }}>{error}</Text>
        </Card>
      ) : (
        <>
          {/* 前日比較 */}
          {previous && (
            <Card>
              <View style={{ gap: spacing.md }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <Ionicons name="trending-up" size={18} color={colors.blue} />
                  <Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>前日との比較</Text>
                </View>
                <View style={{ flexDirection: "row", gap: spacing.lg }}>
                  {previous.weight != null && (
                    <View style={{ alignItems: "center" }}>
                      <Text style={{ fontSize: 13, color: colors.textMuted }}>体重</Text>
                      <Text style={{ fontSize: 16, fontWeight: "700", color: colors.purple }}>{previous.weight} kg</Text>
                      <DiffIndicator current={weight} previous={previous.weight} unit="kg" lower />
                    </View>
                  )}
                  {previous.body_fat_percentage != null && (
                    <View style={{ alignItems: "center" }}>
                      <Text style={{ fontSize: 13, color: colors.textMuted }}>体脂肪</Text>
                      <Text style={{ fontSize: 16, fontWeight: "700", color: colors.warning }}>{previous.body_fat_percentage}%</Text>
                      <DiffIndicator current={bodyFat} previous={previous.body_fat_percentage} unit="%" lower />
                    </View>
                  )}
                  {previous.systolic_bp != null && (
                    <View style={{ alignItems: "center" }}>
                      <Text style={{ fontSize: 13, color: colors.textMuted }}>血圧</Text>
                      <Text style={{ fontSize: 16, fontWeight: "700", color: colors.error }}>
                        {previous.systolic_bp}/{previous.diastolic_bp}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            </Card>
          )}

          {/* 体組成 */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <View style={{ width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.accentLight, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="scale" size={18} color={colors.accent} />
                </View>
                <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>体組成</Text>
              </View>
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Input label="体重 (kg)" value={weight} onChangeText={setWeight} keyboardType="decimal-pad" placeholder="60.2" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="体脂肪率 (%)" value={bodyFat} onChangeText={setBodyFat} keyboardType="decimal-pad" placeholder="20.5" />
                </View>
              </View>
            </View>
          </Card>

          {/* バイタル */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <View style={{ width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.errorLight, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="heart" size={18} color={colors.error} />
                </View>
                <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>バイタル</Text>
              </View>
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Input label="収縮期血圧 (mmHg)" value={sys} onChangeText={setSys} keyboardType="number-pad" placeholder="120" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="拡張期血圧 (mmHg)" value={dia} onChangeText={setDia} keyboardType="number-pad" placeholder="80" />
                </View>
              </View>
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Input label="脈拍 (bpm)" value={heartRate} onChangeText={setHeartRate} keyboardType="number-pad" placeholder="70" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="体温 (℃)" value={bodyTemp} onChangeText={setBodyTemp} keyboardType="decimal-pad" placeholder="36.5" />
                </View>
              </View>
            </View>
          </Card>

          {/* 生活習慣 */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <View style={{ width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.purpleLight, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="bed" size={18} color={colors.purple} />
                </View>
                <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>生活習慣</Text>
              </View>
              <Input label="睡眠時間 (時間)" value={sleepHours} onChangeText={setSleepHours} keyboardType="decimal-pad" placeholder="7.5" />
              <ScoreSelector
                label="睡眠の質"
                value={sleepQuality}
                onChange={setSleepQuality}
                options={SCORE_OPTIONS[4]}
                selectedColor={colors.purple}
              />
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Input label="水分摂取 (ml)" value={water} onChangeText={setWater} keyboardType="number-pad" placeholder="2000" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="歩数" value={steps} onChangeText={setSteps} keyboardType="number-pad" placeholder="8000" />
                </View>
              </View>
              <Input label="便通 (回)" value={bowelMovement} onChangeText={setBowelMovement} keyboardType="number-pad" placeholder="1" />
            </View>
          </Card>

          {/* 体調・メンタル */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <View style={{ width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.successLight, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="sparkles-outline" size={18} color={colors.success} />
                </View>
                <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>体調・メンタル</Text>
              </View>
              <ScoreSelector
                label="全体的な体調"
                value={overallCondition}
                onChange={setOverallCondition}
                options={SCORE_OPTIONS[0]}
                selectedColor={colors.success}
              />
              <ScoreSelector
                label="気分"
                value={moodScore}
                onChange={setMoodScore}
                options={SCORE_OPTIONS[1]}
                selectedColor={colors.success}
              />
              <ScoreSelector
                label="エネルギーレベル"
                value={energyLevel}
                onChange={setEnergyLevel}
                options={SCORE_OPTIONS[2]}
                selectedColor={colors.warning}
              />
              <ScoreSelector
                label="ストレスレベル"
                value={stressLevel}
                onChange={setStressLevel}
                options={SCORE_OPTIONS[3]}
                selectedColor={colors.blue}
              />
            </View>
          </Card>

          {/* メモ */}
          <Input label="今日のメモ" value={note} onChangeText={setNote} placeholder="今日の気づきや出来事を記録..." multiline />

          {/* アクション */}
          <Button onPress={save} loading={isSaving}>
            {isSaving ? "保存中..." : "保存"}
          </Button>

          {record && (
            <Button variant="destructive" onPress={remove}>
              この記録を削除
            </Button>
          )}
        </>
      )}
    </ScrollView>
    </View>
  );
}
