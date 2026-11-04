"use client";

import { useCallback, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { X, UserCircle, ChevronRight, Target, Heart, Scale } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAiConsultationReceiver, type AiConsultationRead } from "@/hooks/useAiConsultationReceiver";

// プロフィール完成度のしきい値（これ未満だとバナー表示・これ以上なら出さない）
const COMPLETENESS_THRESHOLD = 50;

// 表示頻度の制御（最後の非表示から何日後に再表示するか）
const REMIND_AFTER_DAYS = 7;

/** 1 日のミリ秒 (閉じてからの日数を数える) */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 帯 (出すか・完成度・未入力の欄) の置き場所の鍵 (#2206 G1) */
const KEY_BANNER = 'banner';

interface MissingField {
  key: string;
  label: string;
  icon: typeof UserCircle;
  priority: number;
}

// 優先度の高い未入力フィールド
const FIELD_CONFIG: MissingField[] = [
  { key: 'height', label: '身長', icon: Scale, priority: 1 },
  { key: 'weight', label: '体重', icon: Scale, priority: 1 },
  { key: 'age', label: '年齢', icon: UserCircle, priority: 1 },
  { key: 'fitnessGoals', label: '目標設定', icon: Target, priority: 2 },
  { key: 'healthConditions', label: '健康状態', icon: Heart, priority: 3 },
];

/** 閉じてから REMIND_AFTER_DAYS 日の間か (その間は帯を出さない) */
function isDismissedRecently(): boolean {
  const lastDismissed = localStorage.getItem('profile_reminder_dismissed');
  if (!lastDismissed) return false;
  const dismissedDate = new Date(lastDismissed);
  const now = new Date();
  const daysDiff = (now.getTime() - dismissedDate.getTime()) / MS_PER_DAY;
  return daysDiff < REMIND_AFTER_DAYS;
}

/** 帯に出す未入力の欄 (優先度の順) */
function missingFieldsOf(profile: {
  height: number | null;
  weight: number | null;
  age: number | null;
  fitness_goals: string[] | null;
  health_conditions: string[] | null;
}): MissingField[] {
  const missing: MissingField[] = [];
  if (!profile.height) {
    missing.push(FIELD_CONFIG.find(f => f.key === 'height')!);
  }
  if (!profile.weight) {
    missing.push(FIELD_CONFIG.find(f => f.key === 'weight')!);
  }
  if (!profile.age) {
    missing.push(FIELD_CONFIG.find(f => f.key === 'age')!);
  }
  if (!profile.fitness_goals || profile.fitness_goals.length === 0) {
    missing.push(FIELD_CONFIG.find(f => f.key === 'fitnessGoals')!);
  }
  if (!profile.health_conditions || profile.health_conditions.length === 0) {
    missing.push(FIELD_CONFIG.find(f => f.key === 'healthConditions')!);
  }
  return missing.filter(Boolean).sort((a, b) => a.priority - b.priority);
}

export function ProfileReminderBanner() {
  const router = useRouter();
  const [isVisible, setIsVisible] = useState(false);
  const [completeness, setCompleteness] = useState<number | null>(null);
  const [missingFields, setMissingFields] = useState<MissingField[]>([]);
  /** 帯を出さない答え。取り直しでは前の帯 (未入力の一覧) を残さず、読み込み直したときと同じく消す (#2195 V1) */
  const hide = useCallback(() => {
    setIsVisible(false);
    setMissingFields([]);
  }, []);

  /**
   * プロフィールの完成度を読んで帯を出すか決める。開いたときと AI 相談の成功の取り直しで呼ぶ (#2206 G1)。
   * 応答は read.place の中で置く (順序・番兵の判断は hook。前の読み取りの答えが後から届いても置かない)。
   * 取り直し ('refetch') の読み取りの失敗 (ログインの確かめ・プロフィールの読み取りのエラー) では、帯を消さずに今の表示を残す (#2201 U1)
   */
  const checkProfile = useCallback(async (read: AiConsultationRead) => {
    try {
      // ローカルストレージで非表示設定を確認 (まだリマインド期間内なので表示しない。await の前なので place の外でよい)
      if (isDismissedRecently()) {
        hide();
        return;
      }

      // ブラウザでは 1 つの client を使い回す (lib/supabase/client.ts)。描画のたびに作り直さないよう、取得の中で取る
      const supabase = createClient();
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (read.mode === 'refetch' && userError && !user) return;
      if (!user) {
        read.place(KEY_BANNER, () => hide());
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('profile_completeness, height, weight, age, fitness_goals, health_conditions')
        .eq('id', user.id)
        .single();
      if (read.mode === 'refetch' && profileError) return;

      if (!profile) {
        read.place(KEY_BANNER, () => hide());
        return;
      }

      const profileCompleteness = profile.profile_completeness ?? 0;
      read.place(KEY_BANNER, () => {
        setCompleteness(profileCompleteness);
        if (profileCompleteness >= COMPLETENESS_THRESHOLD) {
          hide();
          return;
        }
        // 未入力フィールドを特定 (取り直しのたびに置き直す)
        setMissingFields(missingFieldsOf(profile));
        setIsVisible(true);
      });
    } catch (error) {
      console.error('Profile check error:', error);
    }
  }, [hide]);

  // AI 相談でプロフィール (身長・体重・年齢・目標・健康の状態) が変わったら読み直す (#2195 V1)。
  // 帯を置いたページ (献立表) の取り直しはこの部品の読み取りをしないため、部品が自分で受ける。
  // 番兵で止めた通知は、外れたときに 1 回取り直す (#2201 U2。判断は hook)。帯は読み込み中の表示を持たない
  const receiver = useAiConsultationReceiver(checkProfile);

  // receiver の参照は一生同じなので、この effect は開いたときの 1 回だけ走る
  useEffect(() => {
    void receiver.read({}, checkProfile);
  }, [receiver, checkProfile]);

  const handleDismiss = () => {
    localStorage.setItem('profile_reminder_dismissed', new Date().toISOString());
    setIsVisible(false);
  };

  const handleComplete = () => {
    // プロフィール設定ページへ遷移（未入力項目から開始）
    router.push('/profile?focus=incomplete');
  };

  if (!isVisible) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        className="mx-4 mb-4"
      >
        <div
          className="relative rounded-2xl p-4 shadow-sm border overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, #FFF7ED 0%, #FFEDD5 100%)',
            borderColor: '#FDBA74',
          }}
        >
          {/* 背景装飾 */}
          <div className="absolute top-0 right-0 w-24 h-24 rounded-full bg-orange-200/30 -mr-8 -mt-8" />
          <div className="absolute bottom-0 left-0 w-16 h-16 rounded-full bg-orange-200/20 -ml-4 -mb-4" />

          {/* 閉じるボタン */}
          <button
            onClick={handleDismiss}
            className="absolute top-3 right-3 p-1 rounded-full hover:bg-orange-200/50 transition-colors"
          >
            <X size={16} className="text-orange-600" />
          </button>

          <div className="relative z-10">
            {/* ヘッダー */}
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-full bg-orange-400 flex items-center justify-center">
                <Target size={16} className="text-white" />
              </div>
              <div>
                <h3 className="font-bold text-orange-900 text-sm">栄養目標を設定しましょう</h3>
                <p className="text-xs text-orange-700">
                  プロフィール完成度: <span className="font-bold">{completeness}%</span>
                </p>
              </div>
            </div>

            {/* 未入力項目 */}
            {missingFields.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {missingFields.slice(0, 3).map((field) => (
                  <span
                    key={field.key}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-white/70 rounded-full text-xs text-orange-700"
                  >
                    <field.icon size={10} />
                    {field.label}
                  </span>
                ))}
                {missingFields.length > 3 && (
                  <span className="text-xs text-orange-600">
                    +{missingFields.length - 3}
                  </span>
                )}
              </div>
            )}

            {/* アクションボタン */}
            <button
              onClick={handleComplete}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-orange-500 text-white font-bold text-sm hover:bg-orange-600 transition-colors shadow-sm"
            >
              入力して最適な栄養目標を設定
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
