"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deriveMacroTargets, estimateGoalProjection, type MacroRatios } from "@/lib/nutrition-target-planner";
import type { CalculationBasis } from "@homegohan/core";

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

export function NutritionTargetPlanner({ mode = "default" }: { mode?: PlannerMode }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [profile, setProfile] = useState<PlannerProfile | null>(null);
  const [targets, setTargets] = useState<PlannerTargets | null>(null);
  const [autoCalculate, setAutoCalculate] = useState(true);
  const [manualCalories, setManualCalories] = useState("");
  const [targetWeight, setTargetWeight] = useState("");
  const [revealCount, setRevealCount] = useState(0);

  const fetchPlannerData = async () => {
    setLoading(true);
    setError(null);
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

      setProfile(profileJson);
      setTargets(targetJson.targets as PlannerTargets);
      setAutoCalculate(Boolean(targetJson.targets?.autoCalculate ?? true));
      setManualCalories(String(targetJson.targets?.dailyCalories ?? ""));
      setTargetWeight(
        profileJson?.target_weight != null && Number.isFinite(profileJson.target_weight)
          ? String(profileJson.target_weight)
          : "",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "読み込みに失敗しました。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchPlannerData();
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

    setSaving(true);
    setSavedMessage(null);
    setError(null);

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

      await fetchPlannerData();
      setSavedMessage(autoCalculate ? "自動計算の目標に戻しました。" : "手動の栄養目標を保存しました。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setSaving(false);
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

  return (
    <section className="space-y-4">
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
                min="1000"
                max="5000"
                step="1"
                value={autoCalculate ? String(targets.dailyCalories) : manualCalories}
                onChange={(event) => setManualCalories(event.target.value)}
                disabled={autoCalculate}
              />
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
            <Button onClick={() => void handleSave()} disabled={saving}>
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
