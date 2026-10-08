"use client";

/**
 * (main) 配下の受け皿。表示と記録は共通部品 RouteError (#1207) に集約している。
 * サイドバー付きの (main)/layout.tsx の内側に描画される。
 */

import { RouteError } from "@/components/error/RouteError";

export default function MainError({
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
      boundary="main"
      backHref="/home"
      backLabel="ホームへ戻る"
      fullScreen
    />
  );
}
