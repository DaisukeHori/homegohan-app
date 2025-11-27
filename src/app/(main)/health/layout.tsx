import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "健康記録",
  description: "体重、体脂肪率、睡眠、気分などの健康データを記録・分析。AIがあなたの健康をサポートします。",
};

export default function HealthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

