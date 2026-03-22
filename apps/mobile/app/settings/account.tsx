import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, PageHeader, SectionHeader } from "../../src/components/ui";
import { getApi } from "../../src/lib/api";
import { supabase } from "../../src/lib/supabase";
import { colors, spacing } from "../../src/theme";
import { typography } from "../../src/theme/typography";

export default function AccountSettingsPage() {
  async function deleteAccount() {
    const ok = await new Promise<boolean>((resolve) => {
      Alert.alert("アカウント削除", "アカウントとデータを削除します。取り消しできません。", [
        { text: "キャンセル", style: "cancel", onPress: () => resolve(false) },
        { text: "削除", style: "destructive", onPress: () => resolve(true) },
      ]);
    });
    if (!ok) return;

    try {
      const api = getApi();
      await api.post("/api/account/delete", { confirm: true });
      await supabase.auth.signOut();
      router.replace("/");
    } catch (e: any) {
      Alert.alert("削除失敗", e?.message ?? "削除に失敗しました。");
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="アカウント" />
      <ScrollView contentContainerStyle={styles.container}>

      <Card variant="error" style={{ gap: spacing.md }}>
        <SectionHeader
          title="危険な操作"
          right={<Ionicons name="warning-outline" size={20} color={colors.error} />}
        />
        <Text style={typography.body}>
          アカウント削除は取り消しできません。必要なデータは事前に控えてください。
        </Text>
        <Button onPress={deleteAccount} variant="destructive" size="lg">
          <Ionicons name="trash-outline" size={18} color="#FFF" />
          <Text style={{ color: "#FFF", fontWeight: "700", fontSize: 16 }}>アカウント削除</Text>
        </Button>
      </Card>
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
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  backText: {
    color: colors.textLight,
    fontSize: 14,
    fontWeight: "600",
  },
});
