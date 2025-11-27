import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "バッジ",
  description: "獲得したバッジを確認。自炊を続けてバッジをコレクションしよう！",
};

export default function BadgesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

