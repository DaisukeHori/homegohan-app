"use client";

/**
 * /onboarding 配下 (初期設定) の受け皿 (#1207)
 * onboarding/layout.tsx の背景を残したまま、本文の領域だけを差し替える。
 * 回答はその都度サーバーへ保存される (questions/page.tsx の saveProgress) ので、戻り先は再開画面にする。
 */

import { RouteError } from "@/components/error/RouteError";

export default function OnboardingError({
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
      boundary="onboarding"
      backHref="/onboarding/resume"
      backLabel="続きから再開する"
    />
  );
}
