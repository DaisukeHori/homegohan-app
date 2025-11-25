"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function WeeklyMenuPage() {
  const router = useRouter();
  const [startDate, setStartDate] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [requests, setRequests] = useState<any[]>([]);

  // 過去のリクエスト一覧を取得（簡易実装）
  /*
  useEffect(() => {
    const fetchRequests = async () => {
      // TODO: 一覧取得APIの実装
    };
    fetchRequests();
  }, []);
  */

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
      router.push(`/menus/weekly/${data.requestId}`);

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

        {/* 過去の履歴（ダミー） */}
        <div>
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 pl-2">History</h2>
          <div className="space-y-3">
            <Link href="/menus/weekly/dummy-1">
              <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex justify-between items-center hover:bg-gray-50 transition-colors">
                <div>
                  <p className="font-bold text-gray-900">Jan 20 - Jan 26</p>
                  <p className="text-xs text-gray-400">Completed</p>
                </div>
                <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
              </div>
            </Link>
          </div>
        </div>

      </div>
    </div>
  );
}
