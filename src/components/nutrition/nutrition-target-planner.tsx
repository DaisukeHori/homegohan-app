"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deriveMacroTargets, estimateGoalProjection, type MacroRatios } from "@/lib/nutrition-target-planner";
import {
  MAX_MANUAL_CALORIES, MIN_MANUAL_CALORIES, getBmrWarning, getManualCalorieError,
} from "@/lib/nutrition-target-validation";
import type { CalculationBasis } from "@homegohan/core";
import {
  useAiConsultationDataRefetch,
  useAiConsultationLoading,
  type AiConsultationFetchTicket,
} from "@/hooks/useAiConsultationDataRefetch";
import { AI_CONSULTATION_UNEDITED_INPUTS_PROPS } from "@/lib/ai/consultation-data-refetch";

type PlannerMode = "default" | "onboarding";

interface PlannerProfile {
  target_weight?: number | null;
  weight?: number | null;
  nutrition_goal?: string | null;
  target_date?: string | null;
}

interface PlannerTargets {
  dailyCalories: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  fiberG?: number | null;
  sodiumG?: number | null;
  sugarG?: number | null;
  potassiumMg?: number | null;
  calciumMg?: number | null;
  phosphorusMg?: number | null;
  ironMg?: number | null;
  zincMg?: number | null;
  iodineUg?: number | null;
  cholesterolMg?: number | null;
  vitaminB1Mg?: number | null;
  vitaminB2Mg?: number | null;
  vitaminB6Mg?: number | null;
  vitaminB12Ug?: number | null;
  folicAcidUg?: number | null;
  vitaminCMg?: number | null;
  vitaminAUg?: number | null;
  vitaminDUg?: number | null;
  vitaminKUg?: number | null;
  vitaminEMg?: number | null;
  saturatedFatG?: number | null;
  autoCalculate?: boolean;
  calculationBasis?: CalculationBasis | null;
}

/** 入力欄の値 (目標の決め方・目標カロリー・目標体重)。取得した値から作り、利用者が変える */
interface PlannerForm {
  autoCalculate: boolean;
  manualCalories: string;
  targetWeight: string;
}

/** 取得した値から作る入力欄の値 (読み込んだとき・取り直したときに入力欄へ置く値) */
function plannerFormOf(profile: PlannerProfile | null | undefined, targets: PlannerTargets | null | undefined): PlannerForm {
  return {
    autoCalculate: Boolean(targets?.autoCalculate ?? true),
    manualCalories: String(targets?.dailyCalories ?? ""),
    targetWeight:
      profile?.target_weight != null && Number.isFinite(profile.target_weight) ? String(profile.target_weight) : "",
  };
}

function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function getRatios(targets: PlannerTargets): MacroRatios {
  const basisRatios = targets.calculationBasis?.macros?.ratios;
  if (basisRatios) {
    return {
      protein: basisRatios.protein,
      fat: basisRatios.fat,
      carbs: basisRatios.carbs,
    };
  }

  const total = targets.dailyCalories || 1;
  const protein = ((targets.proteinG || 0) * 4) / total;
  const fat = ((targets.fatG || 0) * 9) / total;
  const carbs = ((targets.carbsG || 0) * 4) / total;
  const ratioTotal = protein + fat + carbs;

  if (ratioTotal <= 0) {
    return { protein: 0.3, fat: 0.25, carbs: 0.45 };
  }

  return {
    protein: protein / ratioTotal,
    fat: fat / ratioTotal,
    carbs: carbs / ratioTotal,
  };
}

/** 開いたとき・保存のあとの読み込み (読み込み中の表示を出す) か、AI 相談の成功の取り直し (出さない・失敗では今の表示を残す) か */
type PlannerFetchMode = "mount" | "refetch";

export function NutritionTargetPlanner({ mode = "default" }: { mode?: PlannerMode }) {
  // 開いたとき・保存のあとの読み込み中の表示。その読み込み中に始まった AI 相談の成功の取り直しは、その読み込みの役
  // (失敗の表示・読み込み中の表示を下ろす) を引き継ぐ (#2201 U1。useAiConsultationLoading)
  const { loading, setLoading, refetchReadMode, settleLoading } = useAiConsultationLoading();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [profile, setProfile] = useState<PlannerProfile | null>(null);
  const [targets, setTargets] = useState<PlannerTargets | null>(null);
  const [autoCalculate, setAutoCalculate] = useState(true);
  const [manualCalories, setManualCalories] = useState("");
  const [targetWeight, setTargetWeight] = useState("");
  const [revealCount, setRevealCount] = useState(0);
  // 最後に取得した値から作った入力欄の値。今の入力欄の値と同じ間は「何も変えていない」(AI 相談の成功で取り直してよい。#2195 V1)
  const [fetchedForm, setFetchedForm] = useState<PlannerForm | null>(null);

  // 保存 (目標体重・栄養目標の書き込み) の応答を待っている間 (#2201 U2)。この間に来た AI 相談の成功では取り直さず、
  // 保存が終わったら 1 回取り直す (保存の前の値を読んだ取り直しの応答が、保存した値の表示を戻さないため)
  const writeInFlightRef = useRef(false);

  /**
   * プロフィールと栄養目標を読む。mode が 'refetch' (AI 相談の成功の取り直し。#2201 U1) なら、読み込み中の表示を出さずに読み直し、
   * 失敗 (通信の失敗・非 2xx) では失敗の文に切り替えずに今の表示を残す。応答を置くのは最後に始めた取得 (ticket.isLatest()) だけ。
   * 取り直しでは応答を待つあいだも入力欄が出ているので、その間に入力欄を変えていたら (下の section の印が外れて番兵が立つ)・
   * 保存を始めていたら、応答を置かない (打ちかけの値を取得した値で上書きしない。ticket.deferIfHeld。元に戻した・保存が終わったあとに
   * 1 回取り直す)
   */
  const fetchPlannerData = async (ticket: AiConsultationFetchTicket, mode: PlannerFetchMode = "mount") => {
    if (mode === "mount") {
      setLoading(true);
      setError(null);
    }
    try {
      const [profileRes, targetRes] = await Promise.all([
        fetch("/api/profile", { cache: "no-store" }),
        fetch("/api/nutrition/targets", { cache: "no-store" }),
      ]);

      if (!profileRes.ok || !targetRes.ok) {
        throw new Error("栄養目標データを取得できませんでした。");
      }

      const profileJson = await profileRes.json();
      const targetJson = await targetRes.json();
      if (!ticket.isLatest()) return;
      if (mode === "refetch" && ticket.deferIfHeld()) return;

      const nextForm = plannerFormOf(profileJson, targetJson.targets);
      setProfile(profileJson);
      setTargets(targetJson.targets as PlannerTargets);
      setFetchedForm(nextForm);
      setAutoCalculate(nextForm.autoCalculate);
      setManualCalories(nextForm.manualCalories);
      setTargetWeight(nextForm.targetWeight);
    } catch (err) {
      if (mode === "mount" && ticket.isLatest()) {
        setError(err instanceof Error ? err.message : "読み込みに失敗しました。");
      }
    } finally {
      settleLoading(ticket);
    }
  };

  // AI 相談の提案の実行で栄養目標・目標体重が変わったら取り直す (#2195 V1)。
  // 入力欄を変えている間・保存の応答を待つ間は取り直さず (下の section の印を外すので、入力欄が取り直しを止める)、
  // 元に戻した・保存が終わったあとに 1 回取り直す (#2201 U2)。取り直しの応答を待つあいだに変え始めたときも同じ (fetchPlannerData)
  const { beginFetch, notifyWriteSettled } = useAiConsultationDataRefetch(
    (ticket) => fetchPlannerData(ticket, refetchReadMode()),
    { writeInFlightRef },
  );

  useEffect(() => {
    void fetchPlannerData(beginFetch());
    // 開いたときに 1 回だけ読む (これまでどおり)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!targets?.calculationBasis || mode !== "onboarding") return;
    setRevealCount(0);
    const timeouts = [0, 1, 2, 3, 4].map((index) =>
      window.setTimeout(() => setRevealCount(index + 1), 350 + index * 500),
    );
    return () => timeouts.forEach((id) => window.clearTimeout(id));
  }, [mode, targets?.calculationBasis]);

  const manualCaloriesNumber = useMemo(() => {
    const parsed = Number(manualCalories);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [manualCalories]);

  const previewCalories = autoCalculate
    ? targets?.dailyCalories ?? 0
    : manualCaloriesNumber;

  // #1055 UX3-19: 手動カロリー調整に範囲検証が無く 500kcal 等でも保存できてしまっていたための対応
  const manualCalorieError = useMemo(() => {
    if (autoCalculate) return null;
    return getManualCalorieError(manualCalories, manualCaloriesNumber);
  }, [autoCalculate, manualCalories, manualCaloriesNumber]);

  const bmrWarning = useMemo(() => {
    if (autoCalculate || manualCalorieError) return null;
    return getBmrWarning(manualCaloriesNumber, targets?.calculationBasis?.energy?.bmr?.result_kcal);
  }, [autoCalculate, manualCalorieError, manualCaloriesNumber, targets?.calculationBasis?.energy?.bmr?.result_kcal]);

  const previewMacros = useMemo(() => {
    if (!targets) return null;
    return deriveMacroTargets({
      dailyCalories: previewCalories,
      ratios: getRatios(targets),
      currentWeightKg: profile?.weight,
      nutritionGoal: profile?.nutrition_goal,
    });
  }, [previewCalories, profile?.nutrition_goal, profile?.weight, targets]);

  const projection = useMemo(() => {
    if (!targets?.calculationBasis?.energy) return null;
    return estimateGoalProjection({
      currentWeightKg: profile?.weight,
      targetWeightKg: targetWeight ? Number(targetWeight) : null,
      dailyCalories: previewCalories,
      tdeeKcal: targets.calculationBasis.energy.tdee_kcal,
    });
  }, [previewCalories, profile?.weight, targetWeight, targets?.calculationBasis]);

  const handleSave = async () => {
    if (!targets || !previewMacros) return;
    // #1055 UX3-19: 手動カロリー調整の範囲外保存を拒否する
    if (manualCalorieError) return;

    setSaving(true);
    setSavedMessage(null);
    setError(null);
    writeInFlightRef.current = true;

    try {
      const profileNeedsUpdate =
        String(profile?.target_weight ?? "") !== String(targetWeight || "");

      if (profileNeedsUpdate) {
        const profileRes = await fetch("/api/profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetWeight: targetWeight ? Number(targetWeight) : null,
          }),
        });

        if (!profileRes.ok) {
          throw new Error("目標体重の保存に失敗しました。");
        }
      }

      if (autoCalculate) {
        const res = await fetch("/api/nutrition-targets/calculate", {
          method: "POST",
        });
        if (!res.ok) {
          throw new Error("栄養目標の再計算に失敗しました。");
        }
      } else {
        const basisWithOverride = {
          ...(targets.calculationBasis ?? {}),
          manual_override: {
            enabled: true,
            original_daily_calories: targets.dailyCalories,
            overridden_daily_calories: previewCalories,
            estimated_goal_date:
              projection && projection.reachable ? projection.estimatedDate : null,
            saved_at: new Date().toISOString(),
          },
        };

        const res = await fetch("/api/nutrition/targets", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            autoCalculate: false,
            dailyCalories: previewCalories,
            proteinG: previewMacros.proteinG,
            fatG: previewMacros.fatG,
            carbsG: previewMacros.carbsG,
            fiberG: targets.fiberG,
            sodiumG: targets.sodiumG,
            sugarG: targets.sugarG,
            potassiumMg: targets.potassiumMg,
            calciumMg: targets.calciumMg,
            phosphorusMg: targets.phosphorusMg,
            ironMg: targets.ironMg,
            zincMg: targets.zincMg,
            iodineUg: targets.iodineUg,
            cholesterolMg: targets.cholesterolMg,
            vitaminB1Mg: targets.vitaminB1Mg,
            vitaminB2Mg: targets.vitaminB2Mg,
            vitaminB6Mg: targets.vitaminB6Mg,
            vitaminB12Ug: targets.vitaminB12Ug,
            folicAcidUg: targets.folicAcidUg,
            vitaminCMg: targets.vitaminCMg,
            vitaminAUg: targets.vitaminAUg,
            vitaminDUg: targets.vitaminDUg,
            vitaminKUg: targets.vitaminKUg,
            vitaminEMg: targets.vitaminEMg,
            saturatedFatG: targets.saturatedFatG,
            calculationBasis: basisWithOverride,
            lastCalculatedAt: new Date().toISOString(),
          }),
        });

        if (!res.ok) {
          throw new Error("手動の栄養目標を保存できませんでした。");
        }
      }

      await fetchPlannerData(beginFetch());
      setSavedMessage(autoCalculate ? "自動計算の目標に戻しました。" : "手動の栄養目標を保存しました。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setSaving(false);
      writeInFlightRef.current = false;
      notifyWriteSettled();
    }
  };

  if (loading) {
    return (
      <div className="rounded-[28px] border border-orange-100 bg-white/90 p-6 shadow-sm">
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
          栄養目標を読み込み中...
        </div>
      </div>
    );
  }

  if (error || !targets) {
    return (
      <div className="rounded-[28px] border border-red-100 bg-red-50 p-6 text-sm text-red-700">
        {error ?? "栄養目標を表示できませんでした。"}
      </div>
    );
  }

  const energy = targets.calculationBasis?.energy;
  const steps = energy
    ? [
        { label: "BMR", value: `${energy.bmr.result_kcal} kcal`, note: "基礎代謝" },
        { label: "PAL", value: `${energy.pal.result}`, note: "活動係数" },
        { label: "TDEE", value: `${energy.tdee_kcal} kcal`, note: "1日の消費量" },
        { label: "調整", value: `${energy.goal_adjustment.delta_kcal >= 0 ? "+" : ""}${energy.goal_adjustment.delta_kcal} kcal`, note: energy.goal_adjustment.reason },
        { label: "目標", value: `${previewCalories} kcal`, note: autoCalculate ? "自動計算" : "手動調整" },
      ]
    : [];

  // 入力欄の値が取得した値のまま (何も変えていない) か。そうなら包む要素に印を付け、AI 相談の成功で取り直してよいことにする
  // (取り直しで失う打ちかけの値が無い。#2195 V1。src/lib/ai/consultation-data-refetch.ts の AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE)
  const formUnedited =
    fetchedForm !== null &&
    autoCalculate === fetchedForm.autoCalculate &&
    manualCalories === fetchedForm.manualCalories &&
    targetWeight === fetchedForm.targetWeight;

  return (
    <section className="space-y-4" {...(formUnedited ? AI_CONSULTATION_UNEDITED_INPUTS_PROPS : {})}>
      <div className="overflow-hidden rounded-[32px] border border-orange-100 bg-[radial-gradient(circle_at_top_left,_rgba(255,138,101,0.18),_transparent_36%),linear-gradient(135deg,_#fff7f2,_#ffffff_62%)] p-6 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-orange-500">
              {mode === "onboarding" ? "Nutrition Plan" : "Reconfigure"}
            </p>
            <h2 className="mt-2 text-2xl font-bold text-gray-900">
              {mode === "onboarding" ? "あなた専用の栄養プランができました" : "栄養目標を再設定する"}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">
              自動計算の根拠を見ながら、目標カロリーを自分で微調整できます。目標体重を入れておくと、今の設定での到達予想日も表示します。
            </p>
          </div>

          <div className="rounded-2xl bg-white px-4 py-3 text-right shadow-sm">
            <p className="text-xs text-gray-500">現在の目標</p>
            <p className="text-3xl font-bold text-orange-500">{previewCalories}</p>
            <p className="text-xs text-gray-500">kcal / day</p>
          </div>
        </div>

        {steps.length > 0 && (
          <div className="mt-6 grid gap-3 md:grid-cols-5">
            {steps.map((step, index) => {
              const active = mode === "onboarding" ? revealCount > index : true;
              return (
                <motion.div
                  key={step.label}
                  initial={mode === "onboarding" ? { opacity: 0.2, y: 12 } : false}
                  animate={{ opacity: active ? 1 : 0.25, y: active ? 0 : 12 }}
                  transition={{ duration: 0.35 }}
                  className="rounded-2xl border border-white/80 bg-white/90 p-4 shadow-sm"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400">{step.label}</p>
                  <p className="mt-2 text-xl font-bold text-gray-900">{step.value}</p>
                  <p className="mt-1 text-xs leading-5 text-gray-500">{step.note}</p>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.3fr_0.9fr]">
        <div className="rounded-[28px] border border-gray-100 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-bold text-gray-900">目標の決め方</h3>
              <p className="mt-1 text-sm text-gray-500">自動計算のまま使うか、カロリーだけ自分で微調整するか選べます。</p>
            </div>
            <div className="inline-flex rounded-full bg-orange-50 p-1">
              <button
                type="button"
                onClick={() => {
                  setAutoCalculate(true);
                  setManualCalories(String(targets.dailyCalories));
                }}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${autoCalculate ? "bg-orange-500 text-white" : "text-orange-600"}`}
              >
                自動計算
              </button>
              <button
                type="button"
                onClick={() => setAutoCalculate(false)}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${!autoCalculate ? "bg-orange-500 text-white" : "text-orange-600"}`}
              >
                手動調整
              </button>
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-medium text-gray-700">目標体重 (kg)</span>
              <Input
                type="number"
                min="30"
                max="250"
                step="0.1"
                value={targetWeight}
                onChange={(event) => setTargetWeight(event.target.value)}
                placeholder="例: 72"
              />
            </label>

            <label className="space-y-2">
              <span className="text-sm font-medium text-gray-700">目標カロリー (kcal)</span>
              <Input
                type="number"
                min={MIN_MANUAL_CALORIES}
                max={MAX_MANUAL_CALORIES}
                step="1"
                value={autoCalculate ? String(targets.dailyCalories) : manualCalories}
                onChange={(event) => setManualCalories(event.target.value)}
                disabled={autoCalculate}
              />
              {/* #1055 UX3-19: HTML min/max だけでは保存を防げていなかったため、明示的なエラー・警告を表示する */}
              {!autoCalculate && manualCalorieError && (
                <p className="text-xs font-medium text-red-600">{manualCalorieError}</p>
              )}
              {!autoCalculate && !manualCalorieError && bmrWarning && (
                <p className="text-xs font-medium text-amber-600">{bmrWarning}</p>
              )}
            </label>
          </div>

          <div className="mt-5 rounded-2xl bg-gray-50 p-4">
            <p className="text-sm font-semibold text-gray-700">PFCのプレビュー</p>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl bg-white p-4">
                <p className="text-xs text-gray-500">タンパク質</p>
                <p className="mt-1 text-2xl font-bold text-blue-600">{previewMacros?.proteinG ?? "-"}</p>
                <p className="text-xs text-gray-500">g</p>
              </div>
              <div className="rounded-2xl bg-white p-4">
                <p className="text-xs text-gray-500">脂質</p>
                <p className="mt-1 text-2xl font-bold text-amber-600">{previewMacros?.fatG ?? "-"}</p>
                <p className="text-xs text-gray-500">g</p>
              </div>
              <div className="rounded-2xl bg-white p-4">
                <p className="text-xs text-gray-500">炭水化物</p>
                <p className="mt-1 text-2xl font-bold text-emerald-600">{previewMacros?.carbsG ?? "-"}</p>
                <p className="text-xs text-gray-500">g</p>
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button onClick={() => void handleSave()} disabled={saving || !!manualCalorieError}>
              {saving ? "保存中..." : autoCalculate ? "自動計算に戻す" : "この設定を保存する"}
            </Button>
            <p className="text-xs text-gray-500">
              保存後は献立生成にもこの目標が反映されます。
            </p>
          </div>

          {savedMessage && (
            <p className="mt-3 text-sm font-medium text-emerald-600">{savedMessage}</p>
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded-[28px] border border-gray-100 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-bold text-gray-900">到達予想</h3>
            {projection && projection.reachable ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-2xl bg-orange-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-orange-500">Estimated</p>
                  <p className="mt-2 text-2xl font-bold text-gray-900">{formatDate(projection.estimatedDate)}</p>
                  <p className="mt-1 text-sm text-gray-600">
                    今の設定だと約 {projection.estimatedDays} 日で到達見込みです。
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl bg-gray-50 p-4">
                    <p className="text-xs text-gray-500">1日あたりの差</p>
                    <p className="mt-1 text-xl font-bold text-gray-900">
                      {projection.dailyEnergyGapKcal > 0 ? "+" : ""}
                      {projection.dailyEnergyGapKcal} kcal
                    </p>
                  </div>
                  <div className="rounded-2xl bg-gray-50 p-4">
                    <p className="text-xs text-gray-500">週あたりの変化目安</p>
                    <p className="mt-1 text-xl font-bold text-gray-900">
                      {projection.direction === "gain" ? "+" : "-"}
                      {projection.weeklyWeightChangeKg} kg
                    </p>
                  </div>
                </div>
                <p className="text-xs leading-5 text-gray-500">
                  予想日は 1kg ≒ 7700kcal の単純計算です。実際の体重変化は水分量や運動量で前後します。
                </p>
              </div>
            ) : (
              <div className="mt-4 rounded-2xl bg-gray-50 p-4 text-sm leading-6 text-gray-600">
                {projection?.reason ?? "目標体重と目標カロリーを入れると到達予想日を表示できます。"}
              </div>
            )}
          </div>

          <div className="rounded-[28px] border border-gray-100 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-bold text-gray-900">今の自動計算</h3>
            <div className="mt-4 space-y-3 text-sm text-gray-600">
              <div className="flex items-center justify-between">
                <span>消費カロリー (TDEE)</span>
                <span className="font-semibold text-gray-900">{energy?.tdee_kcal ?? "-"} kcal</span>
              </div>
              <div className="flex items-center justify-between">
                <span>目標タイプ</span>
                <span className="font-semibold text-gray-900">{energy?.goal_adjustment.reason ?? "-"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>自動計算の目標</span>
                <span className="font-semibold text-orange-500">{targets.dailyCalories} kcal</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
