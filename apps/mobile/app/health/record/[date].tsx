import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";

import { Button, Card, Input, LoadingState, PageHeader, SectionHeader } from "../../../src/components/ui";
import { colors, spacing, radius } from "../../../src/theme";
import { getApi } from "../../../src/lib/api";

type HealthRecord = {
  id: string;
  record_date: string;
  weight: number | null;
  body_fat_percentage: number | null;
  systolic_bp: number | null;
  diastolic_bp: number | null;
  sleep_hours: number | null;
  step_count: number | null;
  water_intake: number | null;
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

  const [weight, setWeight] = useState("");
  const [bodyFat, setBodyFat] = useState("");
  const [sys, setSys] = useState("");
  const [dia, setDia] = useState("");
  const [sleepHours, setSleepHours] = useState("");
  const [steps, setSteps] = useState("");
  const [water, setWater] = useState("");
  const [note, setNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  function hydrateForm(r: HealthRecord | null) {
    setWeight(r?.weight == null ? "" : String(r.weight));
    setBodyFat(r?.body_fat_percentage == null ? "" : String(r.body_fat_percentage));
    setSys(r?.systolic_bp == null ? "" : String(r.systolic_bp));
    setDia(r?.diastolic_bp == null ? "" : String(r.diastolic_bp));
    setSleepHours(r?.sleep_hours == null ? "" : String(r.sleep_hours));
    setSteps(r?.step_count == null ? "" : String(r.step_count));
    setWater(r?.water_intake == null ? "" : String(r.water_intake));
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
      const vSleep = toNum(sleepHours);
      const vSteps = toInt(steps);
      const vWater = toInt(water);

      if (vWeight !== undefined) body.weight = vWeight;
      if (vBodyFat !== undefined) body.body_fat_percentage = vBodyFat;
      if (vSys !== undefined) body.systolic_bp = vSys;
      if (vDia !== undefined) body.diastolic_bp = vDia;
      if (vSleep !== undefined) body.sleep_hours = vSleep;
      if (vSteps !== undefined) body.step_count = vSteps;
      if (vWater !== undefined) body.water_intake = vWater;

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

          {/* 身体データ */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <SectionHeader title="身体データ" />
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Input label="体重 (kg)" value={weight} onChangeText={setWeight} keyboardType="decimal-pad" placeholder="60.2" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="体脂肪 (%)" value={bodyFat} onChangeText={setBodyFat} keyboardType="decimal-pad" placeholder="20.5" />
                </View>
              </View>
            </View>
          </Card>

          {/* 血圧 */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <SectionHeader title="血圧" />
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Input label="収縮期 (mmHg)" value={sys} onChangeText={setSys} keyboardType="number-pad" placeholder="120" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="拡張期 (mmHg)" value={dia} onChangeText={setDia} keyboardType="number-pad" placeholder="80" />
                </View>
              </View>
            </View>
          </Card>

          {/* 生活データ */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <SectionHeader title="生活データ" />
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Input label="睡眠 (時間)" value={sleepHours} onChangeText={setSleepHours} keyboardType="decimal-pad" placeholder="7.5" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="歩数" value={steps} onChangeText={setSteps} keyboardType="number-pad" placeholder="8000" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="水 (ml)" value={water} onChangeText={setWater} keyboardType="number-pad" placeholder="2000" />
                </View>
              </View>
            </View>
          </Card>

          {/* メモ */}
          <Input label="メモ" value={note} onChangeText={setNote} placeholder="今日の体調など" multiline />

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
