"use client";

/**
 * /admin 配下 (運営の管理画面) の受け皿 (#1207)
 * admin/layout.tsx のサイドバーとヘッダーを残したまま、本文の領域だけを差し替える。
 * (layout.tsx 自身の例外 (ロール確認の失敗など) は、この error.tsx ではなくルートの error.tsx が受ける)
 */

import { RouteError } from "@/components/error/RouteError";

export default function AdminError({
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
      boundary="admin"
      backHref="/admin/users"
      backLabel="ユーザー管理へ戻る"
    />
  );
}
