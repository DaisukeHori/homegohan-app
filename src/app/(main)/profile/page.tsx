"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { motion, AnimatePresence } from "framer-motion";
import { clearUserScopedLocalStorage } from "@/lib/user-storage";
import { toUserProfile } from "@/lib/converter";
import type { UserProfile, FitnessGoal, WorkStyle, CookingExperience, DietStyle } from "@/types/domain";
import { Icons } from "@/components/icons";
import { calculateDailyCalories, calculateNutritionTarget } from "@/lib/nutrition-calculator";
import { ChevronRight, ChevronLeft, Check, Sparkles } from "lucide-react";

type TabType = 'basic' | 'goals' | 'sports' | 'health' | 'diet' | 'cooking' | 'lifestyle';

const TABS: { id: TabType; label: string; icon: string }[] = [
  { id: 'basic', label: '基本', icon: '👤' },
  { id: 'goals', label: '目標', icon: '🎯' },
  { id: 'sports', label: '競技', icon: '🏆' },
  { id: 'health', label: '健康', icon: '❤️' },
  { id: 'diet', label: '食事', icon: '🍽️' },
  { id: 'cooking', label: '調理', icon: '👨‍🍳' },
  { id: 'lifestyle', label: '生活', icon: '🏠' },
];

// Performance OS v3: スポーツ/競技関連オプション
const SPORT_OPTIONS = [
  { value: 'soccer', label: 'サッカー', icon: '⚽' },
  { value: 'basketball', label: 'バスケットボール', icon: '🏀' },
  { value: 'volleyball', label: 'バレーボール', icon: '🏐' },
  { value: 'baseball', label: '野球', icon: '⚾' },
  { value: 'tennis', label: 'テニス', icon: '🎾' },
  { value: 'swimming', label: '水泳', icon: '🏊' },
  { value: 'track_and_field', label: '陸上競技', icon: '🏃' },
  { value: 'road_cycling', label: '自転車', icon: '🚴' },
  { value: 'martial_arts_general', label: '格闘技', icon: '🥊' },
  { value: 'weightlifting', label: 'ウェイトリフティング', icon: '🏋️' },
  { value: 'custom', label: 'その他', icon: '🎯' },
  { value: 'none', label: '特になし', icon: '❌' },
];

const EXPERIENCE_OPTIONS = [
  { value: 'beginner', label: '初心者（1年未満）', icon: '🔰' },
  { value: 'intermediate', label: '中級者（1〜3年）', icon: '📈' },
  { value: 'advanced', label: '上級者（3年以上）', icon: '🏆' },
];

const PHASE_OPTIONS = [
  { value: 'training', label: 'トレーニング期', icon: '🏋️', desc: '体力・技術向上中' },
  { value: 'competition', label: '試合期', icon: '🏆', desc: '大会・試合シーズン' },
  { value: 'cut', label: '減量期', icon: '⚖️', desc: '体重調整中' },
  { value: 'recovery', label: '回復期', icon: '🛌', desc: 'オフシーズン' },
];

const FITNESS_GOALS: { value: FitnessGoal; label: string; icon: string }[] = [
  { value: 'lose_weight', label: '減量', icon: '🏃' },
  { value: 'build_muscle', label: '筋肉増加', icon: '💪' },
  { value: 'improve_energy', label: 'エネルギーUP', icon: '⚡' },
  { value: 'improve_skin', label: '美肌', icon: '✨' },
  { value: 'gut_health', label: '腸活', icon: '🌿' },
  { value: 'immunity', label: '免疫力', icon: '🛡️' },
  { value: 'focus', label: '集中力', icon: '🧠' },
  { value: 'gain_weight', label: '増量', icon: '📈' },
];

const HEALTH_CONDITIONS = [
  '高血圧', '糖尿病', '脂質異常症', '貧血', '痛風', '骨粗しょう症', '睡眠障害', 'ストレス'
];

const KITCHEN_APPLIANCES = [
  '電子レンジ', 'オーブン', 'トースター', '炊飯器', '圧力鍋', 'フードプロセッサー', 
  'ミキサー', 'ホットクック', '低温調理器', 'グリル'
];

// 未入力タブを判定する関数
function getIncompleteTabs(profile: UserProfile | null): TabType[] {
  if (!profile) return ['basic', 'goals', 'health'];

  const incomplete: TabType[] = [];

  // 基本情報: 身長・体重・年齢のいずれかが未入力
  if (!profile.height || !profile.weight || !profile.age) {
    incomplete.push('basic');
  }

  // 目標: fitnessGoalsが未設定
  if (!profile.fitnessGoals || profile.fitnessGoals.length === 0) {
    incomplete.push('goals');
  }

  // 健康状態: healthConditionsが未設定（任意だが推奨）
  // ここは任意とする - コメントアウト
  // if (!profile.healthConditions || profile.healthConditions.length === 0) {
  //   incomplete.push('health');
  // }

  return incomplete;
}

function ProfilePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [badgeCount, setBadgeCount] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('basic');
  const [isSaving, setIsSaving] = useState(false);
  const [editForm, setEditForm] = useState<Partial<UserProfile>>({});
  const [isLoading, setIsLoading] = useState(true);

  // 未入力項目ガイドモード
  const [isGuidedMode, setIsGuidedMode] = useState(false);
  const [guidedTabs, setGuidedTabs] = useState<TabType[]>([]);
  const [guidedStepIndex, setGuidedStepIndex] = useState(0);

  useEffect(() => {
    const getData = async () => {
      const supabase = createClient();
      setIsLoading(true);

      const { data: { user }, error: authError } = await supabase.auth.getUser();
      console.log('[Profile] Auth user:', user?.id, 'error:', authError?.message);
      setUser(user);

      if (user) {
        const { data, error } = await supabase
          .from('user_profiles')
          .select('*')
          .eq('id', user.id)
          .single();

        console.log('[Profile] Fetch result:', {
          hasData: !!data,
          error: error?.message,
          dataKeys: data ? Object.keys(data).length : 0
        });

        if (error) {
          console.error('[Profile] Error fetching profile:', error);
        }

        if (data) {
          console.log('[Profile] Raw data sample:', {
            age: data.age,
            height: data.height,
            weight: data.weight,
            nickname: data.nickname
          });
          const domainProfile = toUserProfile(data);
          console.log('[Profile] Converted profile:', {
            age: domainProfile.age,
            height: domainProfile.height,
            weight: domainProfile.weight,
            nickname: domainProfile.nickname
          });
          setProfile(domainProfile);
          setEditForm(domainProfile);
        }

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

      setIsLoading(false);
    };
    void getData();
  }, []);

  // ?focus=incomplete パラメータを処理
  useEffect(() => {
    const focusParam = searchParams.get('focus');
    if (focusParam === 'incomplete' && profile) {
      const incompleteTabs = getIncompleteTabs(profile);
      if (incompleteTabs.length > 0) {
        setGuidedTabs(incompleteTabs);
        setGuidedStepIndex(0);
        setActiveTab(incompleteTabs[0]);
        setIsGuidedMode(true);
        setIsEditing(true);
      }
      // URLからパラメータを削除（履歴を置換）
      router.replace('/profile', { scroll: false });
    }
  }, [searchParams, profile, router]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to update');
      }

      const updatedData = await res.json();
      const domainProfile = toUserProfile(updatedData);
      setProfile(domainProfile);
      setEditForm(domainProfile);

      // ガイドモードの場合は次のステップへ
      if (isGuidedMode) {
        if (guidedStepIndex < guidedTabs.length - 1) {
          // 次のステップへ
          const nextIndex = guidedStepIndex + 1;
          setGuidedStepIndex(nextIndex);
          setActiveTab(guidedTabs[nextIndex]);
        } else {
          // 全ステップ完了
          setIsGuidedMode(false);
          setIsEditing(false);
        }
      } else {
        setIsEditing(false);
      }
    } catch (error: any) {
      console.error('Update error:', error);
      alert(`更新に失敗しました: ${error.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  // ガイドモード: 前のステップへ
  const handleGuidedPrev = () => {
    if (guidedStepIndex > 0) {
      const prevIndex = guidedStepIndex - 1;
      setGuidedStepIndex(prevIndex);
      setActiveTab(guidedTabs[prevIndex]);
    }
  };

  // ガイドモード: 閉じる（スキップ）
  const handleGuidedClose = () => {
    setIsGuidedMode(false);
    setIsEditing(false);
  };

  const updateField = (field: keyof UserProfile, value: any) => {
    setEditForm(prev => ({ ...prev, [field]: value }));
  };

  const toggleArrayItem = (field: keyof UserProfile, value: string) => {
    const current = (editForm[field] as string[]) || [];
    if (current.includes(value)) {
      updateField(field, current.filter(v => v !== value));
    } else {
      updateField(field, [...current, value]);
    }
  };

  // Performance OS v3: performanceProfileのネストされたフィールドを更新
  const updatePerformanceProfile = (path: string, value: any) => {
    const current = editForm.performanceProfile || {
      sport: { id: null, name: null, role: null, experience: 'intermediate', phase: 'training', demandVector: null },
      growth: { isUnder18: false, heightChangeRecent: null, growthProtectionEnabled: false },
      cut: { enabled: false, targetWeight: null, targetDate: null, strategy: 'gradual' },
      priorities: { protein: 'moderate', carbs: 'moderate', fat: 'moderate', hydration: 'moderate' },
    };

    const paths = path.split('.');
    const newProfile = JSON.parse(JSON.stringify(current)); // Deep copy
    let obj: any = newProfile;
    for (let i = 0; i < paths.length - 1; i++) {
      if (!obj[paths[i]]) obj[paths[i]] = {};
      obj = obj[paths[i]];
    }
    obj[paths[paths.length - 1]] = value;

    updateField('performanceProfile', newProfile);
  };

  // 栄養目標の計算
  const nutritionTarget = profile ? calculateNutritionTarget(profile) : null;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-40">
      
      {/* ヘッダーエリア */}
      <div className="relative h-56 bg-gradient-to-br from-orange-400 to-orange-500 overflow-hidden">
        <div className="absolute inset-0 opacity-20">
          <div className="absolute top-10 left-10 w-32 h-32 rounded-full bg-white/30" />
          <div className="absolute bottom-0 right-0 w-48 h-48 rounded-full bg-white/20 -mb-20 -mr-20" />
        </div>
        <div className="absolute top-0 left-0 right-0 p-6 z-10 flex justify-between">
          <Button
            variant="ghost"
            className="text-white hover:bg-white/20"
            onClick={() => router.push('/settings')}
          >
            <Icons.Settings className="w-6 h-6" />
          </Button>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              className="text-white hover:bg-white/20"
              onClick={() => setIsEditing(true)}
            >
              <Icons.Edit className="w-6 h-6" />
            </Button>
            <Button
              variant="ghost"
              className="text-white hover:bg-white/20"
              onClick={async () => {
                if (!confirm('ログアウトしますか？')) return;
                clearUserScopedLocalStorage();
                const supabase = createClient();
                await supabase.auth.signOut();
                router.push('/login');
              }}
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
            </Button>
          </div>
        </div>
      </div>

      <div className="px-6 -mt-20 relative z-10">
        
        {/* メインIDカード */}
        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="bg-white rounded-3xl p-6 shadow-xl relative overflow-hidden mb-6"
        >
          <div className="absolute top-0 right-0 w-24 h-24 bg-orange-50 rounded-bl-[80px] -z-0" />
          
          <div className="flex flex-col items-center relative z-10">
            <div className="w-20 h-20 rounded-full p-1 bg-gradient-to-tr from-orange-400 to-orange-300 mb-4">
               <div className="w-full h-full rounded-full bg-white border-4 border-white overflow-hidden flex items-center justify-center text-2xl font-bold text-orange-400">
                 {profile?.nickname?.[0] || user?.email?.[0]?.toUpperCase() || '👤'}
               </div>
            </div>
            
            <h1 className="text-xl font-bold text-gray-900 mb-1">{profile?.nickname || user?.email?.split('@')[0]}</h1>
            <p className="text-sm text-gray-400 mb-4">{profile?.goalText || "目標を設定しましょう"}</p>
            
            {/* プロファイル完成度 */}
            <div className="w-full mb-4">
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>プロファイル完成度</span>
                <span>{profile?.profileCompleteness || 0}%</span>
              </div>
              <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-orange-400 to-orange-500 rounded-full transition-all duration-500"
                  style={{ width: `${profile?.profileCompleteness || 0}%` }}
                />
              </div>
            </div>
            
            <div className="flex gap-6 w-full justify-center border-t border-gray-100 pt-4">
              <div className="text-center">
                 <p className="text-xl font-bold text-gray-900">{badgeCount}</p>
                 <p className="text-xs font-bold text-gray-400">バッジ</p>
              </div>
              <div className="text-center">
                 <p className="text-xl font-bold text-orange-500">{nutritionTarget?.dailyCalories || '-'}</p>
                 <p className="text-xs font-bold text-gray-400">目標kcal</p>
              </div>
              <div className="text-center">
                 <p className="text-xl font-bold text-gray-900">{profile?.familySize || 1}</p>
                 <p className="text-xs font-bold text-gray-400">人分</p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* 栄養目標カード */}
        {nutritionTarget && (
          <motion.div 
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 mb-6"
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-gray-900">📊 あなたの栄養目標（1日）</h3>
              <a 
                href="/profile/nutrition-targets"
                className="text-xs text-orange-500 hover:text-orange-600 flex items-center gap-1"
              >
                根拠を見る
                <Icons.ChevronRight className="w-4 h-4" />
              </a>
            </div>
            <div className="grid grid-cols-4 gap-2">
              <div className="text-center p-2 bg-orange-50 rounded-xl">
                <p className="text-lg font-bold text-orange-500">{nutritionTarget.protein}g</p>
                <p className="text-xs text-gray-500">タンパク質</p>
              </div>
              <div className="text-center p-2 bg-blue-50 rounded-xl">
                <p className="text-lg font-bold text-blue-500">{nutritionTarget.fat}g</p>
                <p className="text-xs text-gray-500">脂質</p>
              </div>
              <div className="text-center p-2 bg-green-50 rounded-xl">
                <p className="text-lg font-bold text-green-500">{nutritionTarget.carbs}g</p>
                <p className="text-xs text-gray-500">炭水化物</p>
              </div>
              <div className="text-center p-2 bg-purple-50 rounded-xl">
                <p className="text-lg font-bold text-purple-500">{nutritionTarget.fiber}g</p>
                <p className="text-xs text-gray-500">食物繊維</p>
              </div>
            </div>
          </motion.div>
        )}

        {/* クイック設定カード */}
        <div className="space-y-4">
          <h2 className="font-bold text-gray-900 px-2">プロフィール設定</h2>

          <div className="bg-white rounded-2xl overflow-hidden shadow-sm border border-gray-100">
            {[
              { 
                label: '基本情報', 
                icon: '👤', 
                desc: profile?.age 
                  ? `${profile.age}歳 / ${profile.gender === 'male' ? '男性' : profile.gender === 'female' ? '女性' : '-'}${profile.height && profile.weight ? ` / ${profile.height}cm ${profile.weight}kg` : ''}`
                  : '設定する',
                tab: 'basic' as TabType
              },
              { 
                label: '目標設定', 
                icon: '🎯', 
                desc: profile?.fitnessGoals?.length 
                  ? profile.fitnessGoals.slice(0, 3).map(g => FITNESS_GOALS.find(fg => fg.value === g)?.label).join(', ')
                  : '設定する',
                tab: 'goals' as TabType
              },
              { 
                label: '健康状態', 
                icon: '❤️', 
                desc: profile?.healthConditions?.length 
                  ? profile.healthConditions.slice(0, 2).join(', ')
                  : '特になし',
                tab: 'health' as TabType
              },
              { 
                label: '食事制限', 
                icon: '🍽️', 
                desc: profile?.dietFlags?.allergies?.length 
                  ? `アレルギー: ${profile.dietFlags.allergies.slice(0, 2).join(', ')}`
                  : 'なし',
                tab: 'diet' as TabType
              },
              { 
                label: '調理環境', 
                icon: '👨‍🍳', 
                desc: `${profile?.cookingExperience === 'advanced' ? '上級者' : profile?.cookingExperience === 'intermediate' ? '中級者' : '初心者'} / ${profile?.weekdayCookingMinutes || 30}分`,
                tab: 'cooking' as TabType
              },
              { 
                label: '生活スタイル', 
                icon: '🏠', 
                desc: profile?.workStyle 
                  ? `${profile.workStyle === 'remote' ? 'リモート' : profile.workStyle === 'fulltime' ? 'フルタイム' : profile.workStyle} / 週${profile.weeklyExerciseMinutes || 0}分運動`
                  : '設定する',
                tab: 'lifestyle' as TabType
              },
            ].map((item, i) => (
              <button 
                key={i} 
                onClick={() => { setActiveTab(item.tab); setIsEditing(true); }}
                className="w-full flex items-center gap-4 p-4 hover:bg-gray-50 transition-colors border-b border-gray-100 last:border-0 text-left"
              >
                <div className="w-10 h-10 rounded-full bg-gray-50 flex items-center justify-center text-xl">
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

        {/* 健康管理セクション */}
        <div className="space-y-4 mt-8">
          <h2 className="font-bold text-gray-900 px-2">健康管理</h2>

          <div className="bg-white rounded-2xl overflow-hidden shadow-sm border border-gray-100">
            <button
              onClick={() => router.push('/health/checkups')}
              className="w-full flex items-center gap-4 p-4 hover:bg-gray-50 transition-colors text-left"
            >
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center text-xl">
                🩺
              </div>
              <div className="flex-1">
                <p className="font-bold text-gray-900 text-sm">健康診断記録</p>
                <p className="text-xs text-gray-400 truncate">検査結果の記録・分析・献立への反映</p>
              </div>
              <div className="text-gray-300">
                <Icons.ChevronRight className="w-5 h-5" />
              </div>
            </button>
          </div>
        </div>

        {/* アプリ設定リンク */}
        <div className="space-y-4 mt-8">
          <h2 className="font-bold text-gray-900 px-2">アプリ設定</h2>

          <div className="bg-white rounded-2xl overflow-hidden shadow-sm border border-gray-100">
            <button
              onClick={() => router.push('/settings')}
              className="w-full flex items-center gap-4 p-4 hover:bg-gray-50 transition-colors text-left border-b border-gray-50"
            >
              <div className="w-10 h-10 rounded-full bg-gray-50 flex items-center justify-center text-xl">
                ⚙️
              </div>
              <div className="flex-1">
                <p className="font-bold text-gray-900 text-sm">設定</p>
                <p className="text-xs text-gray-400 truncate">通知、週の開始日、データとプライバシー</p>
              </div>
              <div className="text-gray-300">
                <Icons.ChevronRight className="w-5 h-5" />
              </div>
            </button>
            <button
              onClick={async () => {
                clearUserScopedLocalStorage();
                const supabase = createClient();
                await supabase.auth.signOut();
                router.push('/login');
              }}
              className="w-full flex items-center gap-4 p-4 hover:bg-red-50 transition-colors text-left"
            >
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center text-xl">
                👋
              </div>
              <div className="flex-1">
                <p className="font-bold text-red-500 text-sm">ログアウト</p>
              </div>
            </button>
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
            className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-none"
          >
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              className="bg-white w-full max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[90vh] flex flex-col pointer-events-auto"
            >
              {/* ヘッダー */}
              <div className="flex justify-between items-center p-6 border-b border-gray-100">
                {isGuidedMode ? (
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Sparkles size={18} className="text-orange-500" />
                      <h2 className="text-lg font-bold text-gray-900">栄養目標の設定</h2>
                    </div>
                    <p className="text-xs text-gray-500">
                      プロフィールを完成させて、最適な栄養目標を計算しましょう
                    </p>
                  </div>
                ) : (
                  <h2 className="text-xl font-bold text-gray-900">プロフィール編集</h2>
                )}
                <button
                  onClick={isGuidedMode ? handleGuidedClose : () => setIsEditing(false)}
                  className="p-2 bg-gray-100 rounded-full hover:bg-gray-200"
                >
                  <Icons.Close className="w-5 h-5 text-gray-500" />
                </button>
              </div>

              {/* ガイドモード: プログレスバー */}
              {isGuidedMode && (
                <div className="px-6 pt-4">
                  <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
                    <span>ステップ {guidedStepIndex + 1} / {guidedTabs.length}</span>
                    <span>{TABS.find(t => t.id === activeTab)?.label}</span>
                  </div>
                  <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-orange-400 to-orange-500 rounded-full transition-all duration-300"
                      style={{ width: `${((guidedStepIndex + 1) / guidedTabs.length) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              {/* タブ（ガイドモードでは非表示） */}
              {!isGuidedMode && (
                <div className="flex gap-1 p-2 bg-gray-50 overflow-x-auto">
                  {TABS.map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex items-center gap-1 px-3 py-2 rounded-xl text-sm font-bold whitespace-nowrap transition-colors ${
                        activeTab === tab.id
                          ? 'bg-orange-400 text-white'
                          : 'text-gray-500 hover:bg-gray-100'
                      }`}
                    >
                      <span>{tab.icon}</span>
                      <span>{tab.label}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* コンテンツ */}
              <div className="flex-1 overflow-y-auto p-6">
                {/* 基本情報タブ */}
                {activeTab === 'basic' && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>ニックネーム</Label>
                      <Input 
                        value={editForm.nickname || ''} 
                        onChange={(e) => updateField('nickname', e.target.value)}
                        className="rounded-xl"
                        placeholder="例: たろう"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Label htmlFor="profile-age-input">年齢</Label>
                          {!editForm.age && (
                            <span
                              data-testid="profile-age-empty-badge"
                              className="text-orange-600 text-[10px] font-bold px-2 py-0.5 bg-orange-50 rounded"
                            >
                              未入力
                            </span>
                          )}
                        </div>
                        <Input
                          id="profile-age-input"
                          type="number"
                          value={editForm.age ?? ''}
                          onChange={(e) => updateField('age', parseInt(e.target.value) || null)}
                          className="rounded-xl placeholder:italic placeholder:text-gray-400"
                          placeholder="例: 30"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>性別</Label>
                        <select
                          value={editForm.gender || 'unspecified'}
                          onChange={(e) => updateField('gender', e.target.value)}
                          className="w-full px-3 py-2 rounded-xl border border-gray-200"
                        >
                          <option value="unspecified">選択しない</option>
                          <option value="male">男性</option>
                          <option value="female">女性</option>
                        </select>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>職業</Label>
                      <Input 
                        value={editForm.occupation || ''} 
                        onChange={(e) => updateField('occupation', e.target.value)}
                        className="rounded-xl"
                        placeholder="会社員"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Label htmlFor="profile-height-input">身長 (cm)</Label>
                          {!editForm.height && (
                            <span
                              data-testid="profile-height-empty-badge"
                              className="text-orange-600 text-[10px] font-bold px-2 py-0.5 bg-orange-50 rounded"
                            >
                              未入力
                            </span>
                          )}
                        </div>
                        <Input
                          id="profile-height-input"
                          type="number"
                          value={editForm.height ?? ''}
                          onChange={(e) => updateField('height', parseFloat(e.target.value) || null)}
                          className="rounded-xl placeholder:italic placeholder:text-gray-400"
                          placeholder="例: 170"
                        />
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Label htmlFor="profile-weight-input">体重 (kg)</Label>
                          {!editForm.weight && (
                            <span
                              data-testid="profile-weight-empty-badge"
                              className="text-orange-600 text-[10px] font-bold px-2 py-0.5 bg-orange-50 rounded"
                            >
                              未入力
                            </span>
                          )}
                        </div>
                        <Input
                          id="profile-weight-input"
                          type="number"
                          value={editForm.weight ?? ''}
                          onChange={(e) => updateField('weight', parseFloat(e.target.value) || null)}
                          className="rounded-xl placeholder:italic placeholder:text-gray-400"
                          placeholder="例: 65"
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>目標（テキスト）</Label>
                      <Input 
                        value={editForm.goalText || ''} 
                        onChange={(e) => updateField('goalText', e.target.value)}
                        className="rounded-xl"
                        placeholder="健康的な体型の維持"
                      />
                    </div>
                  </div>
                )}

                {/* 目標タブ */}
                {activeTab === 'goals' && (
                  <div className="space-y-6">
                    <div className="space-y-3">
                      <Label>達成したい目標（複数選択可）</Label>
                      <div className="grid grid-cols-2 gap-2">
                        {FITNESS_GOALS.map(goal => (
                          <button
                            key={goal.value}
                            onClick={() => toggleArrayItem('fitnessGoals', goal.value)}
                            className={`p-3 rounded-xl border-2 text-left transition-colors ${
                              (editForm.fitnessGoals as string[] || []).includes(goal.value)
                                ? 'border-orange-400 bg-orange-50'
                                : 'border-gray-200 hover:border-orange-200'
                            }`}
                          >
                            <span className="text-lg mr-2">{goal.icon}</span>
                            <span className="text-sm font-bold">{goal.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>目標体重 (kg)</Label>
                        <Input 
                          type="number"
                          value={editForm.targetWeight || ''} 
                          onChange={(e) => updateField('targetWeight', parseFloat(e.target.value) || null)}
                          className="rounded-xl"
                          placeholder="60"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>目標期限</Label>
                        <Input 
                          type="date"
                          value={editForm.targetDate || ''} 
                          onChange={(e) => updateField('targetDate', e.target.value || null)}
                          className="rounded-xl"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Performance OS v3: 競技タブ */}
                {activeTab === 'sports' && (
                  <div className="space-y-6">
                    {/* スポーツ選択 */}
                    <div className="space-y-3">
                      <Label>主に取り組んでいる競技</Label>
                      <div className="grid grid-cols-3 gap-2">
                        {SPORT_OPTIONS.map(sport => {
                          const currentSportId = editForm.performanceProfile?.sport?.id;
                          return (
                            <button
                              key={sport.value}
                              onClick={() => updatePerformanceProfile('sport.id', sport.value === 'none' ? null : sport.value)}
                              className={`p-3 rounded-xl border-2 text-center transition-colors ${
                                currentSportId === sport.value || (sport.value === 'none' && !currentSportId)
                                  ? 'border-purple-400 bg-purple-50'
                                  : 'border-gray-200 hover:border-purple-200'
                              }`}
                            >
                              <span className="text-lg">{sport.icon}</span>
                              <p className="text-xs font-bold mt-1">{sport.label}</p>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* カスタム競技名（その他選択時） */}
                    {editForm.performanceProfile?.sport?.id === 'custom' && (
                      <div className="space-y-2">
                        <Label>競技名を入力</Label>
                        <Input
                          value={editForm.performanceProfile?.sport?.name || ''}
                          onChange={(e) => updatePerformanceProfile('sport.name', e.target.value)}
                          className="rounded-xl"
                          placeholder="例: トライアスロン"
                        />
                      </div>
                    )}

                    {/* 競技経験 */}
                    {editForm.performanceProfile?.sport?.id && editForm.performanceProfile?.sport?.id !== 'none' && (
                      <>
                        <div className="space-y-3">
                          <Label>競技経験</Label>
                          <div className="grid grid-cols-3 gap-2">
                            {EXPERIENCE_OPTIONS.map(exp => (
                              <button
                                key={exp.value}
                                onClick={() => updatePerformanceProfile('sport.experience', exp.value)}
                                className={`p-3 rounded-xl border-2 text-center transition-colors ${
                                  editForm.performanceProfile?.sport?.experience === exp.value
                                    ? 'border-purple-400 bg-purple-50'
                                    : 'border-gray-200 hover:border-purple-200'
                                }`}
                              >
                                <span className="text-lg">{exp.icon}</span>
                                <p className="text-xs font-bold mt-1">{exp.label}</p>
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* トレーニング期 */}
                        <div className="space-y-3">
                          <Label>現在のトレーニング期</Label>
                          <div className="grid grid-cols-2 gap-2">
                            {PHASE_OPTIONS.map(phase => (
                              <button
                                key={phase.value}
                                onClick={() => updatePerformanceProfile('sport.phase', phase.value)}
                                className={`p-3 rounded-xl border-2 text-left transition-colors ${
                                  editForm.performanceProfile?.sport?.phase === phase.value
                                    ? 'border-purple-400 bg-purple-50'
                                    : 'border-gray-200 hover:border-purple-200'
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <span className="text-lg">{phase.icon}</span>
                                  <div>
                                    <p className="text-sm font-bold">{phase.label}</p>
                                    <p className="text-xs text-gray-500">{phase.desc}</p>
                                  </div>
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* 次の大会（試合期・減量期の場合） */}
                        {(editForm.performanceProfile?.sport?.phase === 'competition' ||
                          editForm.performanceProfile?.sport?.phase === 'cut') && (
                          <div className="space-y-2">
                            <Label>次の大会・試合日</Label>
                            <Input
                              type="date"
                              value={editForm.performanceProfile?.cut?.targetDate || ''}
                              onChange={(e) => updatePerformanceProfile('cut.targetDate', e.target.value || null)}
                              className="rounded-xl"
                            />
                          </div>
                        )}
                      </>
                    )}

                    {/* 説明 */}
                    <div className="bg-purple-50 rounded-xl p-4 text-sm text-purple-700">
                      <p className="font-bold mb-1">🏆 競技プロフィールとは？</p>
                      <p>競技に取り組んでいる方向けの機能です。トレーニング期や競技特性に合わせて、最適な栄養提案を行います。</p>
                    </div>
                  </div>
                )}

                {/* 健康タブ */}
                {activeTab === 'health' && (
                  <div className="space-y-6">
                    <div className="space-y-3">
                      <Label>気になる健康状態（複数選択可）</Label>
                      <div className="flex flex-wrap gap-2">
                        {HEALTH_CONDITIONS.map(condition => (
                          <button
                            key={condition}
                            onClick={() => toggleArrayItem('healthConditions', condition)}
                            className={`px-3 py-2 rounded-full text-sm font-bold transition-colors ${
                              (editForm.healthConditions as string[] || []).includes(condition)
                                ? 'bg-red-100 text-red-600 border-2 border-red-300'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                            }`}
                          >
                            {condition}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>睡眠の質</Label>
                        <select
                          value={editForm.sleepQuality || ''}
                          onChange={(e) => updateField('sleepQuality', e.target.value || null)}
                          className="w-full px-3 py-2 rounded-xl border border-gray-200"
                        >
                          <option value="">選択</option>
                          <option value="good">良好</option>
                          <option value="average">普通</option>
                          <option value="poor">悪い</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label>ストレスレベル</Label>
                        <select
                          value={editForm.stressLevel || ''}
                          onChange={(e) => updateField('stressLevel', e.target.value || null)}
                          className="w-full px-3 py-2 rounded-xl border border-gray-200"
                        >
                          <option value="">選択</option>
                          <option value="low">低い</option>
                          <option value="medium">普通</option>
                          <option value="high">高い</option>
                        </select>
                      </div>
                    </div>
                    <div className="space-y-3">
                      <Label>その他</Label>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => updateField('coldSensitivity', !editForm.coldSensitivity)}
                          className={`px-3 py-2 rounded-full text-sm font-bold transition-colors ${
                            editForm.coldSensitivity
                              ? 'bg-blue-100 text-blue-600 border-2 border-blue-300'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                        >
                          🥶 冷え性
                        </button>
                        <button
                          onClick={() => updateField('swellingProne', !editForm.swellingProne)}
                          className={`px-3 py-2 rounded-full text-sm font-bold transition-colors ${
                            editForm.swellingProne
                              ? 'bg-blue-100 text-blue-600 border-2 border-blue-300'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                        >
                          💧 むくみやすい
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* 食事制限タブ */}
                {activeTab === 'diet' && (
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <Label>食事スタイル</Label>
                      <select
                        value={editForm.dietStyle || 'normal'}
                        onChange={(e) => updateField('dietStyle', e.target.value as DietStyle)}
                        className="w-full px-3 py-2 rounded-xl border border-gray-200"
                      >
                        <option value="normal">通常</option>
                        <option value="vegetarian">ベジタリアン</option>
                        <option value="vegan">ヴィーガン</option>
                        <option value="pescatarian">ペスカタリアン</option>
                        <option value="gluten_free">グルテンフリー</option>
                        <option value="keto">ケトジェニック</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <Label>アレルギー（カンマ区切り）</Label>
                      <Input 
                        value={(editForm.dietFlags?.allergies || []).join(', ')} 
                        onChange={(e) => updateField('dietFlags', {
                          ...editForm.dietFlags,
                          allergies: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                        })}
                        className="rounded-xl"
                        placeholder="卵, エビ, 小麦"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>苦手な食材（カンマ区切り）</Label>
                      <Input 
                        value={(editForm.dietFlags?.dislikes || []).join(', ')} 
                        onChange={(e) => updateField('dietFlags', {
                          ...editForm.dietFlags,
                          dislikes: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                        })}
                        className="rounded-xl"
                        placeholder="ピーマン, セロリ"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>好きな食材（カンマ区切り）</Label>
                      <Input 
                        value={(editForm.favoriteIngredients || []).join(', ')} 
                        onChange={(e) => updateField('favoriteIngredients', 
                          e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                        )}
                        className="rounded-xl"
                        placeholder="鶏肉, トマト, アボカド"
                      />
                    </div>
                  </div>
                )}

                {/* 調理環境タブ */}
                {activeTab === 'cooking' && (
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <Label>料理経験</Label>
                      <select
                        value={editForm.cookingExperience || 'beginner'}
                        onChange={(e) => updateField('cookingExperience', e.target.value as CookingExperience)}
                        className="w-full px-3 py-2 rounded-xl border border-gray-200"
                      >
                        <option value="beginner">初心者（1年未満）</option>
                        <option value="intermediate">中級者（1-3年）</option>
                        <option value="advanced">上級者（3年以上）</option>
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>平日調理時間（分）</Label>
                        <Input 
                          type="number"
                          value={editForm.weekdayCookingMinutes || 30} 
                          onChange={(e) => updateField('weekdayCookingMinutes', parseInt(e.target.value) || 30)}
                          className="rounded-xl"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>休日調理時間（分）</Label>
                        <Input 
                          type="number"
                          value={editForm.weekendCookingMinutes || 60} 
                          onChange={(e) => updateField('weekendCookingMinutes', parseInt(e.target.value) || 60)}
                          className="rounded-xl"
                        />
                      </div>
                    </div>
                    <div className="space-y-3">
                      <Label>持っている調理器具</Label>
                      <div className="flex flex-wrap gap-2">
                        {KITCHEN_APPLIANCES.map(appliance => (
                          <button
                            key={appliance}
                            onClick={() => toggleArrayItem('kitchenAppliances', appliance)}
                            className={`px-3 py-2 rounded-full text-sm font-bold transition-colors ${
                              (editForm.kitchenAppliances as string[] || []).includes(appliance)
                                ? 'bg-green-100 text-green-600 border-2 border-green-300'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                            }`}
                          >
                            {appliance}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        id="mealPrepOk"
                        checked={editForm.mealPrepOk ?? true}
                        onChange={(e) => updateField('mealPrepOk', e.target.checked)}
                        className="w-5 h-5 rounded"
                      />
                      <Label htmlFor="mealPrepOk">作り置きOK</Label>
                    </div>
                  </div>
                )}

                {/* 生活スタイルタブ */}
                {activeTab === 'lifestyle' && (
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <Label>勤務形態</Label>
                      <select
                        value={editForm.workStyle || ''}
                        onChange={(e) => updateField('workStyle', e.target.value as WorkStyle || null)}
                        className="w-full px-3 py-2 rounded-xl border border-gray-200"
                      >
                        <option value="">選択</option>
                        <option value="fulltime">フルタイム勤務</option>
                        <option value="parttime">パートタイム</option>
                        <option value="freelance">フリーランス</option>
                        <option value="remote">リモートワーク</option>
                        <option value="shift">シフト勤務</option>
                        <option value="student">学生</option>
                        <option value="homemaker">主婦/主夫</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <Label>週の運動時間（分）</Label>
                      <Input 
                        type="number"
                        value={editForm.weeklyExerciseMinutes || 0} 
                        onChange={(e) => updateField('weeklyExerciseMinutes', parseInt(e.target.value) || 0)}
                        className="rounded-xl"
                        placeholder="120"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>家族人数</Label>
                      <Input 
                        type="number"
                        value={editForm.familySize || 1} 
                        onChange={(e) => updateField('familySize', parseInt(e.target.value) || 1)}
                        className="rounded-xl"
                        min={1}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>週間食費予算（円）</Label>
                      <Input 
                        type="number"
                        value={editForm.weeklyFoodBudget || ''} 
                        onChange={(e) => updateField('weeklyFoodBudget', parseInt(e.target.value) || null)}
                        className="rounded-xl"
                        placeholder="10000"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>趣味（カンマ区切り）</Label>
                      <Input 
                        value={(editForm.hobbies || []).join(', ')} 
                        onChange={(e) => updateField('hobbies', 
                          e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                        )}
                        className="rounded-xl"
                        placeholder="ランニング, 読書, 料理"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* フッター */}
              <div className="p-6 border-t border-gray-100">
                {isGuidedMode ? (
                  <div className="space-y-3">
                    <div className="flex gap-3">
                      {guidedStepIndex > 0 && (
                        <Button
                          onClick={handleGuidedPrev}
                          variant="outline"
                          className="flex-1 py-6 rounded-full border-gray-200"
                        >
                          <ChevronLeft size={18} className="mr-1" />
                          戻る
                        </Button>
                      )}
                      <Button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="flex-1 py-6 rounded-full bg-orange-500 hover:bg-orange-600 text-white font-bold"
                      >
                        {isSaving ? (
                          '保存中...'
                        ) : guidedStepIndex < guidedTabs.length - 1 ? (
                          <>
                            次へ
                            <ChevronRight size={18} className="ml-1" />
                          </>
                        ) : (
                          <>
                            <Check size={18} className="mr-1" />
                            完了
                          </>
                        )}
                      </Button>
                    </div>
                    <button
                      onClick={handleGuidedClose}
                      className="w-full text-center text-sm text-gray-400 hover:text-gray-600"
                    >
                      後で設定する
                    </button>
                  </div>
                ) : (
                  <Button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="w-full py-6 rounded-full bg-gray-900 hover:bg-black text-white font-bold"
                  >
                    {isSaving ? '保存中...' : '変更を保存'}
                  </Button>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}

// Suspense boundary で useSearchParams を wrap
export default function ProfilePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full" />
      </div>
    }>
      <ProfilePageContent />
    </Suspense>
  );
}
