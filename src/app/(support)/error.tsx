"use client";

/**
 * (support) 配下 (サポート担当の画面) の受け皿 (#1207)
 * (support)/layout.tsx のサイドバーを残したまま、本文の領域だけを差し替える。
 */

import { RouteError } from "@/components/error/RouteError";

export default function SupportError({
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
      boundary="support"
      backHref="/support"
      backLabel="サポートのトップへ戻る"
    />
  );
}
