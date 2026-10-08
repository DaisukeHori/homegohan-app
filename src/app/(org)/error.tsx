"use client";

/**
 * (org) 配下 (組織の管理画面) の受け皿 (#1207)
 * (org)/layout.tsx のサイドバーを残したまま、本文の領域だけを差し替える。
 */

import { RouteError } from "@/components/error/RouteError";

export default function OrgError({
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
      boundary="org"
      backHref="/org/dashboard"
      backLabel="ダッシュボードへ戻る"
    />
  );
}
