/**
 * tests/e2e/helpers/persona-api.ts
 *
 * 主要ペルソナ (家族・運営の admin / super_admin) の一気通貫 e2e (T14 / #856) で使う道具。
 *   - apiRequest: ログインした状態 (ブラウザのコンテキストの Cookie) のまま、アプリの API を呼ぶ
 *   - serviceRoleRest: テスト専用のデータの用意と後始末だけを、service_role で PostgREST に直接書く
 *   - createRoleUser / openUserContext: fixture の page とは別のユーザーを、別のブラウザのコンテキストで動かす
 *     (1 つのテストで「操作する人」と「確かめる人」が別のとき。fixture の page は 1 つのテストに 1 人分しか作れない)
 *   - fetchAuditLogs / expectAuditLogEntryShape: 運営の操作の記録 (admin_audit_logs) を super_admin の API で読む
 *
 * セッションは fixtures/fresh-user.ts の injectSession (#1547 のテスト用のセッション。パスワードのログインは使わない) で作る。
 * service_role の鍵が無いときは、skip にせず例外で失敗する (ほかの fixture と同じ扱い)。
 */

import { expect, type APIResponse, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  cleanupFreshUser,
  createFreshUser,
  getAdminClient,
  injectSession,
  upsertUserProfile,
  type FreshUserInfo,
  type InjectedSession,
  type InjectSessionOptions,
} from "../fixtures/fresh-user";

/** アプリの URL (local-ci.sh / e2e-local.yml が PLAYWRIGHT_BASE_URL に枠のポートを入れる) */
export const E2E_BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

/** 失敗のメッセージに載せる、応答の本文の先頭の長さ (長い HTML のエラーページで出力が埋まらないように) */
const ERROR_BODY_PREVIEW_CHARS = 300;

/**
 * 監査ログの API (GET /api/super-admin/audit-logs) から 1 回に読む件数。
 * 1 つのテストの操作で増える記録は数件なので、actor_id / target_id で絞ったうえでこの件数に収まる
 * (API の上限は src/lib/super-admin/audit-logs-schemas.ts の per_page の max)。
 */
export const AUDIT_LOG_PAGE_SIZE = 50;

/** 監査ログの重要度 (admin_audit_logs.severity の値) */
export const AUDIT_LOG_SEVERITIES = ["info", "warn", "critical"] as const;

/** 共有のログイン状態 (playwright.config.ts の storageState) を引き継がない、空の状態 */
export const EMPTY_STORAGE_STATE = { cookies: [], origins: [] };

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type ApiResult = { status: number; body: unknown };

/** 応答の本文を JSON として読む (JSON でなければ文字列のまま) */
async function readBody(res: APIResponse): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 本文から { error: { code } } の code を取り出す (無ければ undefined) */
export function errorCodeOf(body: unknown): unknown {
  const error = (body as { error?: unknown } | null)?.error;
  return (error as { code?: unknown } | null | undefined)?.code;
}

/** 本文から { data } を取り出す (無ければ undefined) */
export function dataOf(body: unknown): unknown {
  return (body as { data?: unknown } | null)?.data;
}

/**
 * page のブラウザのコンテキストの Cookie (injectSession のセッション) を付けて、アプリの API を呼ぶ。
 * 未ログインのコンテキストなら Cookie は付かない。ページを開いていない page (about:blank) でも呼べる。
 */
export async function apiRequest(
  page: Page,
  apiPath: string,
  options: { method?: HttpMethod; body?: unknown } = {},
): Promise<ApiResult> {
  const res = await page.request.fetch(new URL(apiPath, E2E_BASE_URL).toString(), {
    method: options.method ?? "GET",
    data: options.body,
    failOnStatusCode: false,
  });
  return { status: res.status(), body: await readBody(res) };
}

function serviceRoleConfig(): { supabaseUrl: string; serviceRoleKey: string } {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "[persona-api] NEXT_PUBLIC_SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定です。.env.local を確認してください。",
    );
  }
  return { supabaseUrl, serviceRoleKey };
}

/**
 * service_role で PostgREST を直接呼ぶ (テスト専用のデータの用意・確認・後始末だけに使う。アプリの操作の代わりには使わない)。
 * POST / GET は行の配列を返す (POST は return=representation)。PATCH / DELETE は空の配列を返す。
 * 失敗 (2xx 以外) は例外にする。
 */
export async function serviceRoleRest<Row = Record<string, unknown>>(
  pathAndQuery: string,
  init: { method: HttpMethod; body?: unknown },
): Promise<Row[]> {
  const { supabaseUrl, serviceRoleKey } = serviceRoleConfig();
  const wantsRows = init.method === "GET" || init.method === "POST";
  const resp = await fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: wantsRows ? "return=representation" : "return=minimal",
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `[persona-api] ${init.method} ${pathAndQuery} が失敗しました (${resp.status}): ${text.substring(0, ERROR_BODY_PREVIEW_CHARS)}`,
    );
  }
  if (!wantsRows) return [];
  return (await resp.json()) as Row[];
}

/**
 * 役割 (user_profiles.roles) を持ち、初期設定を済ませたユーザーを作る。
 * 後始末は deleteRoleUser (fixture の後始末と同じ admin.deleteUser)。
 */
export async function createRoleUser(params: {
  emailPrefix: string;
  nickname: string;
  roles: string[];
}): Promise<FreshUserInfo> {
  const user = await createFreshUser(getAdminClient(), { emailPrefix: params.emailPrefix });
  try {
    await upsertUserProfile(user.id, { nickname: params.nickname, roles: params.roles });
  } catch (err) {
    await cleanupFreshUser(getAdminClient(), user.id).catch(() => {});
    throw err;
  }
  return user;
}

/** createRoleUser / createFreshUser で作ったユーザーを消す */
export async function deleteRoleUser(userId: string): Promise<void> {
  await cleanupFreshUser(getAdminClient(), userId);
}

/**
 * email のユーザーでログインした、新しいブラウザのコンテキストを開く。
 * fixture の page とは Cookie が分かれるので、1 つのテストで 2 人目のユーザーを動かせる。閉じるのは呼び出し側 (context.close())。
 */
export async function openUserContext(
  browser: Browser,
  email: string,
  options: InjectSessionOptions = {},
): Promise<{ context: BrowserContext; page: Page; session: InjectedSession }> {
  const context = await browser.newContext({
    baseURL: E2E_BASE_URL,
    storageState: EMPTY_STORAGE_STATE,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  });
  try {
    const page = await context.newPage();
    // 必須ロールの運営は injectSession が自動で aal2 に上げる (#1176。cross/12 §22.4.3)。MFA の画面を試す spec は { assurance: 'aal1' }
    const session = await injectSession(page, email, options);
    return { context, page, session };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

export type AuditLogEntry = Record<string, unknown>;

/**
 * 監査ログを super_admin の API (GET /api/super-admin/audit-logs) で読む。
 * actionType は API が部分一致 (ilike) で絞る。actorId / targetId は完全一致。
 */
export async function fetchAuditLogs(
  page: Page,
  filter: { actionType: string; actorId?: string; targetId?: string },
): Promise<{ status: number; logs: AuditLogEntry[]; body: unknown }> {
  const query = new URLSearchParams({
    action_type: filter.actionType,
    per_page: String(AUDIT_LOG_PAGE_SIZE),
    page: "1",
  });
  if (filter.actorId) query.set("actor_id", filter.actorId);
  if (filter.targetId) query.set("target_id", filter.targetId);
  const { status, body } = await apiRequest(page, `/api/super-admin/audit-logs?${query.toString()}`);
  const data = dataOf(body);
  return { status, logs: Array.isArray(data) ? (data as AuditLogEntry[]) : [], body };
}

/**
 * 監査ログの 1 件が、運営コンソールの監査ログの仕様 (operator/07-audit-monitoring) の必須の項目を持つことを確かめる。
 * actorId を渡したときは、操作した本人の記録であることも確かめる。
 */
export function expectAuditLogEntryShape(entry: AuditLogEntry, expected: { actorId: string }): void {
  expect(typeof entry.id).toBe("string");
  expect(typeof entry.action_type).toBe("string");
  expect(AUDIT_LOG_SEVERITIES).toContain(entry.severity);
  expect(typeof entry.created_at).toBe("string");
  expect(Number.isNaN(Date.parse(entry.created_at as string))).toBe(false);
  expect(entry.actor_id).toBe(expected.actorId);
}
