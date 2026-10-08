/**
 * tests/e2e/helpers/ai-consent.ts
 *
 * 外国の AI 事業者への提供の同意画面 (T15 / #1154) の e2e 用の道具。
 *
 * AI を使う操作 (食事の写真の解析・AI 相談・献立の生成など) は、同意をしていない利用者が初めて使うときに、
 * 同意画面 (data-testid="ai-consent-modal") を出して、「同意する」「あとで」のどちらかが押されるまで待つ。
 * 同意画面を試すわけではない spec が、その画面で止まらないように、既定では「あとで」を選んだ状態でページを開く。
 * (「あとで」の期限は localStorage に持つ。サーバーには何も記録しない。src/hooks/useAiConsent.tsx)
 *
 * 同意画面そのものを試す spec は、これを使わない (fixtures/fresh-user.ts の regularUser など。
 * fixtures/auth.ts の authedPage を使うなら test.use({ aiConsentSnoozed: false }) にする)。
 */
import type { BrowserContext } from "@playwright/test";
import { AI_CONSENT_LATER_STORAGE_KEY } from "../../../src/lib/ai/consent-config";

/** 「あとで」の期限。十分先にしておく (実行中に切れて、途中から画面が出ることが無いように) */
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * このコンテキストで開くすべてのページを、外国の AI 事業者への提供の同意画面を「あとで」にした状態で始める。
 * すでに値があるとき (利用者が自分で選んだ後など) は上書きしない。
 */
export async function snoozeAiConsent(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    ({ key, until }) => {
      try {
        if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, String(until));
      } catch {
        // localStorage が使えないページ (about:blank など) では何もしない
      }
    },
    { key: AI_CONSENT_LATER_STORAGE_KEY, until: Date.now() + SNOOZE_MS },
  );
}
