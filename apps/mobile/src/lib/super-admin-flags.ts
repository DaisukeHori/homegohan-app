/**
 * 運営の機能フラグ画面 (app/(super-admin)/super-admin/feature-flags.tsx) 用のデータ変換 (#1137)
 *
 * サーバーは GET /api/super-admin/flags で
 *   { data: [{ key, description, enabled, rollout_strategy, constraints, active_user_count, updated_at }], meta }
 * を返す (src/app/api/super-admin/flags/route.ts)。
 * モバイルで扱うのは ON/OFF の切り替えだけなので、画面に要る key / description / enabled だけを取り出す。
 * rollout_strategy (段階公開) と constraints (対象条件) の編集は Web の管理画面で行う。
 */

export type SuperAdminFeatureFlag = {
  key: string;
  description: string;
  enabled: boolean;
};

/**
 * GET /api/super-admin/flags の応答を、キー順の一覧にする。
 * - data が配列でない応答 (想定外の形) は、空の一覧に見せかけず、エラーにして画面に出す
 * - key が無い行は捨てる。description が無ければ空文字、enabled は真偽値でなければ false
 */
export function parseFeatureFlagsResponse(res: unknown): SuperAdminFeatureFlag[] {
  const data = (res as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) {
    throw new Error("機能フラグの応答の形式が想定と異なります。");
  }

  const flags: SuperAdminFeatureFlag[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const { key, description, enabled } = row as Record<string, unknown>;
    if (typeof key !== "string" || key === "") continue;
    flags.push({
      key,
      description: typeof description === "string" ? description : "",
      enabled: enabled === true,
    });
  }

  return flags.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
