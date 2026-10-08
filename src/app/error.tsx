"use client";

/**
 * ルート全体の受け皿 (#1207)
 *
 * ここより内側に専用の error.tsx が無い画面 (公開ページ、招待、家族参加の承認など) の例外は、
 * これが受ける。ルートの layout (フォント・計測・スキップリンク) を残したまま、中身だけを差し替える。
 * ルートの layout 自体の例外は、ここではなく global-error.tsx が受ける。
 */

import { RouteError } from "@/components/error/RouteError";

export default function RootError({
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
      boundary="root"
      backHref="/"
      backLabel="トップページへ戻る"
      fullScreen
    />
  );
}
