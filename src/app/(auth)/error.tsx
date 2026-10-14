"use client";

/**
 * (auth) 配下 (ログイン・新規登録・パスワード再設定など) の受け皿 (#1207)
 * (auth)/layout.tsx の左側のビジュアルを残したまま、フォームの領域だけを差し替える。
 * 未ログインの画面なので、サーバーログ (/api/log) には残らない (コンソールと digest で追う)。
 */

import { RouteError } from "@/components/error/RouteError";

export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      error={error}
      reset={reset}
      boundary="auth"
      backHref="/"
      backLabel="トップページへ戻る"
    />
  );
}
