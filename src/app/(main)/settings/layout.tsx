import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "設定",
  description: "アカウント設定、通知設定、プライバシー設定を管理できます。",
};

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

