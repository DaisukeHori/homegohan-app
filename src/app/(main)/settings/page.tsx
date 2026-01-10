"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

type WeekStartDay = 'sunday' | 'monday';

// スイッチコンポーネント
const Switch = ({ checked, onChange }: { checked: boolean; onChange: () => void }) => (
  <button
    onClick={onChange}
    className={`w-12 h-7 rounded-full p-1 transition-colors duration-300 ${checked ? 'bg-[#FF8A65]' : 'bg-gray-200'}`}
  >
    <motion.div
      layout
      className="w-5 h-5 bg-white rounded-full shadow-sm"
      animate={{ x: checked ? 20 : 0 }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
    />
  </button>
);

export default function SettingsPage() {
  const router = useRouter();
  const supabase = createClient();
  const [showLogoutModal, setShowLogoutModal] = useState(false);

  const [settings, setSettings] = useState({
    notifications: true,
    dataShare: true,
    autoAnalyze: true
  });

  const [weekStartDay, setWeekStartDay] = useState<WeekStartDay>('monday');
  const [savingWeekStart, setSavingWeekStart] = useState(false);

  // Fetch current week start day setting
  useEffect(() => {
    const fetchSettings = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('week_start_day')
        .eq('id', user.id)
        .single();
      if (profile?.week_start_day) {
        setWeekStartDay(profile.week_start_day as WeekStartDay);
      }
    };
    fetchSettings();
  }, [supabase]);

  const handleWeekStartDayChange = async (newValue: WeekStartDay) => {
    setWeekStartDay(newValue);
    setSavingWeekStart(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase
        .from('user_profiles')
        .update({ week_start_day: newValue })
        .eq('id', user.id);
    } catch (error) {
      console.error('Failed to save week start day:', error);
    } finally {
      setSavingWeekStart(false);
    }
  };

  const toggle = (key: keyof typeof settings) => {
    setSettings(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-24 relative">
      
      <div className="bg-white p-6 pb-4 border-b border-gray-100 sticky top-0 z-20">
        <h1 className="text-2xl font-bold text-gray-900">設定</h1>
      </div>

      <div className="p-6 space-y-8">
        
        {/* セクション 1: 一般設定 */}
        <div>
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 pl-2">一般</h2>
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
             
             <div className="flex items-center justify-between p-4 border-b border-gray-50">
               <div className="flex items-center gap-3">
                 <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-blue-500">🔔</div>
                 <span className="font-bold text-gray-700">通知</span>
               </div>
               <Switch checked={settings.notifications} onChange={() => toggle('notifications')} />
             </div>

             <div className="flex items-center justify-between p-4 border-b border-gray-50">
               <div className="flex items-center gap-3">
                 <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center text-purple-500">🤖</div>
                 <span className="font-bold text-gray-700">自動解析</span>
               </div>
               <Switch checked={settings.autoAnalyze} onChange={() => toggle('autoAnalyze')} />
             </div>

             <div className="flex items-center justify-between p-4">
               <div className="flex items-center gap-3">
                 <div className="w-8 h-8 rounded-lg bg-teal-50 flex items-center justify-center text-teal-500">📅</div>
                 <div>
                   <span className="font-bold text-gray-700">週の開始日</span>
                   <p className="text-xs text-gray-400">カレンダーの開始曜日</p>
                 </div>
               </div>
               <div className="flex gap-1">
                 <button
                   onClick={() => handleWeekStartDayChange('sunday')}
                   disabled={savingWeekStart}
                   className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                     weekStartDay === 'sunday'
                       ? 'bg-[#FF8A65] text-white'
                       : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                   }`}
                 >
                   日曜
                 </button>
                 <button
                   onClick={() => handleWeekStartDayChange('monday')}
                   disabled={savingWeekStart}
                   className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                     weekStartDay === 'monday'
                       ? 'bg-[#FF8A65] text-white'
                       : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                   }`}
                 >
                   月曜
                 </button>
               </div>
             </div>

          </div>
        </div>

        {/* セクション 2: 個人情報 */}
        <div>
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 pl-2">個人情報</h2>
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">

             <button
               onClick={() => router.push('/profile')}
               className="w-full flex items-center justify-between p-4 border-b border-gray-50 hover:bg-gray-50 transition-colors"
             >
               <div className="flex items-center gap-3">
                 <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-blue-500">👤</div>
                 <div className="text-left">
                   <span className="font-bold text-gray-700">プロフィール</span>
                   <p className="text-xs text-gray-400">名前、年齢、身長・体重など</p>
                 </div>
               </div>
               <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
             </button>

             <button
               onClick={() => router.push('/health/checkups')}
               className="w-full flex items-center justify-between p-4 hover:bg-gray-50 transition-colors"
             >
               <div className="flex items-center gap-3">
                 <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center text-red-500">🩺</div>
                 <div className="text-left">
                   <span className="font-bold text-gray-700">健康診断</span>
                   <p className="text-xs text-gray-400">検査結果の記録・分析</p>
                 </div>
               </div>
               <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
             </button>

          </div>
        </div>

        {/* セクション 3: データ・プライバシー */}
        <div>
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 pl-2">データとプライバシー</h2>
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
             
             <button className="w-full flex items-center justify-between p-4 border-b border-gray-50 hover:bg-gray-50 transition-colors">
               <div className="flex items-center gap-3">
                 <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center text-green-500">☁️</div>
                 <div className="text-left">
                   <span className="font-bold text-gray-700">データをエクスポート</span>
                   <p className="text-xs text-gray-400">CSV, JSON, PDF形式で出力</p>
                 </div>
               </div>
               <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
             </button>

             <div className="flex items-center justify-between p-4">
               <div className="flex items-center gap-3">
                 <div className="w-8 h-8 rounded-lg bg-orange-50 flex items-center justify-center text-orange-500">📊</div>
                 <div>
                   <span className="font-bold text-gray-700">トレーナーと共有</span>
                   <p className="text-xs text-gray-400">栄養士やジムと連携</p>
                 </div>
               </div>
               <Switch checked={settings.dataShare} onChange={() => toggle('dataShare')} />
             </div>

          </div>
        </div>

        {/* セクション 4: サポート・法的情報 */}
        <div>
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 pl-2">サポートと法的情報</h2>
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
             
             <button 
               onClick={() => router.push('/terms')}
               className="w-full flex items-center justify-between p-4 border-b border-gray-50 hover:bg-gray-50 transition-colors"
             >
               <div className="flex items-center gap-3">
                 <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center text-gray-500">📄</div>
                 <span className="font-bold text-gray-700">利用規約</span>
               </div>
               <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
             </button>

             <button 
               onClick={() => router.push('/privacy')}
               className="w-full flex items-center justify-between p-4 border-b border-gray-50 hover:bg-gray-50 transition-colors"
             >
               <div className="flex items-center gap-3">
                 <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center text-gray-500">🔒</div>
                 <span className="font-bold text-gray-700">プライバシーポリシー</span>
               </div>
               <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
             </button>

             <a 
               href="mailto:support@homegohan.example.com"
               className="w-full flex items-center justify-between p-4 hover:bg-gray-50 transition-colors"
             >
               <div className="flex items-center gap-3">
                 <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center text-gray-500">✉️</div>
                 <span className="font-bold text-gray-700">お問い合わせ</span>
               </div>
               <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
             </a>

          </div>
        </div>

        {/* セクション 5: アクション */}
        <div>
          <Button 
            variant="outline" 
            onClick={() => setShowLogoutModal(true)}
            className="w-full py-6 rounded-2xl border-red-100 text-red-500 hover:bg-red-50 hover:border-red-200 font-bold mb-4"
          >
            ログアウト
          </Button>
          <p className="text-center text-xs text-gray-400">
            Version 1.0.0 (Build 20250125)<br/>
            © 2025 ほめゴハン
          </p>
        </div>

      </div>

      {/* ログアウト確認モーダル */}
      <AnimatePresence>
        {showLogoutModal && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-white rounded-3xl p-8 w-full max-w-sm text-center shadow-2xl"
            >
              <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-6 text-3xl">
                👋
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">ログアウトしますか？</h3>
              <p className="text-gray-500 mb-8 text-sm">
                ログアウトしてもデータは保持されます。<br/>
                またすぐにお会いしましょう。
              </p>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={handleLogout}
                  className="w-full py-3 rounded-full bg-[#333] text-white font-bold hover:bg-black transition-colors shadow-lg"
                >
                  ログアウト
                </button>
                <button 
                  onClick={() => setShowLogoutModal(false)}
                  className="w-full py-3 rounded-full font-bold text-gray-500 hover:bg-gray-100 transition-colors"
                >
                  キャンセル
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
