import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, ChipSelector, EmptyState, Input, LoadingState, PageHeader, ProgressBar, SectionHeader, StatusBadge } from "../../src/components/ui";
import { colors, spacing, radius } from "../../src/theme";
import { getApi } from "../../src/lib/api";

type Challenge = {
  id: string;
  challenge_type: string;
  title: string;
  description: string | null;
  start_date: string;
  end_date: string;
  target_metric: string;
  target_value: number;
  target_unit: string;
  current_value: number | null;
  status: string;
  reward_points: number | null;
  reward_badge: string | null;
  reward_description: string | null;
  created_at: string;
};

type ChallengeTemplate = {
  id: string;
  type: string;
  title: string;
  description: string;
  metric: string;
  default_target: number;
  unit: string;
  duration_days: number;
  reward_points: number;
  reward_badge: string;
  reward_description: string;
  difficulty: string;
  emoji: string;
};

export default function HealthChallengesPage() {
  const [status, setStatus] = useState<"active" | "completed" | "all">("active");
  const [items, setItems] = useState<Challenge[]>([]);
  const [templates, setTemplates] = useState<ChallengeTemplate[]>([]);
  const [customTarget, setCustomTarget] = useState("");

  const [isLoading, setIsLoading] = useState(true);
  const [submittingTemplateId, setSubmittingTemplateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ challenges: Challenge[]; templates: ChallengeTemplate[] }>(`/api/health/challenges?status=${status}`);
      setItems(res.challenges ?? []);
      setTemplates(res.templates ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [status]);

  const targetOverride = useMemo(() => {
    const v = customTarget.trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }, [customTarget]);

  async function create(templateId: string) {
    if (submittingTemplateId) return;
    setSubmittingTemplateId(templateId);
    try {
      const api = getApi();
      await api.post("/api/health/challenges", {
        template_id: templateId,
        custom_target: targetOverride ?? undefined,
      });
      Alert.alert("開始しました", "チャレンジを作成しました。");
      setCustomTarget("");
      await load();
    } catch (e: any) {
      Alert.alert("失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setSubmittingTemplateId(null);
    }
  }

  const statusBadgeVariant = (s: string) => {
    if (s === "completed") return "completed" as const;
    if (s === "active") return "generating" as const;
    return "pending" as const;
  };

  return (
    <View style={styles.screen}>
      <PageHeader
        title="チャレンジ"
        right={
          <Link href="/health">
            <Text style={styles.linkText}>健康トップへ</Text>
          </Link>
        }
      />
      <ScrollView contentContainerStyle={styles.container}>

      <ChipSelector
        options={[
          { value: "active", label: "アクティブ" },
          { value: "completed", label: "完了" },
          { value: "all", label: "すべて" },
        ]}
        selected={status}
        onSelect={(v) => setStatus(v as "active" | "completed" | "all")}
      />

      <Card>
        <SectionHeader
          title="テンプレートから開始"
          right={<Ionicons name="rocket-outline" size={20} color={colors.accent} />}
        />
        <Text style={styles.helperText}>
          任意で target を上書きできます（空ならデフォルト）。
        </Text>
        <Input
          value={customTarget}
          onChangeText={setCustomTarget}
          placeholder="カスタム目標値（数値 / 任意）"
          keyboardType="decimal-pad"
          containerStyle={styles.customTargetInput}
        />
        {templates.length === 0 ? (
          <EmptyState
            icon={<Ionicons name="document-outline" size={36} color={colors.textMuted} />}
            message="テンプレートがありません。"
          />
        ) : (
          <View style={styles.templateList}>
            {templates.map((t) => (
              <Card key={t.id} variant="accent" padding="md">
                <View style={styles.templateHeader}>
                  <Text style={styles.templateEmoji}>{t.emoji}</Text>
                  <View style={styles.templateTitleWrap}>
                    <Text style={styles.templateTitle}>{t.title}</Text>
                    <StatusBadge variant="info" label={t.difficulty} />
                  </View>
                </View>
                <Text style={styles.templateDescription}>{t.description}</Text>
                <View style={styles.templateMeta}>
                  <View style={styles.metaItem}>
                    <Ionicons name="trophy-outline" size={14} color={colors.textMuted} />
                    <Text style={styles.metaText}>{t.default_target}{t.unit}</Text>
                  </View>
                  <View style={styles.metaItem}>
                    <Ionicons name="calendar-outline" size={14} color={colors.textMuted} />
                    <Text style={styles.metaText}>{t.duration_days}日</Text>
                  </View>
                  <View style={styles.metaItem}>
                    <Ionicons name="star-outline" size={14} color={colors.textMuted} />
                    <Text style={styles.metaText}>{t.reward_points}pt</Text>
                  </View>
                </View>
                <Button
                  onPress={() => create(t.id)}
                  disabled={!!submittingTemplateId}
                  loading={submittingTemplateId === t.id}
                  size="sm"
                  style={styles.startBtn}
                >
                  {submittingTemplateId === t.id ? "作成中..." : "開始"}
                </Button>
              </Card>
            ))}
          </View>
        )}
      </Card>

      <SectionHeader title="あなたのチャレンジ" />

      {isLoading ? (
        <LoadingState message="チャレンジを読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={styles.errorRow}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Ionicons name="trophy-outline" size={40} color={colors.textMuted} />}
          message="チャレンジがありません。"
        />
      ) : (
        <View style={styles.list}>
          {items.map((c) => {
            const progress = c.target_value > 0 ? (c.current_value ?? 0) / c.target_value : 0;
            return (
              <Card key={c.id}>
                <View style={styles.challengeHeader}>
                  <Text style={styles.challengeTitle}>{c.title}</Text>
                  <StatusBadge variant={statusBadgeVariant(c.status)} label={c.status} />
                </View>
                {c.description ? <Text style={styles.challengeDesc}>{c.description}</Text> : null}
                <View style={styles.dateRow}>
                  <Ionicons name="calendar-outline" size={14} color={colors.textMuted} />
                  <Text style={styles.dateText}>{c.start_date} → {c.end_date}</Text>
                </View>
                <ProgressBar
                  value={c.current_value ?? 0}
                  max={c.target_value}
                  label={`${c.current_value ?? 0} / ${c.target_value}${c.target_unit}`}
                  showPercentage
                  color={c.status === "completed" ? colors.success : colors.accent}
                  style={styles.progressBar}
                />
                {c.reward_description ? (
                  <View style={styles.rewardRow}>
                    <Ionicons name="gift-outline" size={16} color={colors.purple} />
                    <Text style={styles.rewardText}>{c.reward_description}</Text>
                  </View>
                ) : null}
              </Card>
            );
          })}
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
  helperText: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  customTargetInput: {
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  templateList: {
    gap: spacing.md,
  },
  templateHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  templateEmoji: {
    fontSize: 24,
  },
  templateTitleWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  templateTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: colors.text,
  },
  templateDescription: {
    fontSize: 13,
    color: colors.textLight,
    marginBottom: spacing.sm,
  },
  templateMeta: {
    flexDirection: "row",
    gap: spacing.lg,
    marginBottom: spacing.sm,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  metaText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  startBtn: {
    alignSelf: "flex-start",
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
  challengeHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  challengeTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: colors.text,
    flex: 1,
  },
  challengeDesc: {
    fontSize: 13,
    color: colors.textLight,
    marginBottom: spacing.sm,
  },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  dateText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  progressBar: {
    marginBottom: spacing.sm,
  },
  rewardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.purpleLight,
    padding: spacing.sm,
    borderRadius: radius.sm,
  },
  rewardText: {
    fontSize: 13,
    color: colors.purple,
    fontWeight: "600",
    flex: 1,
  },
});
