import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "マイページ",
  description: "プロフィール設定、目標管理、食事履歴を確認できます。",
};

export default function ProfileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

