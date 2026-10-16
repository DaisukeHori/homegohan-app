/**
 * #1173 未成年の年齢確認と保護者の同意 (E2E-2 / 設計書 docs/design/cross/14-parental-consent.md §6.13 F)
 *
 * 代表者 (fresh-family の freshFamilyWithOwner。生年月日は 1990-01-01) が 8 歳の子供を追加する:
 *   1. /family/members/child/new で名前・生年月日 (8 歳) を入れると「保護者の同意」の枠が出る
 *   2. 親権者の確認・同意の 2 つのチェックと署名 (氏名) を入れて追加する (S6)
 *   3. メンバーの詳細に「保護者の同意（記録済み）」が出る
 *   4. 家族から外すと、同じ子供の詳細が「保護者の同意（取り消し済み）」になる (S13)
 * 同意の行は DB (parental_consents) でも確かめる (service_role)。
 */
import { expect } from "@playwright/test";
import { test } from "../fixtures/fresh-family";
import { birthDateForAge, gotoWithoutClientErrors } from "../helpers/membership-family";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../../../.env.local") });

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
/** dev サーバーの初回コンパイルと画面の引き継ぎ (ハイドレーション) を待てるよう長めにする */
const NAVIGATION_TIMEOUT = 45_000;
const HYDRATION_TIMEOUT = 60_000;
const CHILD_AGE = 8;
const CHILD_NAME = "同意テスト子供";
const SIGNED_NAME = "テスト 保護者";

// 動画は tests/e2e/.output に書き出され、dev サーバーの再ビルドを招くので撮らない (07 と同じ)
test.use({ video: "off" });

/** service_role の REST で行を読む */
async function restSelect<T>(pathAndQuery: string): Promise<T[]> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const resp = await fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!resp.ok) throw new Error(`[spec-14] REST SELECT 失敗 (${resp.status}): ${(await resp.text()).substring(0, 300)}`);
  return (await resp.json()) as T[];
}

test.describe("#1173 保護者の同意 (E2E-2)", () => {
  test.setTimeout(180_000);

  test("代表者が 8 歳の子供を同意つきで追加 → 詳細に「保護者の同意（記録済み）」→ 外すと「取り消し済み」", async ({
    freshFamilyWithOwner,
  }) => {
    const { ownerPage: page, family } = freshFamilyWithOwner;

    await gotoWithoutClientErrors(page, `${BASE_URL}/family/members/child/new`);
    const nameInput = page.getByPlaceholder("例: 太郎");
    const birthInput = page.getByLabel(/生年月日/);
    const guardianCheck = page.getByRole("checkbox", { name: "私はこのお子さまの親権者または法定保護者です" });
    const agreeCheck = page.getByRole("checkbox", { name: "保護者の同意書の内容を確認し、同意します" });
    const signedName = page.getByLabel("署名（保護者の氏名をフルネームで入力）");
    const submit = page.getByRole("button", { name: "追加する" });

    await expect(nameInput).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    // 画面の引き継ぎ前に入れた値が消えることがあるので、押せる状態になるまでやり直す
    await expect(async () => {
      await nameInput.fill(CHILD_NAME, { timeout: 5_000 });
      await birthInput.fill(birthDateForAge(CHILD_AGE), { timeout: 5_000 });
      await expect(page.getByRole("heading", { name: "保護者の同意" })).toBeVisible({ timeout: 3_000 });
      await expect(page.getByRole("link", { name: "保護者の同意書の全文を読む" })).toHaveAttribute("href", "/legal/parental-consent");
      await expect(submit).toBeDisabled({ timeout: 2_000 });
      await guardianCheck.check({ timeout: 5_000 });
      await agreeCheck.check({ timeout: 5_000 });
      await signedName.fill(SIGNED_NAME, { timeout: 5_000 });
      await expect(submit).toBeEnabled({ timeout: 3_000 });
    }).toPass({ timeout: HYDRATION_TIMEOUT });

    await Promise.all([
      page.waitForURL((url) => url.pathname === "/family/members", { timeout: NAVIGATION_TIMEOUT, waitUntil: "commit" }),
      submit.click(),
    ]);

    // DB: 子供の行 (生年月日は列) と、有効な同意の行 (署名者 = 代表者・年齢 8)
    const members = await restSelect<{ id: string; birth_date: string | null; child_profile: Record<string, unknown> | null }>(
      `family_members?family_id=eq.${family.familyId}&role=eq.child&select=id,birth_date,child_profile`,
    );
    expect(members).toHaveLength(1);
    const child = members[0];
    expect(child.birth_date).toBe(birthDateForAge(CHILD_AGE));
    expect(child.child_profile ?? {}).not.toHaveProperty("birth_date");
    const consents = await restSelect<{
      parent_user_id: string | null;
      signed_name: string;
      child_age_at_signing: number;
      revoked_at: string | null;
    }>(`parental_consents?family_member_id=eq.${child.id}&select=parent_user_id,signed_name,child_age_at_signing,revoked_at`);
    expect(consents).toEqual([
      { parent_user_id: family.owner.userId, signed_name: SIGNED_NAME, child_age_at_signing: CHILD_AGE, revoked_at: null },
    ]);

    // 詳細: 記録済みのカード
    await gotoWithoutClientErrors(page, `${BASE_URL}/family/members/${child.id}`);
    const card = page.getByTestId("parental-consent-card");
    await expect(card).toContainText("保護者の同意（記録済み）", { timeout: NAVIGATION_TIMEOUT });
    await expect(card).toContainText(SIGNED_NAME);

    // 家族から外す (確認のダイアログは承諾する)
    page.once("dialog", (dialog) => void dialog.accept());
    await expect(async () => {
      await page.getByRole("button", { name: /家族から外す/ }).click({ timeout: 5_000 });
      await page.waitForURL((url) => url.pathname === "/family/members", { timeout: 10_000, waitUntil: "commit" });
    }).toPass({ timeout: HYDRATION_TIMEOUT });

    // 外したあとも同意の行は残り、取り消し済みになる
    await expect(async () => {
      const revoked = await restSelect<{ revoked_at: string | null; revoked_reason: string | null }>(
        `parental_consents?family_member_id=eq.${child.id}&select=revoked_at,revoked_reason`,
      );
      expect(revoked).toHaveLength(1);
      expect(revoked[0].revoked_at).not.toBeNull();
      expect(revoked[0].revoked_reason).toBe("member_removed");
    }).toPass({ timeout: NAVIGATION_TIMEOUT });

    await gotoWithoutClientErrors(page, `${BASE_URL}/family/members/${child.id}`);
    await expect(page.getByTestId("parental-consent-card")).toContainText("保護者の同意（取り消し済み）", {
      timeout: NAVIGATION_TIMEOUT,
    });
  });
});
