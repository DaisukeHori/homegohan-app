import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../src/lib/api";

type BloodTest = {
  id: string;
  test_date: string;
  test_facility: string | null;
  total_cholesterol: number | null;
  ldl_cholesterol: number | null;
  hdl_cholesterol: number | null;
  triglycerides: number | null;
  fasting_glucose: number | null;
  hba1c: number | null;
  ast: number | null;
  alt: number | null;
  gamma_gtp: number | null;
  creatinine: number | null;
  egfr: number | null;
  uric_acid: number | null;
  bun: number | null;
  hemoglobin: number | null;
  note: string | null;
  created_at: string;
};

function toInt(v: string): number | undefined {
  const s = v.trim();
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function toNum(v: string): number | undefined {
  const s = v.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export default function BloodTestsPage() {
  const [items, setItems] = useState<BloodTest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [testDate, setTestDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [facility, setFacility] = useState("");
  const [totalCholesterol, setTotalCholesterol] = useState("");
  const [ldl, setLdl] = useState("");
  const [hdl, setHdl] = useState("");
  const [tg, setTg] = useState("");
  const [fastingGlucose, setFastingGlucose] = useState("");
  const [hba1c, setHba1c] = useState("");
  const [ast, setAst] = useState("");
  const [alt, setAlt] = useState("");
  const [ggtp, setGgtp] = useState("");
  const [creatinine, setCreatinine] = useState("");
  const [egfr, setEgfr] = useState("");
  const [uricAcid, setUricAcid] = useState("");
  const [bun, setBun] = useState("");
  const [hb, setHb] = useState("");
  const [note, setNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ results: BloodTest[] }>("/api/health/blood-tests?limit=10");
      setItems(res.results ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create() {
    if (isSubmitting) return;
    if (!testDate.trim()) {
      Alert.alert("入力不足", "test_date を入力してください。");
      return;
    }

    setIsSubmitting(true);
    try {
      const body: any = {
        test_date: testDate.trim(),
      };
      if (facility.trim()) body.test_facility = facility.trim();
      body.total_cholesterol = toInt(totalCholesterol);
      body.ldl_cholesterol = toInt(ldl);
      body.hdl_cholesterol = toInt(hdl);
      body.triglycerides = toInt(tg);
      body.fasting_glucose = toInt(fastingGlucose);
      body.hba1c = toNum(hba1c);
      body.ast = toInt(ast);
      body.alt = toInt(alt);
      body.gamma_gtp = toInt(ggtp);
      body.creatinine = toNum(creatinine);
      body.egfr = toNum(egfr);
      body.uric_acid = toNum(uricAcid);
      body.bun = toNum(bun);
      body.hemoglobin = toNum(hb);
      if (note.trim()) body.note = note.trim();

      // undefinedを消す
      Object.keys(body).forEach((k) => {
        if (body[k] === undefined) delete body[k];
      });

      const api = getApi();
      await api.post("/api/health/blood-tests", body);
      Alert.alert("登録しました", "血液検査結果を追加しました。");
      setFacility("");
      setTotalCholesterol("");
      setLdl("");
      setHdl("");
      setTg("");
      setFastingGlucose("");
      setHba1c("");
      setAst("");
      setAlt("");
      setGgtp("");
      setCreatinine("");
      setEgfr("");
      setUricAcid("");
      setBun("");
      setHb("");
      setNote("");
      await load();
    } catch (e: any) {
      Alert.alert("失敗", e?.message ?? "登録に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>血液検査</Text>
      <Link href="/health">健康トップへ</Link>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>追加</Text>

        <TextInput value={testDate} onChangeText={setTestDate} placeholder="test_date（YYYY-MM-DD）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput value={facility} onChangeText={setFacility} placeholder="施設名（任意）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />

        <View style={{ flexDirection: "row", gap: 10 }}>
          <TextInput value={totalCholesterol} onChangeText={setTotalCholesterol} placeholder="総コレステロール" keyboardType="number-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <TextInput value={ldl} onChangeText={setLdl} placeholder="LDL" keyboardType="number-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <TextInput value={hdl} onChangeText={setHdl} placeholder="HDL" keyboardType="number-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        </View>

        <View style={{ flexDirection: "row", gap: 10 }}>
          <TextInput value={tg} onChangeText={setTg} placeholder="中性脂肪" keyboardType="number-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <TextInput value={fastingGlucose} onChangeText={setFastingGlucose} placeholder="空腹時血糖" keyboardType="number-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <TextInput value={hba1c} onChangeText={setHba1c} placeholder="HbA1c" keyboardType="decimal-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        </View>

        <View style={{ flexDirection: "row", gap: 10 }}>
          <TextInput value={ast} onChangeText={setAst} placeholder="AST" keyboardType="number-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <TextInput value={alt} onChangeText={setAlt} placeholder="ALT" keyboardType="number-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <TextInput value={ggtp} onChangeText={setGgtp} placeholder="γ-GTP" keyboardType="number-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        </View>

        <View style={{ flexDirection: "row", gap: 10 }}>
          <TextInput value={creatinine} onChangeText={setCreatinine} placeholder="Cr" keyboardType="decimal-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <TextInput value={egfr} onChangeText={setEgfr} placeholder="eGFR" keyboardType="decimal-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <TextInput value={uricAcid} onChangeText={setUricAcid} placeholder="尿酸" keyboardType="decimal-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        </View>

        <View style={{ flexDirection: "row", gap: 10 }}>
          <TextInput value={bun} onChangeText={setBun} placeholder="BUN" keyboardType="decimal-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <TextInput value={hb} onChangeText={setHb} placeholder="Hb(ヘモグロビン)" keyboardType="decimal-pad" style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        </View>

        <TextInput value={note} onChangeText={setNote} placeholder="メモ（任意）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />

        <Pressable onPress={create} disabled={isSubmitting} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSubmitting ? "#999" : "#333" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "登録中..." : "登録"}</Text>
        </Pressable>
      </View>

      <Text style={{ fontWeight: "900" }}>一覧</Text>
      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>データがありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((r) => (
            <View key={r.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
              <Text style={{ fontWeight: "900" }}>{r.test_date}</Text>
              {r.test_facility ? <Text style={{ color: "#666" }}>{r.test_facility}</Text> : null}
              <Text style={{ color: "#333" }}>
                TC {r.total_cholesterol ?? "-"} / LDL {r.ldl_cholesterol ?? "-"} / HDL {r.hdl_cholesterol ?? "-"} / TG {r.triglycerides ?? "-"}
              </Text>
              <Text style={{ color: "#333" }}>
                Glu {r.fasting_glucose ?? "-"} / HbA1c {r.hba1c ?? "-"}
              </Text>
              <Text style={{ color: "#333" }}>
                AST {r.ast ?? "-"} / ALT {r.alt ?? "-"} / γ-GTP {r.gamma_gtp ?? "-"}
              </Text>
              <Text style={{ color: "#333" }}>
                Cr {r.creatinine ?? "-"} / eGFR {r.egfr ?? "-"} / UA {r.uric_acid ?? "-"} / BUN {r.bun ?? "-"} / Hb {r.hemoglobin ?? "-"}
              </Text>
              {r.note ? <Text style={{ color: "#666" }}>📝 {r.note}</Text> : null}
            </View>
          ))}
        </View>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}



