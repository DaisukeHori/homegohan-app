import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, EmptyState, Input, LoadingState, PageHeader, SectionHeader } from "../../src/components/ui";
import { colors, spacing, radius } from "../../src/theme";
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

  function ResultValue({ label, value }: { label: string; value: number | null }) {
    if (value === null || value === undefined) return null;
    return (
      <View style={styles.resultItem}>
        <Text style={styles.resultLabel}>{label}</Text>
        <Text style={styles.resultValue}>{value}</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <PageHeader
        title="血液検査"
        right={
          <Link href="/health">
            <Text style={styles.linkText}>健康トップへ</Text>
          </Link>
        }
      />
      <ScrollView contentContainerStyle={styles.container}>

      <Card>
        <SectionHeader
          title="検査結果を追加"
          right={<Ionicons name="add-circle-outline" size={20} color={colors.accent} />}
        />

        <View style={styles.formFields}>
          <Input label="検査日" value={testDate} onChangeText={setTestDate} placeholder="YYYY-MM-DD" />
          <Input label="施設名（任意）" value={facility} onChangeText={setFacility} placeholder="施設名" />

          <Text style={styles.groupLabel}>脂質</Text>
          <View style={styles.inputRow}>
            <Input value={totalCholesterol} onChangeText={setTotalCholesterol} placeholder="総コレステロール" keyboardType="number-pad" containerStyle={styles.flex1} />
            <Input value={ldl} onChangeText={setLdl} placeholder="LDL" keyboardType="number-pad" containerStyle={styles.flex1} />
            <Input value={hdl} onChangeText={setHdl} placeholder="HDL" keyboardType="number-pad" containerStyle={styles.flex1} />
          </View>

          <Text style={styles.groupLabel}>糖代謝</Text>
          <View style={styles.inputRow}>
            <Input value={tg} onChangeText={setTg} placeholder="中性脂肪" keyboardType="number-pad" containerStyle={styles.flex1} />
            <Input value={fastingGlucose} onChangeText={setFastingGlucose} placeholder="空腹時血糖" keyboardType="number-pad" containerStyle={styles.flex1} />
            <Input value={hba1c} onChangeText={setHba1c} placeholder="HbA1c" keyboardType="decimal-pad" containerStyle={styles.flex1} />
          </View>

          <Text style={styles.groupLabel}>肝機能</Text>
          <View style={styles.inputRow}>
            <Input value={ast} onChangeText={setAst} placeholder="AST" keyboardType="number-pad" containerStyle={styles.flex1} />
            <Input value={alt} onChangeText={setAlt} placeholder="ALT" keyboardType="number-pad" containerStyle={styles.flex1} />
            <Input value={ggtp} onChangeText={setGgtp} placeholder="y-GTP" keyboardType="number-pad" containerStyle={styles.flex1} />
          </View>

          <Text style={styles.groupLabel}>腎機能</Text>
          <View style={styles.inputRow}>
            <Input value={creatinine} onChangeText={setCreatinine} placeholder="Cr" keyboardType="decimal-pad" containerStyle={styles.flex1} />
            <Input value={egfr} onChangeText={setEgfr} placeholder="eGFR" keyboardType="decimal-pad" containerStyle={styles.flex1} />
            <Input value={uricAcid} onChangeText={setUricAcid} placeholder="尿酸" keyboardType="decimal-pad" containerStyle={styles.flex1} />
          </View>

          <Text style={styles.groupLabel}>その他</Text>
          <View style={styles.inputRow}>
            <Input value={bun} onChangeText={setBun} placeholder="BUN" keyboardType="decimal-pad" containerStyle={styles.flex1} />
            <Input value={hb} onChangeText={setHb} placeholder="Hb" keyboardType="decimal-pad" containerStyle={styles.flex1} />
          </View>

          <Input label="メモ（任意）" value={note} onChangeText={setNote} placeholder="メモ" />

          <Button onPress={create} disabled={isSubmitting} loading={isSubmitting}>
            {isSubmitting ? "登録中..." : "登録"}
          </Button>
        </View>
      </Card>

      <SectionHeader title="一覧" />

      {isLoading ? (
        <LoadingState message="検査結果を読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={styles.errorRow}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Ionicons name="flask-outline" size={40} color={colors.textMuted} />}
          message="データがありません。"
        />
      ) : (
        <View style={styles.list}>
          {items.map((r) => (
            <Card key={r.id}>
              <View style={styles.recordHeader}>
                <View style={styles.recordDateRow}>
                  <Ionicons name="calendar" size={16} color={colors.accent} />
                  <Text style={styles.recordDate}>{r.test_date}</Text>
                </View>
                {r.test_facility ? (
                  <Text style={styles.facilityText}>{r.test_facility}</Text>
                ) : null}
              </View>

              <View style={styles.resultGrid}>
                <ResultValue label="TC" value={r.total_cholesterol} />
                <ResultValue label="LDL" value={r.ldl_cholesterol} />
                <ResultValue label="HDL" value={r.hdl_cholesterol} />
                <ResultValue label="TG" value={r.triglycerides} />
                <ResultValue label="Glu" value={r.fasting_glucose} />
                <ResultValue label="HbA1c" value={r.hba1c} />
                <ResultValue label="AST" value={r.ast} />
                <ResultValue label="ALT" value={r.alt} />
                <ResultValue label="y-GTP" value={r.gamma_gtp} />
                <ResultValue label="Cr" value={r.creatinine} />
                <ResultValue label="eGFR" value={r.egfr} />
                <ResultValue label="UA" value={r.uric_acid} />
                <ResultValue label="BUN" value={r.bun} />
                <ResultValue label="Hb" value={r.hemoglobin} />
              </View>

              {r.note ? (
                <View style={styles.noteRow}>
                  <Ionicons name="document-text-outline" size={14} color={colors.textMuted} />
                  <Text style={styles.noteText}>{r.note}</Text>
                </View>
              ) : null}
            </Card>
          ))}
        </View>
      )}

      <Button onPress={load} variant="ghost" size="sm">
        <Ionicons name="refresh-outline" size={16} color={colors.textLight} />
        <Text style={{ color: colors.textLight, fontWeight: "700", fontSize: 13 }}>更新</Text>
      </Button>
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing["4xl"],
  },
  linkText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.accent,
  },
  formFields: {
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  groupLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  inputRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  flex1: {
    flex: 1,
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  errorText: {
    fontSize: 14,
    color: colors.error,
    fontWeight: "600",
    flex: 1,
  },
  list: {
    gap: spacing.md,
  },
  recordHeader: {
    marginBottom: spacing.md,
  },
  recordDateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  recordDate: {
    fontSize: 16,
    fontWeight: "800",
    color: colors.text,
  },
  facilityText: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: spacing.xs,
    marginLeft: spacing["2xl"],
  },
  resultGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  resultItem: {
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    minWidth: 70,
    alignItems: "center",
  },
  resultLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textMuted,
  },
  resultValue: {
    fontSize: 15,
    fontWeight: "800",
    color: colors.text,
    marginTop: 2,
  },
  noteRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
    backgroundColor: colors.bg,
    padding: spacing.sm,
    borderRadius: radius.sm,
  },
  noteText: {
    fontSize: 13,
    color: colors.textLight,
    flex: 1,
  },
});
