"use client";

/**
 * /handson-tour 配下 (はじめてのガイド) の受け皿 (#1207)
 * handson-tour/layout.tsx (TourProvider) の内側に描画する。
 * layout.tsx 自身の例外 (ログイン確認やツアー状態の取得の失敗など) は、ルートの error.tsx が受ける。
 */

import { RouteError } from "@/components/error/RouteError";

export default function HandsonTourError({
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
      boundary="handson-tour"
      backHref="/home"
      backLabel="ホームへ戻る"
      fullScreen
    />
  );
}
