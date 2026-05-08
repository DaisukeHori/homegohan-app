import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = {
  title: "週間献立",
  description: "1週間分の献立を管理。AIが栄養バランスを考えた献立を提案します。",
};

export default function WeeklyMenuLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // useSearchParams を使うため Suspense でラップ
  return <Suspense>{children}</Suspense>;
}

