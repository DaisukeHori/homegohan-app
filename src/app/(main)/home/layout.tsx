import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ホーム",
  description: "今日の献立、健康サマリー、自炊記録を一目で確認。あなたの食生活をAIがサポートします。",
};

export default function HomeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

