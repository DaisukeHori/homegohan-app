"use client";

/**
 * /operator/membership 配下 (運営の緊急介入画面) の受け皿 (#1207)
 * operator/membership/layout.tsx のサイドバーを残したまま、本文の領域だけを差し替える。
 * (layout.tsx 自身の例外 (ロール確認の失敗など) は、この error.tsx ではなくルートの error.tsx が受ける)
 */

import { RouteError } from "@/components/error/RouteError";

export default function OperatorMembershipError({
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
      boundary="operator-membership"
      backHref="/operator/membership/orgs/inactive"
      backLabel="inactive owner 検索へ戻る"
    />
  );
}
