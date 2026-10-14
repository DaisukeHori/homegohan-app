"use client";

// 組織チャレンジ (#1132) への入り口。ホーム画面に置く小さなカード。
//
// 組織に所属していて、見られるチャレンジ (開催中か終了したもの) があるときだけ表示する。
// 組織に所属していない人 (API は 403) と、チャレンジが 1 つもない組織の人には、何も出さない。
// ネイティブアプリの WebView でも、Web のホーム画面からそのまま /challenges へ移れる (タブの切り替えにはならない)。

import { useEffect, useState } from "react";
import Link from "next/link";

interface EntrySummary {
  active: number;
  joined: number;
}

export function OrgChallengeEntry() {
  const [summary, setSummary] = useState<EntrySummary | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        const res = await fetch("/api/org/my-challenges", { signal: controller.signal });
        // 403 (組織に所属していない) などは、入り口を出さないだけ
        if (!res.ok) return;
        const body = await res.json();
        const challenges: Array<{ status?: string; joined?: boolean }> = Array.isArray(body?.challenges)
          ? body.challenges
          : [];
        if (challenges.length === 0) return;
        setSummary({
          active: challenges.filter((c) => c.status === "active").length,
          joined: challenges.filter((c) => c.joined === true).length,
        });
      } catch {
        // 中断・通信エラー: 入り口が出ないだけ
      }
    };
    void load();

    return () => controller.abort();
  }, []);

  if (!summary) return null;

  return (
    <Link href="/challenges" className="block">
      <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-2xl p-4 border border-emerald-100 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-emerald-600 text-white text-lg" aria-hidden="true">
          🏢
        </div>
        <div className="flex-1">
          <p className="text-sm font-bold text-emerald-900">組織チャレンジ</p>
          <p className="text-xs text-emerald-800">
            {summary.active > 0 ? `開催中 ${summary.active}件` : "終了したチャレンジがあります"}
            {summary.joined > 0 ? ` ・ 参加中 ${summary.joined}件` : " ・ 参加は自由です"}
          </p>
        </div>
        <span className="text-emerald-700 text-sm" aria-hidden="true">
          ›
        </span>
      </div>
    </Link>
  );
}
