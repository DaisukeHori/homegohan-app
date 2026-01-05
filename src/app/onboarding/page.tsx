"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// オンボーディングルーティング判定ページ
// 状態に応じて welcome / resume / home にリダイレクト
export default function OnboardingPage() {
  const router = useRouter();

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/onboarding/status');
        if (res.ok) {
          const data = await res.json();
          
          if (data.status === 'completed') {
            router.replace('/home');
          } else if (data.status === 'in_progress') {
            router.replace('/onboarding/resume');
          } else {
            router.replace('/onboarding/welcome');
          }
        } else {
          // API エラーの場合はウェルカムへ
          router.replace('/onboarding/welcome');
        }
      } catch (error) {
        console.error('Failed to check onboarding status:', error);
        router.replace('/onboarding/welcome');
      }
    };

    checkStatus();
  }, [router]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-orange-50 to-white flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500 mx-auto mb-4" />
        <p className="text-gray-500">読み込み中...</p>
      </div>
    </div>
  );
}
