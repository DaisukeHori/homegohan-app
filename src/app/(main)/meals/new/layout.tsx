import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "食事を記録",
  description: "写真を撮るだけでAIが栄養分析。簡単に食事を記録できます。",
};

export default function NewMealLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

