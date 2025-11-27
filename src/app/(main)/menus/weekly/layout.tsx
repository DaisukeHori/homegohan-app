import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "週間献立",
  description: "1週間分の献立を管理。AIが栄養バランスを考えた献立を提案します。",
};

export default function WeeklyMenuLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

