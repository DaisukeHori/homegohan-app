import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "組織チャレンジ",
  description: "職場のみんなと、食事の記録で楽しく競い合えるチャレンジ。参加は自由です。",
};

export default function ChallengesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
