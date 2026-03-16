export type MacroRatios = {
  protein: number;
  fat: number;
  carbs: number;
};

export type DerivedMacroTargets = {
  proteinG: number;
  fatG: number;
  carbsG: number;
};

export type GoalProjection =
  | {
      reachable: true;
      estimatedDate: string;
      estimatedDays: number;
      dailyEnergyGapKcal: number;
      weeklyWeightChangeKg: number;
      direction: "lose" | "gain";
    }
  | {
      reachable: false;
      reason: string;
    };

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function deriveMacroTargets(input: {
  dailyCalories: number;
  ratios: MacroRatios;
  currentWeightKg?: number | null;
  nutritionGoal?: string | null;
}): DerivedMacroTargets {
  const dailyCalories = Math.max(0, input.dailyCalories);
  const ratios = input.ratios;
  const proteinFloor =
    input.currentWeightKg && ["lose_weight", "gain_muscle", "athlete_performance"].includes(String(input.nutritionGoal))
      ? input.currentWeightKg * 1.2
      : 0;

  let proteinG = Math.max((dailyCalories * ratios.protein) / 4, proteinFloor);
  proteinG = Math.min(proteinG, dailyCalories / 4);

  const remainingAfterProtein = Math.max(dailyCalories - proteinG * 4, 0);
  let fatG = Math.min((dailyCalories * ratios.fat) / 9, remainingAfterProtein / 9);

  const remainingAfterFat = Math.max(remainingAfterProtein - fatG * 9, 0);
  const carbsG = remainingAfterFat / 4;

  return {
    proteinG: round1(proteinG),
    fatG: round1(fatG),
    carbsG: round1(carbsG),
  };
}

export function estimateGoalProjection(input: {
  currentWeightKg?: number | null;
  targetWeightKg?: number | null;
  dailyCalories?: number | null;
  tdeeKcal?: number | null;
  startDate?: Date;
}): GoalProjection {
  const currentWeightKg = Number(input.currentWeightKg);
  const targetWeightKg = Number(input.targetWeightKg);
  const dailyCalories = Number(input.dailyCalories);
  const tdeeKcal = Number(input.tdeeKcal);

  if (!Number.isFinite(currentWeightKg) || !Number.isFinite(targetWeightKg) || !Number.isFinite(dailyCalories) || !Number.isFinite(tdeeKcal)) {
    return { reachable: false, reason: "目標体重と目標カロリーを入れると到達予想日を表示できます。" };
  }

  const weightDiffKg = round1(targetWeightKg - currentWeightKg);
  if (weightDiffKg === 0) {
    return { reachable: false, reason: "現在体重と目標体重が同じです。" };
  }

  const dailyEnergyGapKcal = round1(dailyCalories - tdeeKcal);
  const wantsToLose = weightDiffKg < 0;

  if (wantsToLose && dailyEnergyGapKcal >= 0) {
    return { reachable: false, reason: "この目標カロリーだと減量方向になりません。" };
  }

  if (!wantsToLose && dailyEnergyGapKcal <= 0) {
    return { reachable: false, reason: "この目標カロリーだと増量方向になりません。" };
  }

  const effectiveGap = Math.abs(dailyEnergyGapKcal);
  if (effectiveGap < 1) {
    return { reachable: false, reason: "差が小さすぎて到達予想日を計算できません。" };
  }

  const estimatedDays = Math.ceil((Math.abs(weightDiffKg) * 7700) / effectiveGap);
  const baseDate = input.startDate ?? new Date();
  const estimatedDate = new Date(baseDate);
  estimatedDate.setDate(baseDate.getDate() + estimatedDays);

  const weeklyWeightChangeKg = round1((effectiveGap * 7) / 7700);

  return {
    reachable: true,
    estimatedDate: estimatedDate.toISOString(),
    estimatedDays,
    dailyEnergyGapKcal,
    weeklyWeightChangeKg,
    direction: wantsToLose ? "lose" : "gain",
  };
}
