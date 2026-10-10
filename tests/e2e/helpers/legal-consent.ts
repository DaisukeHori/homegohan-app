import { expect, type Page } from "@playwright/test";

/**
 * 規約の同意画面 (/legal-consent) に回されていたら、2 つのチェックを入れて「同意して続ける」を押す (#1174)。
 *
 * 環境変数 LEGAL_CONSENT_ENFORCE=on にしたサーバー (本番で強制を始めたあとを含む) では、同意の記録が無いテストユーザーは、
 * ログインした直後にどの画面を開いても同意画面へ回される。共通のログイン処理 (global-setup / helpers/auth.ts の login) が
 * この関数を呼ぶので、そのユーザーを使うほかの spec は、強制の有無を意識せずに動く。
 * 同意は DB に残る (user_profiles の同意済みの版と terms_acceptances) ので、2 回目以降のログインでは回されず、何もしない。
 *
 * 同意画面でなければ、何もせず false を返す。同意したら true を返す (押したあとは、元の画面 (next) へ戻るのを待つ)。
 *
 * ハイドレーション (React が画面を引き継ぐ) の前にチェックしても、引き継ぎで未チェックに戻ることがある。
 * 「押せる状態になるまでチェックをやり直す」ことで吸収する。
 */
export async function acceptLegalConsentIfShown(page: Page): Promise<boolean> {
  if (!new URL(page.url()).pathname.startsWith("/legal-consent")) return false;

  const terms = page.getByRole("checkbox", { name: /利用規約の内容を確認し、同意します/ });
  const privacy = page.getByRole("checkbox", { name: /プライバシーポリシーの内容を確認し、同意します/ });
  const accept = page.getByRole("button", { name: "同意して続ける" });

  await terms.waitFor({ state: "visible", timeout: 45_000 });
  await expect(async () => {
    await terms.check({ timeout: 5_000 });
    await privacy.check({ timeout: 5_000 });
    await expect(accept).toBeEnabled({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });

  // 押したあとは、読み込み直しで元の画面へ戻る (同意画面を離れた時点で十分。遷移先が読み終わるのは待たない)
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/legal-consent"), { timeout: 60_000, waitUntil: "commit" }),
    accept.click(),
  ]);
  return true;
}
