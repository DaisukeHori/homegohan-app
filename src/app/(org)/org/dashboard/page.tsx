"use client";

import { useEffect, useState } from "react";

// 組織の集計 (活力スコア・朝食摂取率・深夜食率・活動率) と、部署別の表示は、オーナー判断 (#1325 / #1120) で止めている。
// 集計結果の表は読まない。ここに出すのは、メンバー数 (GET /api/org/stats) だけ。
// 部署ごとのランキングはダミーの数字だったので取り除いた。

type MemberCountState =
  | { status: "loading" }
  | { status: "loaded"; memberCount: number }
  | { status: "error" };

export default function OrgDashboardPage() {
  const [members, setMembers] = useState<MemberCountState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        const res = await fetch("/api/org/stats", { signal: controller.signal });
        if (!res.ok) throw new Error(`org stats failed: HTTP ${res.status}`);
        const body = await res.json();
        const memberCount = body?.stats?.member_count;
        if (typeof memberCount !== "number") throw new Error("org stats: member_count is missing");
        setMembers({ status: "loaded", memberCount });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("Org member count fetch error:", error);
        setMembers({ status: "error" });
      }
    };
    void load();

    return () => controller.abort();
  }, []);

  return (
    <div className="p-8 space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Health Cockpit</h1>
          <p className="text-gray-500 mt-2">組織のバイタルサインと生産性指標</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-bold text-gray-400 uppercase">Total Members</p>
          {members.status === "loaded" ? (
            <p className="text-2xl font-bold text-gray-900">
              {members.memberCount} <span className="text-sm font-normal text-gray-400">users</span>
            </p>
          ) : (
            <p className="text-2xl font-bold text-gray-400" aria-busy={members.status === "loading"}>
              —
            </p>
          )}
          {members.status === "error" && (
            <p className="text-xs text-red-500 mt-1">メンバー数を取得できませんでした</p>
          )}
        </div>
      </div>

      <div className="bg-white p-8 rounded-2xl shadow-sm border border-gray-100 text-center">
        <p className="font-bold text-gray-700">組織の集計・部署別の表示は準備中です</p>
      </div>
    </div>
  );
}
