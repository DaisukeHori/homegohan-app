/**
 * tests/e2e/helpers/ai-consent.ts
 *
 * 外国の AI 事業者への提供の同意 (T15 / #1154) の e2e 用の道具。
 *
 * 未同意の利用者のデータは、サーバーが AI へ送る手前で止める (403 AI_CONSENT_REQUIRED)。画面は、AI の操作の前に
 * 同意画面 (data-testid="ai-consent-modal") を出す。同意画面を試すわけではない spec が止められないよう、
 * テスト用のアカウントは同意済みにしておく:
 *   - ローカルの e2e-user-01〜10: scripts/create-e2e-accounts.ts が作るときに記録する
 *   - test ごとに作るユーザー: fixtures/fresh-user.ts が作るときに記録する (aiConsentGranted: false で記録しない)
 *   - 本番の e2e-user (e2e.yml) とログインの共通処理: ensureAiConsentGranted がアプリの API で記録する
 *     (GET /api/ai/consent で同意済みなら何もしない。未同意・古い版なら POST /api/ai/consent)
 *
 * 同意画面そのものを試す spec は、同意していない状態から始める (fixtures/fresh-user.ts の test.use({ aiConsentGranted: false }))。
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { AI_CONSENT_VERSION } from "../../../supabase/functions/_shared/ai-consent";

/** HTTP 404 (同意の API がまだ無いデプロイ) */
const NOT_FOUND = 404;

/**
 * ログイン済みのセッション (page と同じ Cookie) で、同意を記録する。すでに現行の版に同意していれば何もしない。
 * origin はアプリの URL (例: http://localhost:3000)。
 * 記録できなかったら例外にする (AI を使う spec が、あとで分かりにくい 403 で落ちないように)。
 */
export async function ensureAiConsentGranted(target: Page | APIRequestContext, origin: string): Promise<void> {
  const request = "request" in target ? target.request : target;
  const base = origin.replace(/\/+$/, "");
  const status = await request.get(`${base}/api/ai/consent`);
  // 同意の API がまだ無いデプロイ (本番の e2e.yml を、この変更の反映前に走らせたとき) では、AI も止めていないので何もしない
  if (status.status() === NOT_FOUND) {
    console.warn("[e2e] /api/ai/consent が無いため、AI の同意の記録を省きます (同意の判定が入る前のデプロイ)");
    return;
  }
  if (!status.ok()) {
    throw new Error(`[e2e] AI の同意の状況を取得できない (${status.status()})`);
  }
  const body = (await status.json()) as { consented?: unknown; version?: unknown };
  if (body.consented === true && body.version === AI_CONSENT_VERSION) return;

  const res = await request.post(`${base}/api/ai/consent`, { data: { version: AI_CONSENT_VERSION } });
  if (!res.ok()) {
    throw new Error(`[e2e] AI の同意を記録できない (${res.status()})`);
  }
}

/** page が開いているアプリの origin。開いていなければ fallback */
export function appOrigin(page: Page, fallback: string): string {
  try {
    const url = new URL(page.url());
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    // about:blank など
  }
  return fallback;
}
