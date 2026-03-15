"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function AdminDashboard() {
  const [stats, setStats] = useState({
    totalUsers: 0,
    totalPlannedMeals: 0,
    completedMeals: 0,
    todayMeals: 0,
    pendingFlags: 0,
    cookRate: 0,
  });
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
        // ユーザー数
        supabase.from('user_profiles').select('*', { count: 'exact', head: true }),
        // 総献立数（planned_meals）
        supabase.from('planned_meals').select('*', { count: 'exact', head: true }),
        // 完了した献立数
        supabase.from('planned_meals').select('*', { count: 'exact', head: true })
          .eq('is_completed', true),
        // 今日完了した献立数
        supabase.from('planned_meals').select('*', { count: 'exact', head: true })
          .eq('is_completed', true)
          .gte('completed_at', today),
        // モデレーションフラグ
        supabase.from('moderation_flags').select('*', { count: 'exact', head: true })
          .eq('status', 'pending'),
        // 自炊の数
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
    void fetchStats();
  }, []);

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

      {/* Charts Area (Placeholder) */}
      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white p-6 rounded-2xl shadow-sm border border-gray-100 h-80 flex flex-col justify-center items-center text-gray-400">
          <span className="text-4xl mb-2">📈</span>
          <span>献立完了推移グラフ（Coming Soon）</span>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 h-80 flex flex-col justify-center items-center text-gray-400">
          <span className="text-4xl mb-2">🥧</span>
          <span>食事モード比率（Coming Soon）</span>
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
