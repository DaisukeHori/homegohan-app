"use client";

/**
 * /super-admin 配下 (最上位の運営画面) の受け皿 (#1207)
 * super-admin/layout.tsx のサイドバーを残したまま、本文の領域だけを差し替える。
 * (layout.tsx 自身の例外 (ロール確認の失敗など) は、この error.tsx ではなくルートの error.tsx が受ける)
 */

import { RouteError } from "@/components/error/RouteError";

export default function SuperAdminError({
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
      boundary="super-admin"
      backHref="/super-admin/plans"
      backLabel="プラン管理へ戻る"
    />
  );
}
