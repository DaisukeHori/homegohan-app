"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { toOrgDailyStats } from "@/lib/converter";
import type { OrgDailyStats } from "@/types/domain";

// コンポーネント: スコアカード
const ScoreCard = ({ title, value, unit, subtext, color, icon }: any) => (
  <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 relative overflow-hidden group hover:shadow-md transition-shadow">
    <div className={`absolute top-0 right-0 w-24 h-24 bg-${color}-50 rounded-bl-[100px] -mr-4 -mt-4 transition-transform group-hover:scale-110`} />
    <div className="relative z-10">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-2xl">{icon}</span>
        <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider">{title}</h3>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-4xl font-black text-gray-900">{value}</span>
        <span className="text-sm font-bold text-gray-400">{unit}</span>
      </div>
      <p className="text-xs text-gray-400 mt-2">{subtext}</p>
    </div>
  </div>
);

export default function OrgDashboardPage() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<OrgDailyStats | null>(null);
  const supabase = createClient();

  const fetchStats = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // 1. 自分の組織IDを取得
      const { data: adminProfile } = await supabase
        .from('user_profiles')
        .select('organization_id')
        .eq('id', user.id)
        .single();

      if (!adminProfile?.organization_id) return;
      const orgId = adminProfile.organization_id;

      // 2. 最新の集計データを取得 (org_daily_stats)
      const { data: latestStats, error } = await supabase
        .from('org_daily_stats')
        .select('*')
        .eq('organization_id', orgId)
        .order('date', { ascending: false })
        .limit(1)
        .single();

      if (latestStats) {
        setStats(toOrgDailyStats(latestStats));
      } else {
        // データがない場合は初期集計をトライ
        // 初回表示などでデータがない場合
      }

    } catch (error) {
      console.error("Stats fetch error:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      // 1. 自分の組織ID取得
      const { data: { user } } = await supabase.auth.getUser();
      const { data: adminProfile } = await supabase.from('user_profiles').select('organization_id').eq('id', user!.id).single();
      
      // 2. Edge Function 呼び出し
      const { error } = await supabase.functions.invoke('aggregate-org-stats', {
        body: { 
          organizationId: adminProfile?.organization_id,
          date: new Date().toISOString().split('T')[0] 
        }
      });

      if (error) throw error;

      // 3. データ再取得
      await fetchStats();
      alert("最新データに更新しました");

    } catch (error) {
      console.error("Refresh failed:", error);
      alert("更新に失敗しました");
    } finally {
      setRefreshing(false);
    }
  };

  // 統計データを表示用に加工
  const displayStats = stats ? {
    memberCount: stats.memberCount,
    activeRate: stats.memberCount > 0 ? Math.round((stats.activeMemberCount / stats.memberCount) * 100) : 0,
    avgScore: stats.avgScore,
    breakfastRate: stats.breakfastRate,
    lateNightRate: stats.lateNightRate,
    date: stats.date,
  } : {
    memberCount: 0,
    activeRate: 0,
    avgScore: 0,
    breakfastRate: 0,
    lateNightRate: 0,
    date: '',
  };

  return (
    <div className="p-8 space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Health Cockpit</h1>
          <p className="text-gray-500 mt-2">
            組織のバイタルサインと生産性指標
            {displayStats.date && <span className="ml-2 text-xs bg-gray-100 px-2 py-1 rounded text-gray-600">Last updated: {displayStats.date}</span>}
          </p>
        </div>
        <div className="text-right flex items-center gap-4">
          <Button 
            variant="outline" 
            onClick={handleRefresh} 
            disabled={refreshing}
            className="rounded-full"
          >
            {refreshing ? "Updating..." : "↻ Refresh Data"}
          </Button>
          <div>
            <p className="text-xs font-bold text-gray-400 uppercase">Total Members</p>
            <p className="text-2xl font-bold text-gray-900">{displayStats.memberCount} <span className="text-sm font-normal text-gray-400">users</span></p>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="h-64 flex items-center justify-center bg-white rounded-2xl">
          <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <ScoreCard
            title="Vitality Score"
            value={displayStats.avgScore}
            unit="pts"
            subtext="Avg. nutritional quality"
            color="green"
            icon="🌿"
          />
          <ScoreCard
            title="Brain Fuel"
            value={`${displayStats.breakfastRate}%`}
            unit="share"
            subtext="Breakfast intake ratio"
            color="yellow"
            icon="⚡️"
          />
          <ScoreCard
            title="Rhythm Risk"
            value={`${displayStats.lateNightRate}%`}
            unit="rate"
            subtext="Late night meals (Alert > 15%)"
            color={displayStats.lateNightRate > 15 ? "red" : "blue"}
            icon="🌙"
          />
          <ScoreCard
            title="Active Rate"
            value={`${displayStats.activeRate}%`}
            unit="active"
            subtext="Daily active users"
            color="purple"
            icon="🔥"
          />
        </div>
      )}


      {/* 詳細分析セクション */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 min-h-[300px]">
          <h3 className="font-bold text-gray-900 mb-4">Why these metrics?</h3>
          <ul className="space-y-4 text-sm text-gray-600">
            <li className="flex gap-3">
              <span className="text-xl">⚡️</span>
              <div>
                <strong className="text-gray-900">Brain Fuel (朝食摂取率)</strong>
                <p>午前中の集中力と生産性に直結します。低い場合は、朝食支給制度などを検討してください。</p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-xl">🌙</span>
              <div>
                <strong className="text-gray-900">Rhythm Risk (深夜食率)</strong>
                <p>睡眠の質を低下させ、翌日のパフォーマンスダウンを招きます。残業過多のサインかもしれません。</p>
              </div>
            </li>
          </ul>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 min-h-[300px]">
          <div className="flex justify-between items-center mb-6">
            <h3 className="font-bold text-gray-900">Department Ranking 🏆</h3>
            <span className="text-xs text-gray-400">Avg. Score</span>
          </div>
          
          <div className="space-y-4">
            {/* 今後実装: 部署ごとの集計データ */}
            {[
              { name: 'Sales Team', score: 88, trend: 'up' },
              { name: 'Engineering', score: 82, trend: 'down' },
              { name: 'HR & Admin', score: 79, trend: 'same' }
            ].map((dept, i) => (
              <div key={i} className="flex items-center gap-4">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${i === 0 ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-500'}`}>
                  {i + 1}
                </div>
                <div className="flex-1">
                  <div className="flex justify-between items-center mb-1">
                    <span className="font-bold text-gray-800">{dept.name}</span>
                    <span className="font-bold text-gray-900">{dept.score}</span>
                  </div>
                  <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
                    <div 
                      className={`h-full rounded-full ${i===0 ? 'bg-gradient-to-r from-yellow-400 to-orange-400' : 'bg-gray-300'}`} 
                      style={{ width: `${dept.score}%` }} 
                    />
                  </div>
                </div>
              </div>
            ))}
            <div className="mt-6 pt-4 border-t border-gray-50 text-center">
               <p className="text-xs text-gray-400">
                 ※ 部署機能の有効化には、メンバー詳細設定で `department` の登録が必要です。
               </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
