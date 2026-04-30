"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface DailyCompletion {
  date: string;
  completed: number;
}

interface ModeDistribution {
  name: string;
  value: number;
}

const MODE_COLORS: Record<string, string> = {
  cook: '#22c55e',
  quick: '#3b82f6',
  buy: '#a855f7',
  out: '#f97316',
};

const MODE_LABELS: Record<string, string> = {
  cook: '自炊',
  quick: '時短',
  buy: '購入',
  out: '外食',
};

export default function AdminDashboard() {
  const [stats, setStats] = useState({
    totalUsers: 0,
    totalPlannedMeals: 0,
    completedMeals: 0,
    todayMeals: 0,
    pendingFlags: 0,
    cookRate: 0,
  });
  const [completionTrend, setCompletionTrend] = useState<DailyCompletion[]>([]);
  const [modeDistribution, setModeDistribution] = useState<ModeDistribution[]>([]);

  useEffect(() => {
    const fetchStats = async () => {
      const supabase = createClient();
      const today = new Date().toISOString().split('T')[0];

      // 並列でカウント取得
      const [
        { count: users },
        { count: plannedMeals },
        { count: completedMeals },
        { count: todayCompleted },
        { count: flags },
        { count: cookMeals },
      ] = await Promise.all([
        supabase.from('user_profiles').select('*', { count: 'exact', head: true }),
        supabase.from('planned_meals').select('*', { count: 'exact', head: true }),
        supabase.from('planned_meals').select('*', { count: 'exact', head: true })
          .eq('is_completed', true),
        supabase.from('planned_meals').select('*', { count: 'exact', head: true })
          .eq('is_completed', true)
          .gte('completed_at', today),
        supabase.from('moderation_flags').select('*', { count: 'exact', head: true })
          .eq('status', 'pending'),
        supabase.from('planned_meals').select('*', { count: 'exact', head: true })
          .in('mode', ['cook', 'quick']),
      ]);

      const totalPlanned = plannedMeals || 0;
      const totalCook = cookMeals || 0;
      const cookRate = totalPlanned > 0 ? Math.round((totalCook / totalPlanned) * 100) : 0;

      setStats({
        totalUsers: users || 0,
        totalPlannedMeals: totalPlanned,
        completedMeals: completedMeals || 0,
        todayMeals: todayCompleted || 0,
        pendingFlags: flags || 0,
        cookRate: cookRate,
      });
    };

    const fetchChartData = async () => {
      const supabase = createClient();

      // 過去14日間の完了推移
      const since = new Date();
      since.setDate(since.getDate() - 13);
      const sinceStr = since.toISOString().split('T')[0];

      const { data: completedRows } = await supabase
        .from('planned_meals')
        .select('completed_at')
        .eq('is_completed', true)
        .gte('completed_at', sinceStr)
        .not('completed_at', 'is', null);

      // 日別集計
      const dailyMap = new Map<string, number>();
      for (let i = 0; i < 14; i++) {
        const d = new Date();
        d.setDate(d.getDate() - (13 - i));
        dailyMap.set(d.toISOString().split('T')[0], 0);
      }
      (completedRows || []).forEach((row) => {
        if (!row.completed_at) return;
        const day = (row.completed_at as string).slice(0, 10);
        if (dailyMap.has(day)) {
          dailyMap.set(day, (dailyMap.get(day) ?? 0) + 1);
        }
      });
      const trend: DailyCompletion[] = Array.from(dailyMap.entries()).map(([date, completed]) => ({
        date: date.slice(5), // MM-DD 形式で表示
        completed,
      }));
      setCompletionTrend(trend);

      // 食事モード分布
      const { data: modeRows } = await supabase
        .from('planned_meals')
        .select('mode');

      const modeMap = new Map<string, number>();
      (modeRows || []).forEach((row) => {
        const mode = row.mode || 'unknown';
        modeMap.set(mode, (modeMap.get(mode) ?? 0) + 1);
      });
      const dist: ModeDistribution[] = Array.from(modeMap.entries())
        .filter(([name]) => name !== 'unknown')
        .map(([name, value]) => ({ name: MODE_LABELS[name] ?? name, value }))
        .sort((a, b) => b.value - a.value);
      setModeDistribution(dist);
    };

    void fetchStats();
    void fetchChartData();
  }, []);

  const PIE_COLORS = ['#22c55e', '#3b82f6', '#a855f7', '#f97316'];

  return (
    <div className="space-y-8">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">ユーザー数</p>
          <p className="text-2xl font-black text-gray-900 mt-1">{stats.totalUsers.toLocaleString()}</p>
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">総献立数</p>
          <p className="text-2xl font-black text-gray-900 mt-1">{stats.totalPlannedMeals.toLocaleString()}</p>
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">完了済み</p>
          <p className="text-2xl font-black text-green-600 mt-1">{stats.completedMeals.toLocaleString()}</p>
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">今日の完了</p>
          <p className="text-2xl font-black text-[#E07A5F] mt-1">{stats.todayMeals.toLocaleString()}</p>
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">自炊率</p>
          <p className="text-2xl font-black text-blue-600 mt-1">{stats.cookRate}%</p>
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">要確認フラグ</p>
          <p className="text-2xl font-black text-red-500 mt-1">{stats.pendingFlags}</p>
        </div>
      </div>

      {/* Charts Area */}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* 献立完了推移グラフ */}
        <div className="lg:col-span-2 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <h2 className="text-base font-bold text-gray-900 mb-4">献立完了推移（過去14日間）</h2>
          {completionTrend.length > 0 ? (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={completionTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: '#9ca3af', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fill: '#9ca3af', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#fff',
                      border: '1px solid #e5e7eb',
                      borderRadius: '8px',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                    }}
                    formatter={(value: number | undefined) => [value ?? 0, '完了数']}
                  />
                  <Line
                    type="monotone"
                    dataKey="completed"
                    stroke="#E07A5F"
                    strokeWidth={2.5}
                    dot={{ fill: '#E07A5F', r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-64 flex items-center justify-center text-gray-300 text-sm">
              データがありません
            </div>
          )}
        </div>

        {/* 食事モード比率 */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <h2 className="text-base font-bold text-gray-900 mb-4">食事モード比率</h2>
          {modeDistribution.length > 0 ? (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={modeDistribution as unknown as Record<string, unknown>[]}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="45%"
                    outerRadius={80}
                    label={({ name, percent }) =>
                      `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
                    }
                    labelLine={{ stroke: '#d1d5db' }}
                  >
                    {modeDistribution.map((_, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={PIE_COLORS[index % PIE_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#fff',
                      border: '1px solid #e5e7eb',
                      borderRadius: '8px',
                    }}
                    formatter={(value: number | undefined) => [(value ?? 0).toLocaleString(), '件']}
                  />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-64 flex items-center justify-center text-gray-300 text-sm">
              データがありません
            </div>
          )}
        </div>
      </div>

      {/* Quick Stats */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <h2 className="text-lg font-bold text-gray-900 mb-4">クイック統計</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-4 bg-green-50 rounded-xl">
            <p className="text-xs text-green-600 font-bold">完了率</p>
            <p className="text-xl font-black text-green-700">
              {stats.totalPlannedMeals > 0
                ? Math.round((stats.completedMeals / stats.totalPlannedMeals) * 100)
                : 0}%
            </p>
          </div>
          <div className="p-4 bg-blue-50 rounded-xl">
            <p className="text-xs text-blue-600 font-bold">自炊数</p>
            <p className="text-xl font-black text-blue-700">
              {Math.round(stats.totalPlannedMeals * stats.cookRate / 100)}
            </p>
          </div>
          <div className="p-4 bg-purple-50 rounded-xl">
            <p className="text-xs text-purple-600 font-bold">外食/買う</p>
            <p className="text-xl font-black text-purple-700">
              {stats.totalPlannedMeals - Math.round(stats.totalPlannedMeals * stats.cookRate / 100)}
            </p>
          </div>
          <div className="p-4 bg-orange-50 rounded-xl">
            <p className="text-xs text-orange-600 font-bold">平均/ユーザー</p>
            <p className="text-xl font-black text-orange-700">
              {stats.totalUsers > 0
                ? (stats.totalPlannedMeals / stats.totalUsers).toFixed(1)
                : 0}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
