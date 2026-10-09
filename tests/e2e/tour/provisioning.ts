/**
 * tests/e2e/tour/provisioning.ts
 *
 * ハンズオンツアーの E2E が「テスト用ユーザーを作れる環境か」を判断する部分 (#846)。
 * Playwright にも DB にも触れない純粋な関数だけにして、tests/e2e-tour-contract.test.ts (`npm test`) で検査する。
 *
 * 環境が足りないとき、CI (E2E_REQUIRE_LOGIN=1) では静かに skip せず失敗にする。
 * 以前のツアーの spec は、足りないものがあると test.skip で緑のまま終わり、CI で何も確かめていなかった。
 */

export type ProvisioningEnv = Record<string, string | undefined>;

/** テスト用ユーザーを作るのに要る環境変数 (ローカルは `bash scripts/supabase-local.sh env .env.local` が .env.local に書く) */
export const PROVISIONING_ENV_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

/** 足りない環境変数の名前 (全部そろっていれば空) */
export function missingProvisioningEnv(env: ProvisioningEnv): string[] {
  return PROVISIONING_ENV_NAMES.filter((name) => !env[name]);
}

export type ProvisioningDecision =
  | { action: "run" }
  /** この環境では動かせない。理由を付けて test.fixme にする */
  | { action: "fixme"; reason: string }
  /** 動かせるはずの環境 (CI) なのに足りない。静かに skip せず、失敗にする */
  | { action: "fail"; reason: string };

/**
 * テストを走らせるか、理由付きで fixme にするか、失敗にするか。
 * E2E_REQUIRE_LOGIN=1 は tests/e2e/global-setup.ts と同じ「CI ではログインできなければ止める」の目印。
 */
export function decideProvisioning(env: ProvisioningEnv): ProvisioningDecision {
  const missing = missingProvisioningEnv(env);
  if (missing.length === 0) return { action: "run" };

  const base = `テスト用ユーザーを作る環境変数 (${missing.join(", ")}) が無い`;
  const how = "ローカルは bash scripts/supabase-local.sh env .env.local で用意する";
  if (env.E2E_REQUIRE_LOGIN === "1") {
    return { action: "fail", reason: `${base} (E2E_REQUIRE_LOGIN=1 なので skip せず失敗にします)。${how}` };
  }
  return { action: "fixme", reason: `${base}ため動かせない (本番 URL に向けた実行など)。${how}` };
}
