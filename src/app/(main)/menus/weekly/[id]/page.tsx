"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { toWeeklyMenuRequest } from "@/lib/converters";
import type { WeeklyMenuRequest } from "@/types/domain";

import { Icons } from "@/components/icons";

interface WeeklyMenuPageProps {
  params: { id: string };
}

export default function WeeklyMenuDetailPage({ params }: WeeklyMenuPageProps) {
  const [request, setRequest] = useState<WeeklyMenuRequest | null>(null);
  const [activeTab, setActiveTab] = useState<'menu' | 'shopping' | 'report'>('menu');
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  // ポーリングでステータス監視
  useEffect(() => {
    let intervalId: any;

    const fetchRequest = async () => {
      const { data, error } = await supabase
        .from('weekly_menu_requests')
        .select('*')
        .eq('id', params.id)
        .single();

      if (error) {
        console.error(error);
        return;
      }

      // 型変換を適用
      const domainRequest = toWeeklyMenuRequest(data);
      setRequest(domainRequest);
      setLoading(false);

      if (domainRequest.status === 'completed' || domainRequest.status === 'failed') {
        clearInterval(intervalId);
      }
    };

    fetchRequest();
    intervalId = setInterval(fetchRequest, 3000); // 3秒ごとに更新

    return () => clearInterval(intervalId);
  }, [params.id, supabase]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50">
        <div className="w-16 h-16 border-4 border-[#FF8A65] border-t-transparent rounded-full animate-spin" />
        <p className="mt-4 text-gray-500 font-bold">Loading Plan...</p>
      </div>
    );
  }

  if (!request) return <div>Not Found</div>;

  if (request.status === 'pending') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-8 text-center">
        <div className="w-24 h-24 bg-white rounded-full shadow-xl flex items-center justify-center mb-8 relative">
           <div className="absolute inset-0 border-4 border-orange-100 rounded-full animate-pulse" />
           <span className="text-4xl animate-bounce">👨‍🍳</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">AI Nutritionist is working...</h1>
        <p className="text-gray-500 max-w-xs mx-auto">
          冷蔵庫の中身とあなたの目標を分析し、最適な1週間を設計しています。
          <br/><br/>
          調理時間: {request.status === 'pending' ? '約30-60秒' : '完了'}
        </p>
      </div>
    );
  }

  if (request.status === 'failed') {
    return (
      <div className="p-8 text-center">
        <h1 className="text-xl font-bold text-red-500">Generation Failed</h1>
        <p className="text-gray-500 mt-2">{request.errorMessage}</p>
        <Link href="/menus/weekly/request">
          <Button className="mt-6">Try Again</Button>
        </Link>
      </div>
    );
  }

  const result = request.resultJson;
  const days = result?.days || [];
  const shoppingList = result?.shoppingList || [];
  const impact = result?.projectedImpact || {};

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      
      {/* ヘッダーエリア: 未来予測 (Impact) */}
      <div className="bg-foreground text-white p-6 pt-12 pb-20 rounded-b-[40px] relative overflow-hidden shadow-xl">
        <div className="absolute inset-0 bg-gradient-to-br from-accent to-transparent opacity-20" />
        <div className="absolute -right-10 -top-10 w-64 h-64 bg-white opacity-5 rounded-full blur-3xl" />
        
        <div className="relative z-10">
          <Link href="/home" className="inline-flex items-center gap-2 text-sm text-white/60 hover:text-white mb-6 group">
            <Icons.Back className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
            Home
          </Link>
          
          <div className="flex justify-between items-start mb-6">
            <div>
              <h1 className="text-2xl font-bold">Projected Impact</h1>
              <p className="text-white/60 text-sm">1週間後の予測変化</p>
            </div>
            <div className="text-right">
              <span className="text-4xl font-black text-accent">{impact.weightChange || '-'}</span>
              <p className="text-xs font-bold uppercase tracking-wider text-white/60">Weight</p>
            </div>
          </div>

          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-4 border border-white/10">
            <p className="text-sm leading-relaxed text-white/90">
              &quot;{impact.comment || 'バランスの良い食事がパフォーマンスを向上させます。'}&quot;
            </p>
            <div className="flex gap-4 mt-4">
              {impact.energyLevel && (
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase text-white/40">Energy</span>
                  <span className="font-bold text-sm">{impact.energyLevel}</span>
                </div>
              )}
              {impact.skinCondition && (
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase text-white/40">Skin</span>
                  <span className="font-bold text-sm">{impact.skinCondition}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* タブ切り替え */}
      <div className="px-6 -mt-8 relative z-20">
        <div className="bg-white rounded-2xl shadow-lg p-1.5 flex mb-6">
          {['menu', 'shopping', 'report'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as any)}
              className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all ${
                activeTab === tab 
                  ? 'bg-foreground text-white shadow-md' 
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              {tab === 'menu' ? 'Weekly Menu' : tab === 'shopping' ? 'Shopping' : 'Advice'}
            </button>
          ))}
        </div>
      </div>

      {/* コンテンツ */}
      <div className="px-6 pb-8">
        <AnimatePresence mode="wait">
          
          {/* Menu Tab */}
          {activeTab === 'menu' && (
            <motion.div 
              key="menu"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-4"
            >
              {days.map((day: any, i: number) => (
                <div 
                  key={i} 
                  className={`rounded-3xl p-6 shadow-sm border relative overflow-hidden ${
                    day.isCheatDay ? 'bg-gradient-to-br from-yellow-50 to-orange-50 border-yellow-100' : 'bg-white border-gray-100'
                  }`}
                >
                  {day.isCheatDay && (
                    <div className="absolute top-0 right-0 bg-yellow-400 text-white text-xs font-bold px-3 py-1 rounded-bl-xl">
                      Cheat Day! 🍔
                    </div>
                  )}
                  
                  <div className="flex items-center gap-3 mb-4">
                    <div className={`w-12 h-12 rounded-xl flex flex-col items-center justify-center font-bold shadow-sm ${
                      day.isCheatDay ? 'bg-white text-yellow-600' : 'bg-gray-900 text-white'
                    }`}>
                      <span className="text-xs opacity-60">{day.dayOfWeek?.slice(0,3)}</span>
                      <span className="text-lg leading-none">{new Date(day.date).getDate()}</span>
                    </div>
                    <div>
                       <p className="text-xs text-gray-400 font-bold uppercase">Nutritional Focus</p>
                       <p className="text-sm font-bold text-gray-800 line-clamp-1">{day.nutritionalAdvice}</p>
                    </div>
                  </div>

                  <div className="space-y-3 pl-2">
                    {day.meals.map((meal: any, j: number) => (
                      <div key={j} className="flex gap-4 items-start">
                        <div className="w-16 text-xs font-bold text-gray-400 uppercase pt-1">
                          {meal.mealType}
                        </div>
                        <div className="flex-1">
                          {meal.dishes.map((dish: any, k: number) => (
                            <div key={k} className="mb-1 last:mb-0">
                              <p className="font-bold text-gray-800 text-sm">{dish.name}</p>
                              {dish.role && <p className="text-[10px] text-gray-400">{dish.role}</p>}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </motion.div>
          )}

          {/* Shopping Tab */}
          {activeTab === 'shopping' && (
            <motion.div 
              key="shopping"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-4"
            >
              <div className="bg-blue-50 p-4 rounded-xl flex items-start gap-3 mb-4">
                <span className="text-xl">💡</span>
                <p className="text-sm text-blue-800 font-medium">
                  冷蔵庫の在庫 ({request.constraints?.ingredients?.length || 0}品) を除外済みです。
                  不足分のみリストアップしています。
                </p>
              </div>

              {shoppingList.map((cat: any, i: number) => (
                <div key={i} className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
                  <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2">
                    <span className="w-2 h-6 bg-accent rounded-full" />
                    {cat.category}
                  </h3>
                  <ul className="space-y-3">
                    {cat.items.map((item: string, j: number) => (
                      <li key={j} className="flex items-center justify-between text-sm group">
                        <div className="flex items-center gap-3">
                           <input type="checkbox" className="w-5 h-5 rounded-md border-gray-300 text-accent focus:ring-accent" />
                           <span className="text-gray-700 font-medium">{item}</span>
                        </div>
                        <a 
                          href={`https://www.amazon.co.jp/s?k=${encodeURIComponent(item.split(' ')[0])}&i=food-beverage`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-xs font-bold text-accent bg-orange-50 px-2 py-1 rounded-md"
                        >
                          Amazon
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </motion.div>
          )}

          {/* Report Tab */}
          {activeTab === 'report' && (
            <motion.div 
              key="report"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="bg-white rounded-3xl p-6 shadow-lg border border-gray-100"
            >
              <h3 className="text-lg font-bold mb-4">Coach's Advice</h3>
              <div className="prose prose-sm text-gray-600">
                <p className="whitespace-pre-wrap leading-relaxed">
                  {impact.comment}
                </p>
                <h4 className="font-bold text-gray-900 mt-6 mb-2">今週のポイント</h4>
                <ul className="list-disc pl-4 space-y-1">
                   <li>{days[0]?.nutritionalAdvice}</li>
                   {days[3] && <li>{days[3]?.nutritionalAdvice}</li>}
                   {days[6] && <li>{days[6]?.nutritionalAdvice}</li>}
                </ul>
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </div>
  );
}
