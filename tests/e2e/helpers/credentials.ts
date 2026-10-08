/**
 * tests/e2e/helpers/credentials.ts
 *
 * e2e のパスワードの取り扱いを一か所にまとめる。
 *
 * - 既存アカウント (e2e-user-XX): パスワードは環境変数 (E2E_USER_XX_PASSWORD / E2E_USER_PASSWORD) からだけ取る。
 *   リポジトリには既定値を置かない (公開リポジトリに書かれた値が本番のパスワードと同じだった事故の再発防止)。
 * - 共通のテストユーザー (E2E_USER_EMAIL / E2E_USER_PASSWORD): メールアドレスもパスワードも環境変数からだけ取る。
 *   特定のアカウント (本番のデバッグ用アカウントなど) のメールアドレスやパスワードを、既定値としてコードに書かない (#1114)。
 *   tests/no-committed-credentials.test.ts が、リポジトリにそうした値が残っていないかを検査する。
 * - テストの中で新しく作るユーザー: 実行ごとにランダムなパスワードを作る。
 */
import { randomBytes } from "node:crypto";

/**
 * 実行ごとに変わるランダムなテスト用パスワードを返す。
 * アプリのパスワード要件 (src/lib/auth/validate-password.ts: 8 文字以上・英数字混在) を満たすよう、
 * 末尾に大文字・小文字・数字・記号を足している。
 */
export function generateTestPassword(): string {
  return `${randomBytes(18).toString("base64url")}Aa1!`;
}

/**
 * 既存アカウントのパスワードを環境変数から返す。無ければ undefined。
 * 優先順位: 個別 (E2E_USER_XX_PASSWORD) > 共通 (E2E_USER_PASSWORD)。
 *
 * @param padded - 2 桁のユーザー番号 ("01" 〜 "10")。省略時は共通の E2E_USER_PASSWORD だけを見る
 */
export function getExistingUserPassword(padded?: string): string | undefined {
  const perUser = padded ? process.env[`E2E_USER_${padded}_PASSWORD`] : undefined;
  return perUser || process.env.E2E_USER_PASSWORD || undefined;
}

/**
 * 既存アカウントのパスワードを返す。環境変数が無ければ、既定値を使わずにエラーで止める。
 */
export function requireExistingUserPassword(padded?: string): string {
  const password = getExistingUserPassword(padded);
  if (password) return password;
  const names = padded ? `E2E_USER_${padded}_PASSWORD または E2E_USER_PASSWORD` : "E2E_USER_PASSWORD";
  throw new Error(
    `[e2e] 既存テストユーザーのパスワードが未設定です。環境変数 ${names} を設定してください ` +
      "(ローカルは .env.local。scripts/create-e2e-accounts.ts が .env.local に書きます。CI は Secrets)。" +
      "リポジトリに既定値はありません (tests/e2e/README.md)。",
  );
}

/**
 * 共通のテストユーザーの認証情報を、環境変数 E2E_USER_EMAIL / E2E_USER_PASSWORD から返す。
 * どちらかが未設定 (空文字を含む) なら、既定のアカウントやパスワードを使わずにエラーで止める。
 */
export function requireE2eUserCredentials(): { email: string; password: string } {
  const email = process.env.E2E_USER_EMAIL || undefined;
  const password = getExistingUserPassword();
  if (email && password) return { email, password };
  const missing = [email ? null : "E2E_USER_EMAIL", password ? null : "E2E_USER_PASSWORD"].filter(Boolean);
  throw new Error(
    `[e2e] 共通テストユーザーの認証情報が未設定です。環境変数 ${missing.join(" と ")} を設定してください ` +
      "(ローカルは .env.local。CI は Secrets)。リポジトリに既定のアカウントやパスワードはありません (tests/e2e/README.md)。",
  );
}
