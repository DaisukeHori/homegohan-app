"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function AdminDashboard() {
  const [stats, setStats] = useState({
    totalUsers: 0,
    totalMeals: 0,
    todayMeals: 0,
    pendingFlags: 0
  });
  const supabase = createClient();

  useEffect(() => {
    const fetchStats = async () => {
      // 並列でカウント取得
      const [
        { count: users },
        { count: meals },
        { count: today },
        { count: flags }
      ] = await Promise.all([
        supabase.from('user_profiles').select('*', { count: 'exact', head: true }),
        supabase.from('meals').select('*', { count: 'exact', head: true }),
        supabase.from('meals').select('*', { count: 'exact', head: true })
          .gte('created_at', new Date().toISOString().split('T')[0]),
        supabase.from('moderation_flags').select('*', { count: 'exact', head: true }).eq('status', 'pending')
      ]);

      setStats({
        totalUsers: users || 0,
        totalMeals: meals || 0,
        todayMeals: today || 0,
        pendingFlags: flags || 0
      });
    };
    fetchStats();
  }, []);

  return (
    <div className="space-y-8">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <p className="text-sm text-gray-500 font-bold uppercase tracking-wider">Total Users</p>
          <p className="text-3xl font-black text-gray-900 mt-2">{stats.totalUsers.toLocaleString()}</p>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <p className="text-sm text-gray-500 font-bold uppercase tracking-wider">Total Meals</p>
          <p className="text-3xl font-black text-gray-900 mt-2">{stats.totalMeals.toLocaleString()}</p>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <p className="text-sm text-gray-500 font-bold uppercase tracking-wider">Today's Post</p>
          <p className="text-3xl font-black text-[#FF8A65] mt-2">{stats.todayMeals.toLocaleString()}</p>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <p className="text-sm text-gray-500 font-bold uppercase tracking-wider">Pending Flags</p>
          <p className="text-3xl font-black text-red-500 mt-2">{stats.pendingFlags}</p>
        </div>
      </div>

      {/* Charts Area (Placeholder) */}
      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white p-6 rounded-2xl shadow-sm border border-gray-100 h-96 flex flex-col justify-center items-center text-gray-400">
          <span>Growth Chart (Coming Soon)</span>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 h-96 flex flex-col justify-center items-center text-gray-400">
          <span>Activity Ratio</span>
        </div>
      </div>
    </div>
  );
}

