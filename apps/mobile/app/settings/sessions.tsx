/**
 * ログイン中の端末の一覧と個別の失効・他の端末のログアウト・最近のログイン (#1189・#1190)。
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §16 (Web の /settings/security/sessions §15 と同じ構成)。
 *
 * - 端末の見出しは device_label (UA から決まる言葉)。端末名 (device_name) は「端末名: …」として添えるだけ (§7.1)。
 * - この端末には解除のボタンを出さない (この端末のログアウトは設定のタブの「ログアウト」。この画面は signOutOnDevice を呼ばない §22 N-34)。
 * - 失敗の文は getJapaneseApiErrorMessage (本文の error = サーバーが決めた固定の文。圏外は通信の文。日本語でない例外の文は固定の文)。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { Text } from "../../src/components/ui/Text";

import { Button, Card, LoadingState, PageHeader, SectionHeader } from "../../src/components/ui";
import { getJapaneseApiErrorMessage } from "../../src/lib/api-error";
import {
  fetchLoginHistory,
  fetchSessions,
  revokeOtherSessions,
  revokeSession,
  type EndedReason,
  type LoginHistoryEntry,
  type SessionSummary,
} from "../../src/lib/sessions-api";
import { colors, spacing } from "../../src/theme";

const LOAD_FAILED_MESSAGE = "ログイン中の端末を読み込めませんでした。通信の状態を確認して、もう一度お試しください。";
const REVOKE_FAILED_MESSAGE = "ログアウトさせられませんでした。時間をおいてもう一度お試しください。";
const DISPLAY_TIME_ZONE = "Asia/Tokyo";

/** 終了の理由の言葉 (Web §15 と同じ) */
const ENDED_REASON_LABELS: Record<EndedReason, string> = {
  signed_out: "ログアウト",
  revoked_by_user: "この一覧から解除",
  idle_expired: "使われずに期限切れ",
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; sessions: SessionSummary[]; history: LoginHistoryEntry[] };

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { timeZone: DISPLAY_TIME_ZONE });
}

/** 確認のダイアログ。押した方を返す */
function confirmAsync(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: "キャンセル", style: "cancel", onPress: () => resolve(false) },
      { text: confirmLabel, style: "destructive", onPress: () => resolve(true) },
    ]);
  });
}

export default function SessionsSettingsScreen() {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      const [sessions, history] = await Promise.all([fetchSessions(), fetchLoginHistory()]);
      setLoad({ kind: "ready", sessions, history });
    } catch (e: unknown) {
      setLoad({ kind: "error", message: getJapaneseApiErrorMessage(e, LOAD_FAILED_MESSAGE) });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onRevoke(session: SessionSummary) {
    if (busy) return;
    const ok = await confirmAsync("端末のログアウト", `「${session.device_label}」をログアウトさせますか？`, "ログアウトさせる");
    if (!ok) return;
    setBusy(true);
    try {
      await revokeSession(session.session_id);
      setLoad((current) =>
        current.kind === "ready"
          ? { ...current, sessions: current.sessions.filter((s) => s.session_id !== session.session_id) }
          : current,
      );
    } catch (e: unknown) {
      Alert.alert("ログアウトできませんでした", getJapaneseApiErrorMessage(e, REVOKE_FAILED_MESSAGE));
    } finally {
      setBusy(false);
    }
  }

  async function onRevokeOthers() {
    if (busy) return;
    const ok = await confirmAsync("他の端末のログアウト", "この端末以外のログインをすべてログアウトさせますか？", "すべてログアウト");
    if (!ok) return;
    setBusy(true);
    try {
      await revokeOtherSessions();
      await reload();
    } catch (e: unknown) {
      Alert.alert("ログアウトできませんでした", getJapaneseApiErrorMessage(e, REVOKE_FAILED_MESSAGE));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container} testID="sessions-screen">
      <PageHeader title="ログイン中の端末" />
      {load.kind === "loading" ? <LoadingState message="読み込み中…" /> : null}
      {load.kind === "error" ? (
        <View style={styles.body}>
          <Card variant="error" testID="sessions-load-error">
            <Text style={styles.errorText}>{load.message}</Text>
            <Button testID="sessions-reload-button" onPress={() => void reload()} variant="secondary" style={{ marginTop: spacing.md }}>
              もう一度読み込む
            </Button>
          </Card>
        </View>
      ) : null}
      {load.kind === "ready" ? (
        <ScrollView contentContainerStyle={styles.body}>
          <SectionHeader title="ログイン中の端末" />
          {load.sessions.map((session) => (
            <Card key={session.session_id} testID="sessions-item" style={styles.card}>
              <View style={styles.rowBetween}>
                <Text style={styles.label}>{session.device_label}</Text>
                {session.is_current ? (
                  <Text style={styles.currentBadge} testID="sessions-current-badge">
                    この端末
                  </Text>
                ) : null}
              </View>
              {session.device_name ? <Text style={styles.sub}>端末名: {session.device_name}</Text> : null}
              <Text style={styles.sub}>
                {session.ip_address ? `IP: ${session.ip_address}` : "IP: 不明"}
                {session.country_code ? ` ・ 国: ${session.country_code}` : ""}
              </Text>
              <Text style={styles.sub}>最後の利用: {formatDateTime(session.last_active_at)}</Text>
              <Text style={styles.sub}>ログインした日時: {formatDateTime(session.created_at)}</Text>
              {session.is_current ? null : (
                <Pressable testID="sessions-revoke-button" disabled={busy} onPress={() => void onRevoke(session)} style={styles.revoke}>
                  <Text style={styles.revokeText}>この端末をログアウトさせる</Text>
                </Pressable>
              )}
            </Card>
          ))}
          {load.sessions.some((s) => !s.is_current) ? (
            <Button
              testID="sessions-revoke-others-button"
              onPress={() => void onRevokeOthers()}
              variant="destructive"
              disabled={busy}
            >
              他の端末をすべてログアウト
            </Button>
          ) : null}

          <SectionHeader title="最近のログイン" />
          {load.history.length === 0 ? <Text style={styles.sub}>記録はまだありません。</Text> : null}
          {load.history.map((entry) => {
            const marks = [
              entry.is_new_device ? "新しい端末" : null,
              entry.is_new_country ? "新しい地域" : null,
              entry.is_new_ip ? "新しい接続元" : null,
            ].filter((mark): mark is string => mark !== null);
            return (
              <Card key={entry.session_id} testID="login-history-item" style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.label}>{formatDateTime(entry.created_at)}</Text>
                  {entry.ended_reason ? <Text style={styles.sub}>{ENDED_REASON_LABELS[entry.ended_reason]}</Text> : null}
                </View>
                <Text style={styles.sub}>
                  {entry.device_label}
                  {entry.device_name ? ` (端末名: ${entry.device_name})` : ""}
                </Text>
                <Text style={styles.sub}>
                  {entry.ip_address ? `IP: ${entry.ip_address}` : "IP: 不明"}
                  {entry.country_code ? ` ・ 国: ${entry.country_code}` : ""}
                </Text>
                {marks.length > 0 ? (
                  <Text style={styles.marks} testID="login-history-marks">
                    {marks.join(" ・ ")}
                  </Text>
                ) : null}
              </Card>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.lg, gap: spacing.md },
  card: { gap: spacing.xs },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm },
  label: { fontSize: 15, fontWeight: "700", color: colors.text, flexShrink: 1 },
  sub: { fontSize: 12, color: colors.textLight },
  currentBadge: { fontSize: 12, fontWeight: "700", color: colors.blue },
  revoke: { marginTop: spacing.sm },
  revokeText: { fontSize: 14, fontWeight: "700", color: colors.accentDark },
  errorText: { fontSize: 14, color: colors.text },
  marks: { fontSize: 12, fontWeight: "700", color: colors.accentDark },
});
