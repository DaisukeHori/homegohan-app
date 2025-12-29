import { Link, router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

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
    setWeight(r?.weight === null || r?.weight === undefined ? "" : String(r.weight));
    setBodyFat(r?.body_fat_percentage === null || r?.body_fat_percentage === undefined ? "" : String(r.body_fat_percentage));
    setSys(r?.systolic_bp === null || r?.systolic_bp === undefined ? "" : String(r.systolic_bp));
    setDia(r?.diastolic_bp === null || r?.diastolic_bp === undefined ? "" : String(r.diastolic_bp));
    setSleepHours(r?.sleep_hours === null || r?.sleep_hours === undefined ? "" : String(r.sleep_hours));
    setSteps(r?.step_count === null || r?.step_count === undefined ? "" : String(r.step_count));
    setWater(r?.water_intake === null || r?.water_intake === undefined ? "" : String(r.water_intake));
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
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>健康記録</Text>
        <Text style={{ color: "#c00" }}>date が指定されていません。</Text>
        <Link href="/health/record">一覧へ戻る</Link>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>健康記録（{date}）</Text>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Link href="/health/record">一覧へ</Link>
        <Link href="/health">健康トップ</Link>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : (
        <>
          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
            <Text style={{ fontWeight: "900" }}>前日比較（あれば）</Text>
            <Text style={{ color: "#666" }}>体重: {previous?.weight ?? "-"}</Text>
            <Text style={{ color: "#666" }}>体脂肪: {previous?.body_fat_percentage ?? "-"}</Text>
            <Text style={{ color: "#666" }}>
              血圧: {previous?.systolic_bp ?? "-"} / {previous?.diastolic_bp ?? "-"}
            </Text>
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 10 }}>
            <Text style={{ fontWeight: "900" }}>入力</Text>

            <View style={{ flexDirection: "row", gap: 10 }}>
              <TextInput value={weight} onChangeText={setWeight} placeholder="体重(kg)" keyboardType="decimal-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
              <TextInput value={bodyFat} onChangeText={setBodyFat} placeholder="体脂肪(%)" keyboardType="decimal-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
            </View>

            <View style={{ flexDirection: "row", gap: 10 }}>
              <TextInput value={sys} onChangeText={setSys} placeholder="収縮期(mmHg)" keyboardType="number-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
              <TextInput value={dia} onChangeText={setDia} placeholder="拡張期(mmHg)" keyboardType="number-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
            </View>

            <View style={{ flexDirection: "row", gap: 10 }}>
              <TextInput value={sleepHours} onChangeText={setSleepHours} placeholder="睡眠(時間)" keyboardType="decimal-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
              <TextInput value={steps} onChangeText={setSteps} placeholder="歩数" keyboardType="number-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
              <TextInput value={water} onChangeText={setWater} placeholder="水(ml)" keyboardType="number-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
            </View>

            <TextInput value={note} onChangeText={setNote} placeholder="メモ（任意）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />

            <Pressable onPress={save} disabled={isSaving} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSaving ? "#999" : "#333" }}>
              <Text style={{ color: "white", fontWeight: "900" }}>{isSaving ? "保存中..." : "保存"}</Text>
            </Pressable>

            {record ? (
              <Pressable onPress={remove} style={{ padding: 12, borderRadius: 12, alignItems: "center", backgroundColor: "#c00" }}>
                <Text style={{ color: "white", fontWeight: "900" }}>削除</Text>
              </Pressable>
            ) : null}
          </View>
        </>
      )}
    </ScrollView>
  );
}



