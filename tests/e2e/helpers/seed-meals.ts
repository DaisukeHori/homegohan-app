/**
 * tests/e2e/helpers/seed-meals.ts
 *
 * E2E テスト用: meals テーブルへのシードデータ挿入ヘルパー。
 * service_role 経由で is_sandbox=false の非サンドボックス食事記録を作成する。
 * 主に existing_user_auto_skip のテストシナリオで使用する。
 */

import * as path from "path";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/**
 * service_role 経由で指定ユーザーに非サンドボックス食事記録を挿入する。
 * ハンズオンツアーの eligibility API は is_sandbox=false の meals が存在する場合に
 * reason=existing_user_auto_skip を返す。
 *
 * @param userId - 対象ユーザーの UUID
 * @param count - 挿入するレコード数 (デフォルト 1)
 * @returns 挿入されたレコード数 (0 は失敗を意味する)
 */
export async function seedNonSandboxMeals(
  userId: string,
  count = 1,
): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("[seed-meals] SUPABASE_SERVICE_ROLE_KEY が未設定 — meals 挿入をスキップ");
    return 0;
  }

  const rows = Array.from({ length: count }, (_, i) => ({
    user_id: userId,
    eaten_at: new Date(Date.now() - i * 86_400_000).toISOString(), // i 日前
    meal_type: "lunch",
    is_sandbox: false,
  }));

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/meals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "return=minimal,resolution=ignore-duplicates",
      },
      body: JSON.stringify(rows),
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.warn(`[seed-meals] meals 挿入失敗 (${resp.status}): ${body.substring(0, 200)}`);
      return 0;
    }

    return count;
  } catch (err) {
    console.warn(`[seed-meals] seedNonSandboxMeals error: ${err}`);
    return 0;
  }
}

/**
 * service_role 経由で指定ユーザーの全 meals レコードを削除する。
 * テスト後のクリーンアップ用。
 */
export async function cleanupMeals(userId: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/meals?user_id=eq.${userId}`, {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "return=minimal",
      },
    });
  } catch (err) {
    console.warn(`[seed-meals] cleanupMeals error: ${err}`);
  }
}
