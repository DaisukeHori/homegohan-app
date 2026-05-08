"use client";

import { useEffect, useState } from "react";
import type { NpsSummary, CsatSummary } from "@/lib/admin/finance-schemas";

interface NpsApiResponse {
  nps: NpsSummary;
  csat: CsatSummary;
}

function ScoreBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="text-sm text-slate-500 w-20 shrink-0">{label}</div>
      <div className="flex-1 bg-slate-100 rounded-full h-2">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-sm font-medium text-slate-700 w-16 text-right">
        {count} ({pct.toFixed(1)}%)
      </div>
    </div>
  );
}

export default function NpsPage() {
  const [data, setData] = useState<NpsApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [planKey, setPlanKey] = useState("");

  const fetchData = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (planKey) params.set("plan_key", planKey);

    fetch(`/api/admin/finance/nps?${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) setError(json.error.message);
        else setData(json.data as NpsApiResponse);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">NPS / CSAT</h1>
        <p className="text-sm text-slate-500 mt-1">Net Promoter Score & Customer Satisfaction</p>
      </div>

      {/* フィルタ */}
      <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4 mb-6 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-slate-500 mb-1">期間 FROM</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">期間 TO</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">プラン</label>
          <select value={planKey} onChange={(e) => setPlanKey(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
            <option value="">すべて</option>
            <option value="free">free</option>
            <option value="pro">pro</option>
            <option value="family_basic">family_basic</option>
            <option value="family_pro">family_pro</option>
            <option value="org_starter">org_starter</option>
            <option value="org_standard">org_standard</option>
            <option value="org_pro">org_pro</option>
          </select>
        </div>
        <button
          onClick={fetchData}
          className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition-colors"
        >
          適用
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">{error}</div>
      ) : data ? (
        <div className="space-y-6">
          {/* NPS スコア */}
          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6">
            <h2 className="text-base font-semibold text-slate-700 mb-5">NPS (Net Promoter Score)</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="text-center p-4 bg-indigo-50 rounded-xl">
                <div className="text-3xl font-bold text-indigo-700">{data.nps.nps_score}</div>
                <div className="text-xs text-indigo-500 mt-1">NPS スコア</div>
              </div>
              <div className="text-center p-4 bg-slate-50 rounded-xl">
                <div className="text-2xl font-bold text-slate-700">{data.nps.total_responses}</div>
                <div className="text-xs text-slate-400 mt-1">回答数</div>
              </div>
              <div className="text-center p-4 bg-slate-50 rounded-xl">
                <div className="text-2xl font-bold text-slate-700">{data.nps.avg_score}</div>
                <div className="text-xs text-slate-400 mt-1">平均スコア</div>
              </div>
              <div className="text-center p-4 bg-slate-50 rounded-xl">
                <div className="text-2xl font-bold text-slate-700">{data.nps.response_rate}%</div>
                <div className="text-xs text-slate-400 mt-1">回答率</div>
              </div>
            </div>

            <div className="space-y-3">
              <ScoreBar
                label="推薦者 (9-10)"
                count={data.nps.promoters}
                total={data.nps.total_responses}
                color="bg-green-500"
              />
              <ScoreBar
                label="中立 (7-8)"
                count={data.nps.passives}
                total={data.nps.total_responses}
                color="bg-yellow-400"
              />
              <ScoreBar
                label="批判者 (0-6)"
                count={data.nps.detractors}
                total={data.nps.total_responses}
                color="bg-red-400"
              />
            </div>
          </div>

          {/* CSAT */}
          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6">
            <h2 className="text-base font-semibold text-slate-700 mb-5">CSAT (Customer Satisfaction)</h2>
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="text-center p-4 bg-indigo-50 rounded-xl">
                <div className="text-3xl font-bold text-indigo-700">{data.csat.avg_score}</div>
                <div className="text-xs text-indigo-500 mt-1">平均スコア (1-5)</div>
              </div>
              <div className="text-center p-4 bg-slate-50 rounded-xl">
                <div className="text-2xl font-bold text-slate-700">{data.csat.total_responses}</div>
                <div className="text-xs text-slate-400 mt-1">回答数</div>
              </div>
            </div>

            <div className="space-y-2">
              {[5, 4, 3, 2, 1].map((score) => (
                <ScoreBar
                  key={score}
                  label={`★ ${score}`}
                  count={data.csat.score_distribution[String(score)] ?? 0}
                  total={data.csat.total_responses}
                  color={score >= 4 ? "bg-green-500" : score === 3 ? "bg-yellow-400" : "bg-red-400"}
                />
              ))}
            </div>
          </div>

          {/* 最近のコメント */}
          {data.nps.recent_comments.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6">
              <h2 className="text-base font-semibold text-slate-700 mb-4">最近の NPS コメント</h2>
              <div className="space-y-3">
                {data.nps.recent_comments.map((c) => (
                  <div key={c.id} className="border border-slate-100 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`text-sm font-bold ${c.score >= 9 ? "text-green-600" : c.score >= 7 ? "text-yellow-600" : "text-red-600"}`}>
                        {c.score}点
                      </span>
                      {c.plan_key && (
                        <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded">
                          {c.plan_key}
                        </span>
                      )}
                      {c.responded_at && (
                        <span className="text-xs text-slate-400">
                          {new Date(c.responded_at).toLocaleDateString("ja-JP")}
                        </span>
                      )}
                    </div>
                    {c.comment && (
                      <p className="text-sm text-slate-600">{c.comment}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
