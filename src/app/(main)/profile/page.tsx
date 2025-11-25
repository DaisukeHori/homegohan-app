"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { motion, AnimatePresence } from "framer-motion";
import { toUserProfile } from "@/lib/converter";
import type { UserProfile } from "@/types/domain";
import { Icons } from "@/components/icons";

export default function ProfilePage() {
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [badgeCount, setBadgeCount] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({ nickname: "", goalText: "" });
  
  const supabase = createClient();

  useEffect(() => {
    const getData = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);
      
      if (user) {
        const { data } = await supabase.from('user_profiles').select('*').eq('id', user.id).single();
        if (data) {
          const domainProfile = toUserProfile(data);
          setProfile(domainProfile);
          setEditForm({ nickname: domainProfile.nickname || "", goalText: domainProfile.goalText || "" });
        }

        // バッジ獲得数取得
        try {
          const badgeRes = await fetch('/api/badges');
          if (badgeRes.ok) {
            const badgeData = await badgeRes.json();
            const earned = badgeData.badges.filter((b: any) => b.earned).length;
            setBadgeCount(earned);
          }
        } catch (e) {
          console.error("Badge fetch error", e);
        }
      }
    };
    getData();
  }, []);

  const handleSave = async () => {
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nickname: editForm.nickname,
          goal_text: editForm.goalText,
        }),
      });
      
      if (!res.ok) throw new Error('Failed to update');
      
      const updatedData = await res.json();
      setProfile(toUserProfile(updatedData));
      setIsEditing(false);
    } catch (error) {
      alert('更新に失敗しました');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      
      {/* ヘッダーエリア */}
      <div className="relative h-64 bg-foreground overflow-hidden">
        <div className="absolute inset-0 bg-accent opacity-20 transform -skew-y-6 scale-125 origin-top-left" />
        <div className="absolute top-0 right-0 p-6 z-10">
          <Button 
            variant="ghost" 
            className="text-white hover:bg-white/20"
            onClick={() => setIsEditing(true)}
          >
            <Icons.Edit className="w-6 h-6" />
          </Button>
        </div>
      </div>

      <div className="px-6 -mt-20 relative z-10">
        
        {/* メインIDカード */}
        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="bg-white rounded-3xl p-6 shadow-xl relative overflow-hidden mb-8"
        >
          {/* 背景パターン */}
          <div className="absolute top-0 right-0 w-32 h-32 bg-orange-50 rounded-bl-[100px] -z-0 opacity-50" />
          
          <div className="flex flex-col items-center relative z-10">
            <div className="w-24 h-24 rounded-full p-1 bg-gradient-to-tr from-accent to-accent-soft mb-4">
               <div className="w-full h-full rounded-full bg-white border-4 border-white overflow-hidden flex items-center justify-center text-3xl font-bold text-gray-400">
                 {profile?.nickname?.[0] || user?.email?.[0]?.toUpperCase() || 'U'}
               </div>
            </div>
            
            <h1 className="text-2xl font-bold text-gray-900 mb-1">{profile?.nickname || user?.email?.split('@')[0]}</h1>
            <p className="text-sm text-gray-400 mb-6">{profile?.goalText || "No goal set"}</p>
            
            <div className="flex gap-8 w-full justify-center border-t border-gray-100 pt-6">
              <div className="text-center">
                 <p className="text-2xl font-bold text-gray-900">{badgeCount}</p>
                 <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">Badges</p>
              </div>
              <div className="text-center">
                 <p className="text-2xl font-bold text-gray-900">{badgeCount * 100}</p>
                 <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">Points</p>
              </div>
              <div className="text-center">
                 <p className="text-2xl font-bold text-gray-900">{Math.floor(badgeCount / 5) + 1}</p>
                 <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">Level</p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* ステータス・設定項目 */}
        <div className="space-y-4">
          <h2 className="font-bold text-gray-900 px-2">Account</h2>
          
          <div className="bg-white rounded-2xl overflow-hidden shadow-sm border border-gray-100">
            {[
              { label: 'Personal Data', icon: <Icons.User className="w-5 h-5" />, desc: `${profile?.ageGroup || '-'} / ${profile?.gender || '-'}` },
              { label: 'Dietary Goal', icon: <Icons.Target className="w-5 h-5" />, desc: profile?.goalText || 'Set your goal' },
              { label: 'Allergies', icon: <Icons.Alert className="w-5 h-5" />, desc: profile?.dietFlags?.allergies?.join(', ') || 'None' },
            ].map((item, i) => (
              <button key={i} className="w-full flex items-center gap-4 p-4 hover:bg-gray-50 transition-colors border-b border-gray-100 last:border-0 text-left">
                <div className="w-10 h-10 rounded-full bg-gray-50 flex items-center justify-center text-gray-600">
                  {item.icon}
                </div>
                <div className="flex-1">
                  <p className="font-bold text-gray-900 text-sm">{item.label}</p>
                  <p className="text-xs text-gray-400 truncate">{item.desc}</p>
                </div>
                <div className="text-gray-300">
                  <Icons.ChevronRight className="w-5 h-5" />
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 編集モーダル */}
      <AnimatePresence>
        {isEditing && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4 sm:p-6"
          >
            <motion.div 
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              className="bg-white w-full max-w-md rounded-3xl p-6 space-y-6"
            >
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-bold text-gray-900">Edit Profile</h2>
                <button onClick={() => setIsEditing(false)} className="p-2 bg-gray-100 rounded-full hover:bg-gray-200">
                  <Icons.Close className="w-5 h-5 text-gray-500" />
                </button>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="nickname">Nickname</Label>
                  <Input 
                    id="nickname" 
                    value={editForm.nickname} 
                    onChange={(e) => setEditForm({...editForm, nickname: e.target.value})}
                    className="rounded-xl border-gray-200 focus:ring-accent"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="goal">Goal</Label>
                  <Input 
                    id="goal" 
                    value={editForm.goalText} 
                    onChange={(e) => setEditForm({...editForm, goalText: e.target.value})}
                    className="rounded-xl border-gray-200 focus:ring-accent"
                  />
                </div>
              </div>

              <Button 
                onClick={handleSave}
                className="w-full py-6 rounded-full bg-foreground hover:bg-black text-white font-bold"
              >
                Save Changes
              </Button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
