"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toWeeklyMenuRequest } from "@/lib/converter";
import type { WeeklyMenuRequest } from "@/types/domain";

export default function WeeklyMenuPage() {
  const router = useRouter();
  const supabase = createClient();
  const [startDate, setStartDate] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [requests, setRequests] = useState<WeeklyMenuRequest[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  // 過去のリクエスト一覧を取得
  useEffect(() => {
    const fetchRequests = async () => {
      setLoadingHistory(true);
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        const { data, error } = await supabase
          .from('weekly_menu_requests')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(10);

        if (error) {
          console.error('Failed to fetch menu requests:', error);
          return;
        }

        const domainRequests = (data || []).map(toWeeklyMenuRequest);
        setRequests(domainRequests);
      } catch (error) {
        console.error('Error fetching menu requests:', error);
      } finally {
        setLoadingHistory(false);
      }
    };
    fetchRequests();
  }, [supabase]);

  const handleGenerate = async () => {
    if (!startDate) {
      alert("開始日を選択してください");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/ai/menu/weekly/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, note }),
      });

      if (!response.ok) throw new Error("生成リクエストに失敗しました");

      const data = await response.json();
      
      // 詳細画面へ遷移（そこでポーリングなどで完了を待つ）
      router.push(`/menus/weekly/${data.id}`);

    } catch (error: any) {
      alert(error.message || "エラーが発生しました");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      
      {/* ヘッダー */}
      <div className="bg-white p-6 pb-4 border-b border-gray-100 sticky top-0 z-20">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Weekly Plan</h1>
        </div>
      </div>

      {/* メインエリア */}
      <div className="p-6 space-y-8">
        
        {/* 新規生成カード */}
        <Card className="border-none shadow-lg">
          <CardHeader>
            <CardTitle>New Plan</CardTitle>
            <CardDescription>来週の献立をAIに依頼します</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="startDate">開始日</Label>
              <Input
                id="startDate"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="rounded-xl border-gray-200"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="note">要望・状況</Label>
              <textarea
                id="note"
                className="flex min-h-[100px] w-full rounded-xl border border-gray-200 bg-background px-3 py-2 text-sm focus:ring-[#FF8A65]"
                placeholder="例: 週末に試合があります。水曜日は飲み会です。"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <Button
              onClick={handleGenerate}
              className="w-full bg-[#FF8A65] hover:bg-[#FF7043] text-white font-bold rounded-full py-6"
              disabled={loading || !startDate}
            >
              {loading ? "Requesting..." : "Generate Weekly Menu"}
            </Button>
          </CardContent>
        </Card>

        {/* 過去の履歴 */}
        {requests.length > 0 && (
          <div>
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 pl-2">履歴</h2>
            {loadingHistory ? (
              <div className="text-center text-gray-400 py-8">読み込み中...</div>
            ) : (
              <div className="space-y-3">
                {requests.map((req) => {
                  const start = new Date(req.startDate);
                  const end = new Date(start);
                  end.setDate(end.getDate() + 6);
                  const statusLabels: Record<string, string> = {
                    pending: '生成中',
                    processing: '処理中',
                    completed: '完了',
                    failed: '失敗',
                  };
                  const statusColors: Record<string, string> = {
                    pending: 'text-yellow-600',
                    processing: 'text-blue-600',
                    completed: 'text-green-600',
                    failed: 'text-red-600',
                  };
                  
                  return (
                    <Link key={req.id} href={`/menus/weekly/${req.id}`}>
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex justify-between items-center hover:bg-gray-50 transition-colors cursor-pointer"
                      >
                        <div>
                          <p className="font-bold text-gray-900">
                            {start.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })} - {end.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })}
                          </p>
                          <p className={`text-xs font-bold ${statusColors[req.status] || 'text-gray-400'}`}>
                            {statusLabels[req.status] || req.status}
                          </p>
                        </div>
                        <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </motion.div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
