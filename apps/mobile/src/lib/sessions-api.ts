/**
 * ログイン中の端末・最近のログイン・端末名の登録の API (#1189・#1190)。設計の正典 docs/design/cross/16-auth-history-sessions.md §16・§14.1〜14.5。
 *
 * どれも getApi() (Bearer の access token を付ける) で Next.js の API を呼ぶ。失敗は getApi() の例外のまま投げる
 * (画面は getJapaneseApiErrorMessage で本文の error を出す)。応答の形は Web の src/lib/auth/sessions/schemas.ts と同じ型だけで受ける
 * (Zod を packages/shared に写さない。§25 Q-7)。
 */
import { getApi } from "./api";

/** GET /api/auth/sessions の 1 行 (Web の SessionSummarySchema と同じ形) */
export type SessionSummary = {
  session_id: string;
  created_at: string;
  last_active_at: string;
  /** UA から決まる言葉 (見出し) */
  device_label: string;
  /** アプリが登録した端末名 (添え書き。見出しにしない) */
  device_name: string | null;
  ip_address: string | null;
  country_code: string | null;
  is_current: boolean;
};

export type EndedReason = "signed_out" | "revoked_by_user" | "idle_expired";

/** GET /api/auth/login-history の 1 行 (Web の LoginHistoryEntrySchema と同じ形) */
export type LoginHistoryEntry = Omit<SessionSummary, "is_current"> & {
  ended_at: string | null;
  ended_reason: EndedReason | null;
  is_new_device: boolean | null;
  is_new_ip: boolean | null;
  is_new_country: boolean | null;
  alert_sent_at: string | null;
};

export const SESSIONS_API_PATHS = {
  sessions: "/api/auth/sessions",
  current: "/api/auth/sessions/current",
  revokeOthers: "/api/auth/sessions/revoke-others",
  loginHistory: "/api/auth/login-history",
} as const;

/** GET /api/auth/sessions */
export async function fetchSessions(): Promise<SessionSummary[]> {
  const body = await getApi().get<{ sessions: SessionSummary[] }>(SESSIONS_API_PATHS.sessions);
  return body.sessions;
}

/** DELETE /api/auth/sessions/{id} */
export async function revokeSession(sessionId: string): Promise<void> {
  await getApi().del<{ ok: true }>(`${SESSIONS_API_PATHS.sessions}/${encodeURIComponent(sessionId)}`);
}

/** POST /api/auth/sessions/revoke-others。戻りは残りの端末の数 */
export async function revokeOtherSessions(): Promise<number> {
  const body = await getApi().post<{ ok: true; remaining: number }>(SESSIONS_API_PATHS.revokeOthers);
  return body.remaining;
}

/** GET /api/auth/login-history */
export async function fetchLoginHistory(): Promise<LoginHistoryEntry[]> {
  const body = await getApi().get<{ entries: LoginHistoryEntry[] }>(SESSIONS_API_PATHS.loginHistory);
  return body.entries;
}

/** PATCH /api/auth/sessions/current (この端末のログインに端末名を書く) */
export async function patchCurrentDeviceName(deviceName: string): Promise<void> {
  await getApi().patch<{ ok: true }>(SESSIONS_API_PATHS.current, { device_name: deviceName });
}
