import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Card } from "../../../src/components/ui";
import { colors, radius, shadows, spacing } from "../../../src/theme";

export default function OnboardingComplete() {
  return (
    <View style={styles.container}>
      {/* Success icon */}
      <View style={styles.heroIcon}>
        <Ionicons name="checkmark-done" size={52} color="#FFFFFF" />
      </View>

      {/* Title */}
      <Text style={styles.title}>準備完了！</Text>
      <Text style={styles.subtitle}>
        あなたに合わせた目標を設定しました。{"\n"}
        さっそく今日の食事を記録していきましょう。
      </Text>

      {/* Feature hints */}
      <Card style={styles.hintCard}>
        <View style={styles.hintRow}>
          <View style={styles.hintIconWrap}>
            <Ionicons name="home" size={20} color={colors.accent} />
          </View>
          <Text style={styles.hintText}>ホーム画面から食事を記録</Text>
        </View>
        <View style={styles.hintRow}>
          <View style={styles.hintIconWrap}>
            <Ionicons name="calendar" size={20} color={colors.accent} />
          </View>
          <Text style={styles.hintText}>週間献立を自動で提案</Text>
        </View>
        <View style={styles.hintRow}>
          <View style={styles.hintIconWrap}>
            <Ionicons name="trophy" size={20} color={colors.accent} />
          </View>
          <Text style={styles.hintText}>目標達成で褒めてもらえる</Text>
        </View>
      </Card>

      {/* CTA button */}
      <Pressable
        onPress={() => router.replace("/(tabs)/home")}
        style={({ pressed }) => [
          styles.ctaButton,
          pressed && { opacity: 0.9, transform: [{ scale: 0.98 }] },
        ]}
      >
        <Text style={styles.ctaText}>ホームへ</Text>
        <Ionicons name="arrow-forward" size={20} color="#FFFFFF" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: spacing["2xl"],
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#FFF7ED",
    gap: spacing.lg,
  },
  heroIcon: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: colors.success,
    justifyContent: "center",
    alignItems: "center",
    ...shadows.lg,
    marginBottom: spacing.sm,
  },
  title: {
    fontSize: 28,
    fontWeight: "900",
    color: colors.text,
  },
  subtitle: {
    color: colors.textLight,
    textAlign: "center",
    fontSize: 15,
    lineHeight: 24,
  },
  hintCard: {
    width: "100%",
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  hintRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  hintIconWrap: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.accentLight,
    justifyContent: "center",
    alignItems: "center",
  },
  hintText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textLight,
  },
  ctaButton: {
    backgroundColor: colors.accent,
    paddingVertical: 18,
    paddingHorizontal: spacing["3xl"],
    borderRadius: radius.full,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.lg,
    ...shadows.lg,
  },
  ctaText: {
    color: "#FFFFFF",
    fontWeight: "800",
    fontSize: 17,
  },
});
