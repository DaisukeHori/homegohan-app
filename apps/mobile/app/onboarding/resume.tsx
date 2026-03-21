import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Card, ProgressBar } from "../../src/components/ui";
import { supabase } from "../../src/lib/supabase";
import { useProfile } from "../../src/providers/ProfileProvider";
import { colors, radius, shadows, spacing } from "../../src/theme";

// モバイル版: 再開ウェルカム画面 (OB-UI-04)
export default function OnboardingResume() {
  const { profile, refresh } = useProfile();
  const [isResetting, setIsResetting] = useState(false);

  const progress = profile?.onboardingProgress;
  const progressPercent = progress
    ? Math.round((progress.currentStep / progress.totalQuestions) * 100)
    : 0;

  const handleReset = () => {
    Alert.alert(
      "確認",
      "これまでの回答がすべてリセットされます。本当に最初からやり直しますか？",
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "リセット",
          style: "destructive",
          onPress: async () => {
            setIsResetting(true);
            try {
              const { data: auth } = await supabase.auth.getUser();
              if (auth.user) {
                await supabase
                  .from("user_profiles")
                  .update({
                    onboarding_started_at: null,
                    onboarding_progress: null,
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", auth.user.id);
                await refresh();
                router.replace("/onboarding/welcome");
              }
            } catch (error) {
              console.error("Reset failed:", error);
              Alert.alert("エラー", "リセットに失敗しました。");
            } finally {
              setIsResetting(false);
            }
          },
        },
      ]
    );
  };

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      style={styles.scroll}
    >
      {/* Hero icon */}
      <View style={styles.heroIcon}>
        <Ionicons name="hand-left" size={48} color="#FFFFFF" />
      </View>

      {/* Title */}
      <View style={styles.titleSection}>
        <Text style={styles.title}>
          おかえりなさい{profile?.nickname ? `、\n${profile.nickname}さん` : ""}！
        </Text>
        <Text style={styles.subtitle}>前回の設定の続きから再開しましょう</Text>
      </View>

      {/* Progress card */}
      <Card style={styles.progressCard}>
        <View style={styles.progressHeader}>
          <View style={styles.progressLabelRow}>
            <Ionicons name="stats-chart" size={16} color={colors.textLight} />
            <Text style={styles.progressLabel}>設定の進捗</Text>
          </View>
          <Text style={styles.progressPercent}>{progressPercent}%</Text>
        </View>
        <ProgressBar
          value={progress?.currentStep || 0}
          max={progress?.totalQuestions || 1}
          height={8}
        />
        <Text style={styles.progressCount}>
          {progress?.currentStep || 0} / {progress?.totalQuestions || 0} 問完了
        </Text>
      </Card>

      {/* Buttons */}
      <View style={styles.buttonGroup}>
        <Pressable
          onPress={() => router.push("/onboarding/questions?resume=true")}
          style={({ pressed }) => [
            styles.primaryButton,
            pressed && { opacity: 0.9, transform: [{ scale: 0.98 }] },
          ]}
        >
          <Ionicons name="play" size={20} color="#FFFFFF" />
          <Text style={styles.primaryButtonText}>続きから再開</Text>
        </Pressable>

        <Pressable
          onPress={handleReset}
          disabled={isResetting}
          style={({ pressed }) => [
            styles.outlineButton,
            isResetting && { opacity: 0.5 },
            pressed && { opacity: 0.8 },
          ]}
        >
          <Ionicons name="refresh" size={18} color={colors.textLight} />
          <Text style={styles.outlineButtonText}>
            {isResetting ? "リセット中..." : "最初からやり直す"}
          </Text>
        </Pressable>

        <Pressable
          onPress={() => router.replace("/(tabs)/home")}
          style={styles.skipButton}
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
    fontSize: 28,
    fontWeight: "800",
    color: colors.text,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 16,
    color: colors.textLight,
    textAlign: "center",
    lineHeight: 24,
  },
  progressCard: {
    width: "100%",
  },
  progressHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.md,
  },
  progressLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  progressLabel: {
    fontWeight: "700",
    color: colors.textLight,
  },
  progressPercent: {
    fontWeight: "700",
    color: colors.accent,
  },
  progressCount: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: "center",
    marginTop: spacing.sm,
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
    fontSize: 16,
  },
  outlineButton: {
    borderWidth: 2,
    borderColor: colors.border,
    paddingVertical: spacing.lg,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  outlineButtonText: {
    color: colors.textLight,
    fontWeight: "700",
    fontSize: 14,
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
