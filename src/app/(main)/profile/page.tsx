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
  const [editForm, setEditForm] = useState({ 
    nickname: "", 
    age: "",
    occupation: "",
    height: "",
    weight: "",
    gender: "",
    goalText: "" 
  });
  
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
          setEditForm({ 
            nickname: domainProfile.nickname || "", 
            age: domainProfile.age?.toString() || "",
            occupation: domainProfile.occupation || "",
            height: domainProfile.height?.toString() || "",
            weight: domainProfile.weight?.toString() || "",
            gender: domainProfile.gender || "",
            goalText: domainProfile.goalText || "" 
          });
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
          age: editForm.age ? parseInt(editForm.age) : null,
          occupation: editForm.occupation || null,
          height: editForm.height ? parseFloat(editForm.height) : null,
          weight: editForm.weight ? parseFloat(editForm.weight) : null,
          gender: editForm.gender || 'unspecified',
          goalText: editForm.goalText || null,
        }),
      });
      
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to update');
      }
      
      const updatedData = await res.json();
      const domainProfile = toUserProfile(updatedData);
      setProfile(domainProfile);
      setIsEditing(false);
      // ページをリロードして最新データを取得
      window.location.reload();
    } catch (error: any) {
      console.error('Update error:', error);
      alert(`更新に失敗しました: ${error.message}`);
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
            <p className="text-sm text-gray-400 mb-2">{profile?.goalText || "No goal set"}</p>
            {(profile?.age || profile?.occupation || profile?.height || profile?.weight) && (
              <div className="text-xs text-gray-500 mb-6 space-y-1">
                {profile.age && <p>{profile.age}歳</p>}
                {profile.occupation && <p>{profile.occupation}</p>}
                {(profile.height || profile.weight) && (
                  <p>{profile.height ? `${profile.height}cm` : ''} {profile.weight ? `${profile.weight}kg` : ''}</p>
                )}
              </div>
            )}
            {!(profile?.age || profile?.occupation || profile?.height || profile?.weight) && <div className="mb-6" />}
            
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
              { 
                label: 'Personal Data', 
                icon: <Icons.User className="w-5 h-5" />, 
                desc: profile?.age 
                  ? `${profile.age}歳 / ${profile.gender === 'male' ? '男性' : profile.gender === 'female' ? '女性' : profile.gender || '-'}${profile.occupation ? ` / ${profile.occupation}` : ''}${profile.height && profile.weight ? ` / ${profile.height}cm ${profile.weight}kg` : ''}`
                  : `${profile?.ageGroup || '-'} / ${profile?.gender === 'male' ? '男性' : profile?.gender === 'female' ? '女性' : profile?.gender || '-'}` 
              },
              { label: 'Dietary Goal', icon: <Icons.Target className="w-5 h-5" />, desc: profile?.goalText || 'Set your goal' },
              { label: 'Allergies', icon: <Icons.Alert className="w-5 h-5" />, desc: profile?.dietFlags?.allergies?.join(', ') || 'None' },
            ].map((item, i) => (
              <button 
                key={i} 
                onClick={() => setIsEditing(true)}
                className="w-full flex items-center gap-4 p-4 hover:bg-gray-50 transition-colors border-b border-gray-100 last:border-0 text-left"
              >
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
                <h2 className="text-xl font-bold text-gray-900">プロフィール編集</h2>
                <button onClick={() => setIsEditing(false)} className="p-2 bg-gray-100 rounded-full hover:bg-gray-200">
                  <Icons.Close className="w-5 h-5 text-gray-500" />
                </button>
              </div>

              <div className="space-y-4 max-h-[60vh] overflow-y-auto">
                <div className="space-y-2">
                  <Label htmlFor="nickname">ニックネーム</Label>
                  <Input 
                    id="nickname" 
                    value={editForm.nickname} 
                    onChange={(e) => setEditForm({...editForm, nickname: e.target.value})}
                    className="rounded-xl border-gray-200 focus:ring-accent"
                    placeholder="例: たろう"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="age">年齢</Label>
                    <Input 
                      id="age" 
                      type="number"
                      value={editForm.age} 
                      onChange={(e) => setEditForm({...editForm, age: e.target.value})}
                      className="rounded-xl border-gray-200 focus:ring-accent"
                      placeholder="例: 30"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="gender">性別</Label>
                    <select
                      id="gender"
                      value={editForm.gender}
                      onChange={(e) => setEditForm({...editForm, gender: e.target.value})}
                      className="w-full px-3 py-2 rounded-xl border border-gray-200 focus:ring-accent focus:ring-2 focus:border-accent"
                    >
                      <option value="unspecified">選択しない</option>
                      <option value="male">男性</option>
                      <option value="female">女性</option>
                      <option value="other">その他</option>
                    </select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="occupation">職業</Label>
                  <Input 
                    id="occupation" 
                    value={editForm.occupation} 
                    onChange={(e) => setEditForm({...editForm, occupation: e.target.value})}
                    className="rounded-xl border-gray-200 focus:ring-accent"
                    placeholder="例: 会社員"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="height">身長 (cm)</Label>
                    <Input 
                      id="height" 
                      type="number"
                      value={editForm.height} 
                      onChange={(e) => setEditForm({...editForm, height: e.target.value})}
                      className="rounded-xl border-gray-200 focus:ring-accent"
                      placeholder="例: 170"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="weight">体重 (kg)</Label>
                    <Input 
                      id="weight" 
                      type="number"
                      value={editForm.weight} 
                      onChange={(e) => setEditForm({...editForm, weight: e.target.value})}
                      className="rounded-xl border-gray-200 focus:ring-accent"
                      placeholder="例: 65"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="goal">目標</Label>
                  <Input 
                    id="goal" 
                    value={editForm.goalText} 
                    onChange={(e) => setEditForm({...editForm, goalText: e.target.value})}
                    className="rounded-xl border-gray-200 focus:ring-accent"
                    placeholder="例: 健康的な体型の維持"
                  />
                </div>
              </div>

              <Button 
                onClick={handleSave}
                className="w-full py-6 rounded-full bg-foreground hover:bg-black text-white font-bold"
              >
                変更を保存
              </Button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
