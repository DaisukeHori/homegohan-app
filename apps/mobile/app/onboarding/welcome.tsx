import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Card } from "../../src/components/ui";
import { getApi } from "../../src/lib/api";
import { colors, radius, shadows, spacing } from "../../src/theme";

// モバイル版: 初回ウェルカム画面 (OB-UI-06)
export default function OnboardingWelcome() {
  const [isSkipping, setIsSkipping] = useState(false);

  const handleSkip = async () => {
    if (isSkipping) return;
    setIsSkipping(true);
    try {
      const api = getApi();
      await api.post("/api/onboarding/complete");
    } catch (error) {
      // エラーでもホームへ遷移する
      console.error("[onboarding] skip complete API failed:", error);
    } finally {
      router.replace("/(tabs)/home");
    }
  };

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      style={styles.scroll}
    >
      {/* Hero icon */}
      <View style={styles.heroIcon}>
        <Ionicons name="restaurant" size={48} color="#FFFFFF" />
      </View>

      {/* Title */}
      <View style={styles.titleSection}>
        <Text style={styles.title}>はじめまして！</Text>
        <Text style={styles.subtitle}>
          私はあなたの食生活をサポートする{"\n"}
          AI栄養士「ほめゴハン」です。
        </Text>
      </View>

      {/* Feature cards */}
      <View style={styles.features}>
        <View style={styles.featureRow}>
          <View style={styles.featureIconWrap}>
            <Ionicons name="nutrition" size={22} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.featureTitle}>栄養バランス管理</Text>
            <Text style={styles.featureDesc}>あなたに最適な栄養目標を設定</Text>
          </View>
        </View>
        <View style={styles.featureRow}>
          <View style={styles.featureIconWrap}>
            <Ionicons name="calendar" size={22} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.featureTitle}>献立提案</Text>
            <Text style={styles.featureDesc}>毎週のメニューを自動で提案</Text>
          </View>
        </View>
        <View style={styles.featureRow}>
          <View style={styles.featureIconWrap}>
            <Ionicons name="cart" size={22} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.featureTitle}>買い物リスト</Text>
            <Text style={styles.featureDesc}>必要な食材をまとめて管理</Text>
          </View>
        </View>
      </View>

      {/* Info card */}
      <Card style={styles.infoCard}>
        <Text style={styles.infoText}>
          あなたに最適な食事プランを作成するため、{"\n"}
          いくつか質問させてください。
        </Text>
        <View style={styles.timeRow}>
          <Ionicons name="time-outline" size={14} color={colors.textMuted} />
          <Text style={styles.timeText}>所要時間: 約3〜5分</Text>
        </View>
      </Card>

      {/* Buttons */}
      <View style={styles.buttonGroup}>
        <Pressable
          onPress={() => router.push("/onboarding/questions")}
          style={({ pressed }) => [
            styles.primaryButton,
            pressed && { opacity: 0.9, transform: [{ scale: 0.98 }] },
          ]}
        >
          <Ionicons name="arrow-forward" size={20} color="#FFFFFF" />
          <Text style={styles.primaryButtonText}>はじめる</Text>
        </Pressable>

        <Pressable
          onPress={handleSkip}
          style={styles.skipButton}
          disabled={isSkipping}
        >
          <Text style={styles.skipButtonText}>あとで設定する</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    backgroundColor: "#FFF7ED",
  },
  container: {
    flexGrow: 1,
    padding: spacing["2xl"],
    justifyContent: "center",
    alignItems: "center",
    gap: spacing["2xl"],
  },
  heroIcon: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
    ...shadows.lg,
  },
  titleSection: {
    alignItems: "center",
    gap: spacing.sm,
  },
  title: {
    fontSize: 30,
    fontWeight: "900",
    color: colors.text,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 16,
    color: colors.textLight,
    textAlign: "center",
    lineHeight: 24,
  },
  features: {
    width: "100%",
    gap: spacing.lg,
    paddingHorizontal: spacing.sm,
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  featureIconWrap: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.accentLight,
    justifyContent: "center",
    alignItems: "center",
  },
  featureTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.text,
  },
  featureDesc: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2,
  },
  infoCard: {
    width: "100%",
    alignItems: "center",
  },
  infoText: {
    fontSize: 14,
    color: colors.textLight,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: spacing.md,
  },
  timeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  timeText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  buttonGroup: {
    width: "100%",
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    paddingVertical: 18,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.sm,
    ...shadows.lg,
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontWeight: "800",
    fontSize: 17,
  },
  skipButton: {
    alignItems: "center",
    paddingVertical: spacing.md,
  },
  skipButtonText: {
    color: colors.textMuted,
    fontSize: 14,
  },
});
