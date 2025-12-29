import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type SettingRow = {
  key: string;
  value: any;
  description: string | null;
  updatedAt: string | null;
};

export default function SuperAdminSettingsPage() {
  const [items, setItems] = useState<SettingRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [keyText, setKeyText] = useState("");
  const [valueText, setValueText] = useState("{}");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ settings: SettingRow[] }>("/api/super-admin/settings");
      setItems(res.settings ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function upsert() {
    const k = keyText.trim();
    if (!k || isSubmitting) return;

    let value: any = valueText;
    try {
      value = JSON.parse(valueText);
    } catch {
      // JSONでなければ文字列として扱う
      value = valueText;
    }

    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.put("/api/super-admin/settings", {
        key: k,
        value,
        description: description.trim() || null,
      });
      Alert.alert("保存しました", "設定を更新しました。");
      await load();
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  const selected = useMemo(() => items.find((i) => i.key === keyText.trim()) ?? null, [items, keyText]);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>システム設定</Text>
      <Link href="/super-admin">Super Admin Home</Link>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>Upsert</Text>
        <TextInput value={keyText} onChangeText={setKeyText} placeholder="key" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput
          value={valueText}
          onChangeText={setValueText}
          placeholder="value（JSON推奨。JSONでなければ文字列扱い）"
          multiline
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10, minHeight: 120 }}
        />
        <TextInput value={description} onChangeText={setDescription} placeholder="description（任意）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        {selected ? <Text style={{ color: "#999" }}>現在の更新日時: {selected.updatedAt ?? "-"}</Text> : null}
        <Pressable onPress={upsert} disabled={isSubmitting} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSubmitting ? "#999" : "#333" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "保存中..." : "保存"}</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>設定がありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((s) => (
            <Pressable
              key={s.key}
              onPress={() => {
                setKeyText(s.key);
                setValueText(JSON.stringify(s.value ?? {}, null, 2));
                setDescription(s.description ?? "");
              }}
              style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}
            >
              <Text style={{ fontWeight: "900" }}>{s.key}</Text>
              {s.description ? <Text style={{ color: "#666" }}>{s.description}</Text> : null}
              <Text style={{ color: "#999" }}>{s.updatedAt ?? "-"}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}


