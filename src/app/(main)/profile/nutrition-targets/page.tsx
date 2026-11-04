"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { motion } from "framer-motion";
import { Icons } from "@/components/icons";
import { NutritionTargetPlanner } from "@/components/nutrition/nutrition-target-planner";
import { useAiConsultationReceiver, type AiConsultationRead } from "@/hooks/useAiConsultationReceiver";
import type { CalculationBasis, NutrientReference } from "@homegohan/core";

interface NutritionTargetsData {
  id: string;
  daily_calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fiber_g: number;
  sodium_g: number;
  potassium_mg: number;
  calcium_mg: number;
  iron_mg: number;
  zinc_mg: number;
  vitamin_a_ug: number;
  vitamin_b1_mg: number;
  vitamin_b2_mg: number;
  vitamin_b6_mg: number;
  vitamin_b12_ug: number;
  vitamin_c_mg: number;
  vitamin_d_ug: number;
  vitamin_e_mg: number;
  vitamin_k_ug: number;
  folic_acid_ug: number;
  iodine_ug: number;
  phosphorus_mg: number;
  cholesterol_mg: number;
  calculation_basis: CalculationBasis;
  last_calculated_at: string;
  auto_calculate: boolean;
}

interface ProfileData {
  nickname: string;
  age: number;
  gender: string;
  height: number;
  weight: number;
  work_style: string;
  exercise_intensity: string;
  exercise_frequency: number;
  nutrition_goal: string;
  weight_change_rate: string;
  health_conditions: string[];
  medications: string[];
  pregnancy_status: string;
}

const WORK_STYLE_LABELS: Record<string, string> = {
  sedentary: '座り仕事',
  light_active: '軽い活動',
  moderately_active: '普通の活動',
  very_active: '激しい活動',
  student: '学生',
  homemaker: '主婦/主夫',
};

const EXERCISE_INTENSITY_LABELS: Record<string, string> = {
  light: '軽い',
  moderate: '普通',
  intense: '激しい',
  athlete: 'アスリート',
};

const GOAL_LABELS: Record<string, string> = {
  maintain: '現状維持',
  lose_weight: '減量',
  gain_muscle: '筋肥大',
  athlete_performance: '競技パフォーマンス',
};

const GENDER_LABELS: Record<string, string> = {
  male: '男性',
  female: '女性',
  unspecified: '未設定',
};

// 栄養素のラベルと単位
const NUTRIENT_INFO: Record<string, { label: string; unit: string }> = {
  vitamin_a_ug: { label: 'ビタミンA', unit: 'µg' },
  vitamin_d_ug: { label: 'ビタミンD', unit: 'µg' },
  vitamin_e_mg: { label: 'ビタミンE', unit: 'mg' },
  vitamin_k_ug: { label: 'ビタミンK', unit: 'µg' },
  vitamin_b1_mg: { label: 'ビタミンB1', unit: 'mg' },
  vitamin_b2_mg: { label: 'ビタミンB2', unit: 'mg' },
  vitamin_b6_mg: { label: 'ビタミンB6', unit: 'mg' },
  vitamin_b12_ug: { label: 'ビタミンB12', unit: 'µg' },
  vitamin_c_mg: { label: 'ビタミンC', unit: 'mg' },
  folic_acid_ug: { label: '葉酸', unit: 'µg' },
  potassium_mg: { label: 'カリウム', unit: 'mg' },
  calcium_mg: { label: 'カルシウム', unit: 'mg' },
  phosphorus_mg: { label: 'リン', unit: 'mg' },
  iron_mg: { label: '鉄', unit: 'mg' },
  zinc_mg: { label: '亜鉛', unit: 'mg' },
  iodine_ug: { label: 'ヨウ素', unit: 'µg' },
  sodium_g: { label: '食塩相当量', unit: 'g' },
  fiber_g: { label: '食物繊維', unit: 'g' },
  cholesterol_mg: { label: 'コレステロール', unit: 'mg' },
  sugar_g: { label: '糖質', unit: 'g' },
};

const BASIS_TYPE_LABELS: Record<string, string> = {
  RDA: '推奨量',
  AI: '目安量',
  DG: '目標量',
  UL: '耐容上限量',
};

/**
 * このページの置き場所の鍵 (#2206 G1)。プロフィールと栄養目標と失敗の表示を同じ鍵で置く (取り直しは両方読めたときだけ両方を置く。
 * 片方だけ新しくすると、見出しの目標値と入力値が食い違う)
 */
const KEY_TARGETS_PAGE = 'targetsPage';

/** readTargetsPage の設定 */
interface TargetsPageReadOptions {
  /**
   * 失敗 (ログインを確かめられない・片方でも読めない・投げた) では何も置かずに今の表示を残す。再設定の保存のあとの読み直しが使う
   * (画面はもう出ているので、失敗の画面に切り替えると保存の済んだ再設定ごと隠れる。#2206 G5)。
   * AI 相談の成功の取り直し (read.mode が 'refetch') は指定しなくても残す
   */
  readonly keepOnFailure: boolean;
}

export default function NutritionTargetsExplainPage() {
  const [targets, setTargets] = useState<NutritionTargetsData | null>(null);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRawJson, setShowRawJson] = useState(false);

  /**
   * プロフィールと栄養目標を読む。開いたとき・再設定の保存のあと・AI 相談の成功の取り直しで呼ぶ (#2206 G1)。
   * 応答は read.place の中で置く (順序・番兵・読み込み中の印の判断は hook)。プロフィールと栄養目標を両方読み終えてから置く (#2206 G5)。
   * 取り直し・再設定の保存のあとの読み直し (keepShown) は、ログインを確かめられない・片方でも読めない・投げたときは何も置かない
   * (両方読めたときだけ置く)。開いたときの読み込みは、読めた方を置いて失敗の表示を消し (片方は '-' のまま)、投げたら失敗の表示を置く。
   * ログインしていない (error の無い !user) は mode によらず「ログインが必要です」
   */
  const readTargetsPage = useCallback(async (read: AiConsultationRead, { keepOnFailure }: TargetsPageReadOptions) => {
    const keepShown = read.mode === 'refetch' || keepOnFailure;
    const supabase = createClient();
    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (keepShown && userError && !user) return;
      if (!user) {
        read.place(KEY_TARGETS_PAGE, () => setError("ログインが必要です"));
        return;
      }

      // プロフィールと栄養目標を両方読み終えてから置く (#2206 G5。以前はプロフィールを置いてから栄養目標を読み、栄養目標を
      // 読めなかった取り直しではプロフィールだけが新しくなった)
      const profileRes = await supabase.from('user_profiles').select('*').eq('id', user.id).single();

      // 栄養目標は /api/nutrition/targets 経由で取得（auto_calculate 時はその場で再計算される）
      // これによりマイページ (/profile) と同一の値が表示される（Bug #17 修正）
      const targetsRes = await fetch('/api/nutrition/targets');
      const targetsJson = targetsRes.ok ? await targetsRes.json() : null;

      const profileRead = !profileRes.error;
      const targetsRead = targetsJson !== null;
      // 取り直しで片方でも読めなかった: どちらも置かずに今の表示を残す (片方だけ新しくすると、見出しの目標値と入力値が食い違う)
      if (keepShown && !(profileRead && targetsRead)) return;

      const t = targetsRead ? targetsJson.targets : null;
      // API は camelCase で返すため NutritionTargetsData の snake_case にマッピング。栄養目標が無いときは null (前の値を残さない。#2195 V1)
      const loadedTargets: NutritionTargetsData | null = t
        ? ({
          id: t.id,
          daily_calories: t.dailyCalories,
          protein_g: t.proteinG,
          fat_g: t.fatG,
          carbs_g: t.carbsG,
          fiber_g: t.fiberG,
          sodium_g: t.sodiumG,
          potassium_mg: t.potassiumMg,
          calcium_mg: t.calciumMg,
          iron_mg: t.ironMg,
          zinc_mg: t.zincMg,
          vitamin_a_ug: t.vitaminAUg,
          vitamin_b1_mg: t.vitaminB1Mg,
          vitamin_b2_mg: t.vitaminB2Mg,
          vitamin_b6_mg: t.vitaminB6Mg,
          vitamin_b12_ug: t.vitaminB12Ug,
          vitamin_c_mg: t.vitaminCMg,
          vitamin_d_ug: t.vitaminDUg,
          vitamin_e_mg: t.vitaminEMg,
          vitamin_k_ug: t.vitaminKUg,
          folic_acid_ug: t.folicAcidUg,
          iodine_ug: t.iodineUg,
          phosphorus_mg: t.phosphorusMg,
          cholesterol_mg: t.cholesterolMg,
          calculation_basis: t.calculationBasis,
          last_calculated_at: t.lastCalculatedAt,
          auto_calculate: t.autoCalculate,
        } as NutritionTargetsData)
        : null;
      read.place(KEY_TARGETS_PAGE, () => {
        // 答えをそのまま置く: 取り直し (AI 相談の成功のあと) でも、読み込み直したときと同じ値にする (#2195 V1)
        if (profileRead) setProfile((profileRes.data as ProfileData | null) ?? null);
        if (targetsRead) setTargets(loadedTargets);
        // 前の取得の失敗の表示を残さない (取り直しで取れたら、失敗の画面から戻す。#2195 V1)。
        // 消すのは取り直しで両方を読めたときだけ (#2206 G5)。開いたときの読み込みは、ここまで来れば失敗の表示を出していない
        // (片方を読めなければ '-' で出す。これまでどおり)
        setError(null);
      });
    } catch (e) {
      console.error('Error fetching data:', e);
      if (!keepShown) read.place(KEY_TARGETS_PAGE, () => setError("データの取得に失敗しました"));
    }
  }, []);

  // AI 相談の提案の実行で栄養目標・プロフィールが変わったら取り直す (#2195 V1)。栄養目標の再設定 (NutritionTargetPlanner) の
  // 入力欄を変えている間は取り直さない (再設定の側も自分で取り直す)。番兵で止めた通知は、外れたときに 1 回取り直す
  // (#2201 U2。判断は hook)。取り直しの失敗では今の表示を残す (mode が 'refetch')。最初の描画から読み込み中 (今までの初期値 true。
  // 読み込み中の表示は開いたときの読み込みだけ)
  const receiver = useAiConsultationReceiver((read) => readTargetsPage(read, { keepOnFailure: false }), {
    initialLoadingKeys: [KEY_TARGETS_PAGE],
  });
  const loading = receiver.isLoading(KEY_TARGETS_PAGE);

  // receiver の参照は一生同じなので、この effect は開いたときの 1 回だけ走る
  useEffect(() => {
    void receiver.read({ loadingKeys: [KEY_TARGETS_PAGE] }, (read) => readTargetsPage(read, { keepOnFailure: false }));
  }, [receiver, readTargetsPage]);

  // 栄養目標の再設定 (NutritionTargetPlanner) の保存が済んだら、このページの見出しの目標値・入力値も読み直す (#2206 G5。
  // 以前は再設定の側だけが読み直し、このページは保存の前の数字のまま残った)。失敗では今の表示を残す (読み込み中の表示は出さない)
  const handlePlannerSaved = useCallback(() => {
    void receiver.read({}, (read) => readTargetsPage(read, { keepOnFailure: true }));
  }, [receiver, readTargetsPage]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-500 mb-4">{error}</p>
          <Link href="/profile" className="text-orange-500 hover:underline">
            プロフィールに戻る
          </Link>
        </div>
      </div>
    );
  }

  const basis = targets?.calculation_basis;

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      {/* ヘッダー */}
      <div className="bg-gradient-to-r from-orange-400 to-orange-500 px-4 py-6">
        <div className="flex items-center gap-4 mb-4">
          <Link href="/profile" className="text-white">
            <Icons.ArrowLeft className="w-6 h-6" />
          </Link>
          <h1 className="text-xl font-bold text-white">栄養目標の根拠</h1>
        </div>
        <p className="text-white/80 text-sm">
          日本人の食事摂取基準（2020年版）に基づいて計算された、あなただけの栄養目標です
        </p>
      </div>

      <div className="px-4 py-6 space-y-6">
        {/* サマリーカード */}
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="bg-white rounded-2xl p-6 shadow-sm"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-gray-900">目標サマリー</h2>
              {/* #17 Task4: defaults_applied バッジ（未入力フィールドがある場合に概算であることを明示） */}
              {basis?.missing_fields && basis.missing_fields.length > 0 && (
                <span
                  data-testid="defaults-applied-badge"
                  className="text-[10px] font-bold px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded-full border border-yellow-300"
                  title={`未入力: ${basis.missing_fields.join(', ')} のためデフォルト値で概算`}
                >
                  ⚠️ 概算
                </span>
              )}
            </div>
            {targets?.last_calculated_at && (
              <span className="text-xs text-gray-400">
                {new Date(targets.last_calculated_at).toLocaleDateString('ja-JP')} 計算
              </span>
            )}
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-orange-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-orange-500">{targets?.daily_calories || '-'}</p>
              <p className="text-xs text-gray-500">目標カロリー (kcal)</p>
            </div>
            <div className="bg-blue-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-blue-500">{targets?.protein_g || '-'}</p>
              <p className="text-xs text-gray-500">タンパク質 (g)</p>
            </div>
            <div className="bg-yellow-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-yellow-600">{targets?.fat_g || '-'}</p>
              <p className="text-xs text-gray-500">脂質 (g)</p>
            </div>
            <div className="bg-green-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-green-600">{targets?.carbs_g || '-'}</p>
              <p className="text-xs text-gray-500">炭水化物 (g)</p>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.05 }}
        >
          <NutritionTargetPlanner onSaved={handlePlannerSaved} />
        </motion.div>

        {/* 入力値セクション */}
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="bg-white rounded-2xl p-6 shadow-sm"
        >
          <h2 className="text-lg font-bold text-gray-900 mb-4">📋 計算に使用した入力値</h2>
          
          <div className="space-y-3">
            <div className="flex justify-between py-2 border-b border-gray-100">
              <span className="text-gray-600">年齢</span>
              <span className="font-medium">{basis?.inputs?.age || profile?.age || '-'}歳</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100">
              <span className="text-gray-600">性別</span>
              <span className="font-medium">{GENDER_LABELS[basis?.inputs?.gender || profile?.gender || ''] || '-'}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100">
              <span className="text-gray-600">身長</span>
              <span className="font-medium">{basis?.inputs?.height || profile?.height || '-'}cm</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100">
              <span className="text-gray-600">体重</span>
              <span className="font-medium">{basis?.inputs?.weight || profile?.weight || '-'}kg</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100">
              <span className="text-gray-600">仕事スタイル</span>
              <span className="font-medium">{WORK_STYLE_LABELS[basis?.inputs?.work_style || ''] || '-'}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100">
              <span className="text-gray-600">運動強度</span>
              <span className="font-medium">{EXERCISE_INTENSITY_LABELS[basis?.inputs?.exercise_intensity || ''] || '-'}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100">
              <span className="text-gray-600">運動頻度</span>
              <span className="font-medium">週{basis?.inputs?.exercise_frequency || 0}回</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100">
              <span className="text-gray-600">目標</span>
              <span className="font-medium">{GOAL_LABELS[basis?.inputs?.nutrition_goal || ''] || '-'}</span>
            </div>
            {basis?.inputs?.health_conditions && basis.inputs.health_conditions.length > 0 && (
              <div className="py-2 border-b border-gray-100">
                <span className="text-gray-600 block mb-1">健康状態</span>
                <div className="flex flex-wrap gap-1">
                  {basis.inputs.health_conditions.map((condition) => (
                    <span key={condition} className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full">
                      {condition}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {basis?.inputs?.medications && basis.inputs.medications.length > 0 && (
              <div className="py-2">
                <span className="text-gray-600 block mb-1">服薬</span>
                <div className="flex flex-wrap gap-1">
                  {basis.inputs.medications.map((med) => (
                    <span key={med} className="px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded-full">
                      {med}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {basis?.missing_fields && basis.missing_fields.length > 0 && (
            <div
              data-testid="missing-fields-warning"
              className="mt-4 p-3 bg-yellow-50 rounded-lg"
            >
              <p className="text-xs text-yellow-700">
                ⚠️ 未入力の項目があります: {basis.missing_fields.join(', ')}
                <br />
                デフォルト値で計算されています。プロフィールを更新すると、より正確な目標が計算されます。
              </p>
            </div>
          )}
        </motion.div>

        {/* エネルギー計算セクション */}
        {basis?.energy && (
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="bg-white rounded-2xl p-6 shadow-sm"
          >
            <h2 className="text-lg font-bold text-gray-900 mb-4">⚡ エネルギー計算</h2>
            
            {/* BMR */}
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">基礎代謝量（BMR）</h3>
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-xs text-gray-500 mb-1">Mifflin-St Jeor式</p>
                <p className="text-sm font-mono text-gray-700 mb-2">{basis.energy.bmr.formula}</p>
                <p className="text-xs text-gray-500 mb-1">代入</p>
                <p className="text-sm font-mono text-gray-600 mb-2">{basis.energy.bmr.substituted}</p>
                <p className="text-lg font-bold text-orange-500">= {basis.energy.bmr.result_kcal} kcal</p>
              </div>
            </div>

            {/* PAL */}
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">活動係数（PAL）</h3>
              <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">仕事スタイルベース</span>
                  <span className="font-medium">{basis.energy.pal.base_from_work_style}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">運動による加算</span>
                  <span className="font-medium">+{basis.energy.pal.exercise_addition}</span>
                </div>
                {basis.energy.pal.capped && (
                  <p className="text-xs text-yellow-600">※ 上限2.5が適用されています</p>
                )}
                <div className="flex justify-between text-lg font-bold border-t border-gray-200 pt-2">
                  <span className="text-gray-700">PAL</span>
                  <span className="text-orange-500">{basis.energy.pal.result}</span>
                </div>
              </div>
            </div>

            {/* TDEE */}
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">総消費エネルギー（TDEE）</h3>
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-sm text-gray-600 mb-2">
                  BMR × PAL = {basis.energy.bmr.result_kcal} × {basis.energy.pal.result}
                </p>
                <p className="text-lg font-bold text-orange-500">= {basis.energy.tdee_kcal} kcal</p>
              </div>
            </div>

            {/* 目標調整 */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">目標による調整</h3>
              <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                <p className="text-sm text-gray-600">{basis.energy.goal_adjustment.reason}</p>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">調整</span>
                  <span className={`font-medium ${basis.energy.goal_adjustment.delta_kcal >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {basis.energy.goal_adjustment.delta_kcal >= 0 ? '+' : ''}{basis.energy.goal_adjustment.delta_kcal} kcal
                  </span>
                </div>
                {basis.energy.minimum_applied && (
                  <p className="text-xs text-yellow-600">
                    ※ 最低カロリー下限 ({basis.energy.minimum_value} kcal) が適用されています
                  </p>
                )}
                <div className="flex justify-between text-lg font-bold border-t border-gray-200 pt-2">
                  <span className="text-gray-700">最終目標</span>
                  <span className="text-orange-500">{basis.energy.final_kcal} kcal</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* PFC計算セクション */}
        {basis?.macros && (
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="bg-white rounded-2xl p-6 shadow-sm"
          >
            <h2 className="text-lg font-bold text-gray-900 mb-4">🥗 PFCバランス</h2>
            
            <div className="bg-gray-50 rounded-lg p-4 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">タンパク質 ({Math.round(basis.macros.ratios.protein * 100)}%)</span>
                <span className="font-medium">{basis.macros.grams.protein}g</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">脂質 ({Math.round(basis.macros.ratios.fat * 100)}%)</span>
                <span className="font-medium">{basis.macros.grams.fat}g</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">炭水化物 ({Math.round(basis.macros.ratios.carbs * 100)}%)</span>
                <span className="font-medium">{basis.macros.grams.carbs}g</span>
              </div>
            </div>

            {basis.macros.overrides && basis.macros.overrides.length > 0 && (
              <div className="mt-4 p-3 bg-blue-50 rounded-lg">
                <p className="text-xs font-semibold text-blue-700 mb-1">調整が適用されています:</p>
                {basis.macros.overrides.map((override, i) => (
                  <p key={i} className="text-xs text-blue-600">
                    • {override.reason}
                  </p>
                ))}
              </div>
            )}
          </motion.div>
        )}

        {/* ビタミン・ミネラル参照セクション */}
        {basis?.references && (
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="bg-white rounded-2xl p-6 shadow-sm"
          >
            <h2 className="text-lg font-bold text-gray-900 mb-2">💊 ビタミン・ミネラル</h2>
            <p className="text-xs text-gray-500 mb-4">
              日本人の食事摂取基準（2020年版）に基づく参照値
            </p>
            
            <div className="space-y-3">
              {Object.entries(basis.references).map(([key, ref]) => {
                const info = NUTRIENT_INFO[key];
                if (!info) return null;
                
                const hasAdjustments = ref.adjustments && ref.adjustments.length > 0;
                
                return (
                  <div key={key} className="border-b border-gray-100 pb-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-700">{info.label}</span>
                      <div className="text-right">
                        <span className="font-medium text-gray-900">
                          {ref.final_value} {info.unit}
                        </span>
                        <span className="ml-2 text-xs px-1.5 py-0.5 bg-gray-100 rounded text-gray-600">
                          {BASIS_TYPE_LABELS[ref.basis_type] || ref.basis_type}
                        </span>
                      </div>
                    </div>
                    {hasAdjustments && (
                      <div className="mt-1 text-xs text-orange-600">
                        ※ {ref.adjustments![0].reason}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}

        {/* 持病・薬による調整 */}
        {basis?.health_adjustments && basis.health_adjustments.length > 0 && (
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.5 }}
            className="bg-white rounded-2xl p-6 shadow-sm"
          >
            <h2 className="text-lg font-bold text-gray-900 mb-4">🏥 健康状態による調整</h2>
            
            <div className="space-y-4">
              {basis.health_adjustments.map((adj, i) => (
                <div key={i} className="bg-red-50 rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-red-700 mb-2">{adj.condition}</h3>
                  <div className="space-y-1">
                    {adj.adjustments.map((item, j) => (
                      <p key={j} className="text-xs text-red-600">
                        • {NUTRIENT_INFO[item.nutrient]?.label || item.nutrient}: {item.original} → {item.adjusted} ({item.reason})
                      </p>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {/* 一次情報リンク */}
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="bg-white rounded-2xl p-6 shadow-sm"
        >
          <h2 className="text-lg font-bold text-gray-900 mb-4">📚 参照元</h2>
          <p className="text-sm text-gray-600 mb-4">
            この計算は厚生労働省「日本人の食事摂取基準（2020年版）」に基づいています。
          </p>
          <a
            href="https://www.mhlw.go.jp/stf/newpage_08517.html"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-orange-500 hover:text-orange-600 text-sm"
          >
            厚生労働省の公式ページを見る
            <Icons.ExternalLink className="w-4 h-4" />
          </a>
        </motion.div>

        {/* 開発者向け: 生のJSON表示 */}
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.7 }}
          className="bg-white rounded-2xl p-6 shadow-sm"
        >
          <button
            onClick={() => setShowRawJson(!showRawJson)}
            className="flex items-center justify-between w-full text-left"
          >
            <h2 className="text-lg font-bold text-gray-900">🔧 計算根拠JSON</h2>
            <Icons.ChevronDown className={`w-5 h-5 text-gray-400 transition-transform ${showRawJson ? 'rotate-180' : ''}`} />
          </button>
          
          {showRawJson && basis && (
            <div className="mt-4">
              <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs overflow-x-auto">
                {JSON.stringify(basis, null, 2)}
              </pre>
              <button
                onClick={() => navigator.clipboard.writeText(JSON.stringify(basis, null, 2))}
                className="mt-2 text-xs text-orange-500 hover:text-orange-600"
              >
                クリップボードにコピー
              </button>
            </div>
          )}
        </motion.div>

      </div>
    </div>
  );
}
