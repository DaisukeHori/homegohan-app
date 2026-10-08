"use client";

// 組織チャレンジの一覧 (#1132)。組織のメンバーが、参加できるチャレンジと、自分の参加状況を見る。
//
// - 参加は任意。ここでは参加の操作はせず、詳細ページ (/challenges/[id]) で、数え方を読んでから参加を決める
// - 表示するのは、自分の組織のチャレンジと、人数と、自分の記録・順位だけ。他の参加者の記録・順位は、詳細ページで参加者本人にだけ見せる
// - ネイティブアプリの WebView では、ホーム画面の「組織チャレンジ」から開く (app/(main)/home/page.tsx)

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ORG_CHALLENGE_MIN_PARTICIPANTS,
  ORG_CHALLENGE_TYPE_LABELS,
  formatOrgChallengeValue,
  formatParticipantCount,
} from "@/lib/org-challenges";

interface MyChallenge {
  id: string;
  title: string;
  description: string | null;
  challengeType: string;
  targetValue: number | null;
  targetUnit: string | null;
  startDate: string;
  endDate: string;
  status: string;
  /** 参加者が最小人数に満たないときは null (API が人数を返さない) */
  participantCount: number | null;
  joined: boolean;
  me: { currentValue: number; rank: number | null; joinedAt: string | null } | null;
}

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "not-member" }
  | { status: "loaded"; challenges: MyChallenge[]; minParticipants: number };

/** YYYY-MM-DD を 10/1 の形にする */
function shortDate(date: string): string {
  const [, month, day] = date.split("-");
  return month && day ? `${Number(month)}/${Number(day)}` : date;
}

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  active: { label: "開催中", className: "bg-emerald-100 text-emerald-800" },
  completed: { label: "終了", className: "bg-gray-100 text-gray-700" },
};

export default function ChallengesPage() {
  const [state, setState] = useState<ListState>({ status: "loading" });

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    try {
      const res = await fetch("/api/org/my-challenges", { signal });
      if (res.status === 403) {
        setState({ status: "not-member" });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setState({
        status: "loaded",
        challenges: Array.isArray(body?.challenges) ? body.challenges : [],
        minParticipants:
          typeof body?.minParticipants === "number" ? body.minParticipants : ORG_CHALLENGE_MIN_PARTICIPANTS,
      });
    } catch (error) {
      if (signal?.aborted) return;
      console.error("Failed to load challenges:", error);
      setState({ status: "error", message: "チャレンジを読み込めませんでした。通信状況を確認して、もう一度お試しください。" });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <header className="bg-white p-6 pb-8 rounded-b-[40px] shadow-sm mb-6">
        <Link href="/home" className="inline-block text-sm text-gray-600 mb-3 hover:text-gray-900">
          ← ホームへ戻る
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">組織チャレンジ</h1>
        <p className="text-gray-600 text-sm">
          職場のみんなと、食事の記録で楽しく競い合えます。参加するかどうかは、あなたの自由です。
        </p>
      </header>

      <div className="px-4 space-y-4">
        <section
          aria-labelledby="challenge-privacy-title"
          className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 text-sm text-emerald-900 space-y-1"
        >
          <h2 id="challenge-privacy-title" className="font-bold">参加したときの記録の扱い</h2>
          <ul className="list-disc pl-5 space-y-1 text-emerald-900">
            <li>参加すると、チャレンジの期間中の食事の記録から、朝食をとれた日の割合などを自動で計算します。</li>
            <li>順位が見えるのは、参加した人だけです。</li>
            <li>会社の管理者には、参加者全体の人数と平均だけが表示されます (参加者が少ない間は、人数も平均も表示されません)。あなたの記録や順位は表示されません。</li>
            <li>参加は、いつでもやめられます。</li>
          </ul>
        </section>

        {state.status === "loading" && (
          <div role="status" aria-live="polite" className="text-center text-gray-600 py-12">
            <div className="animate-spin w-8 h-8 border-4 border-gray-700 border-t-transparent rounded-full mx-auto mb-4" aria-hidden="true" />
            読み込み中...
          </div>
        )}

        {state.status === "not-member" && (
          <div className="bg-white rounded-3xl p-8 text-center shadow-sm">
            <div className="text-5xl mb-4" aria-hidden="true">🏢</div>
            <h2 className="text-lg font-bold text-gray-900 mb-2">組織に所属している方のための機能です</h2>
            <p className="text-gray-600 text-sm">
              会社などの組織に招待されると、ここに組織のチャレンジが表示されます。
            </p>
          </div>
        )}

        {state.status === "error" && (
          <div role="alert" className="bg-white rounded-3xl p-8 text-center shadow-sm">
            <div className="text-5xl mb-4" aria-hidden="true">❌</div>
            <p className="text-gray-700 text-sm mb-4">{state.message}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="px-5 py-2 bg-gray-900 text-white rounded-full text-sm font-medium"
            >
              もう一度読み込む
            </button>
          </div>
        )}

        {state.status === "loaded" && state.challenges.length === 0 && (
          <div className="bg-white rounded-3xl p-8 text-center shadow-sm">
            <div className="text-5xl mb-4" aria-hidden="true">🏆</div>
            <h2 className="text-lg font-bold text-gray-900 mb-2">いま参加できるチャレンジはありません</h2>
            <p className="text-gray-600 text-sm">組織の管理者がチャレンジを始めると、ここに表示されます。</p>
          </div>
        )}

        {state.status === "loaded" && state.challenges.length > 0 && (
          <ul className="space-y-3">
            {state.challenges.map((challenge) => {
              const status = STATUS_LABELS[challenge.status] ?? {
                label: challenge.status,
                className: "bg-gray-100 text-gray-700",
              };
              return (
                <li key={challenge.id}>
                  <Link
                    href={`/challenges/${challenge.id}`}
                    className="block bg-white rounded-2xl p-4 shadow-sm border border-gray-100 hover:shadow-md transition-shadow"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="font-bold text-gray-900 break-words">{challenge.title}</h2>
                        <p className="text-sm text-gray-600 mt-1">
                          {ORG_CHALLENGE_TYPE_LABELS[challenge.challengeType] ?? challenge.challengeType}
                          {" ・ "}
                          {shortDate(challenge.startDate)}〜{shortDate(challenge.endDate)}
                        </p>
                      </div>
                      <span className={`shrink-0 px-2 py-1 rounded-full text-xs font-medium ${status.className}`}>
                        {status.label}
                      </span>
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                      <span className="text-gray-600">
                        参加者 {formatParticipantCount(challenge.participantCount, state.minParticipants)}
                      </span>
                      {challenge.joined ? (
                        <span className="text-emerald-800 font-medium text-right">
                          {challenge.me?.rank != null ? (
                            <>
                              参加中 ・ {challenge.me.rank}位 ・{" "}
                              {formatOrgChallengeValue(challenge.challengeType, challenge.me.currentValue)}
                            </>
                          ) : (
                            <>参加中 ・ 集計待ち</>
                          )}
                        </span>
                      ) : (
                        <span className="text-gray-600">
                          {challenge.status === "active" ? "まだ参加していません" : "参加していません"}
                        </span>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
