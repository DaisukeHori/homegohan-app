export function calculateNutritionTargets(profile: any) {
  if (!profile) {
    throw new Error("Profile is required");
  }

  const userId: string = profile.id;
  if (!userId) throw new Error("Profile.id is required");

  // 必要な情報がない場合はデフォルト値を使用
  const age = profile.age || 30;
  const gender = profile.gender || "unspecified";
  const height = profile.height || 165;
  const weight = profile.weight || 60;
  const workStyle = profile.work_style || "sedentary";
  const exerciseIntensity = profile.exercise_intensity || "moderate";
  const exerciseFrequency = profile.exercise_frequency || 3;
  const nutritionGoal = profile.nutrition_goal || "maintain";
  const weightChangeRate = profile.weight_change_rate || "moderate";
  const healthConditions: string[] = Array.isArray(profile.health_conditions) ? profile.health_conditions : [];
  const medications: string[] = Array.isArray(profile.medications) ? profile.medications : [];

  // 1. 基礎代謝（BMR）をMifflin-St Jeor式で計算
  let bmr: number;
  if (gender === "male") {
    bmr = 10 * weight + 6.25 * height - 5 * age + 5;
  } else if (gender === "female") {
    bmr = 10 * weight + 6.25 * height - 5 * age - 161;
  } else {
    // 性別不明の場合は中間値
    bmr = 10 * weight + 6.25 * height - 5 * age - 78;
  }

  // 2. 活動係数（PAL）を決定
  const workStylePAL: Record<string, number> = {
    sedentary: 1.2,
    light_active: 1.375,
    moderately_active: 1.55,
    very_active: 1.725,
    student: 1.375,
    homemaker: 1.375,
  };

  const exerciseBonus: Record<string, number> = {
    light: 0.05,
    moderate: 0.1,
    intense: 0.15,
    athlete: 0.25,
  };

  const frequencyMultiplier = exerciseFrequency / 3;
  const basePAL = workStylePAL[workStyle] || 1.375;
  const exerciseAddition = (exerciseBonus[exerciseIntensity] || 0.1) * frequencyMultiplier;
  const pal = Math.min(basePAL + exerciseAddition, 2.5);

  // 3. 総消費カロリー（TDEE）
  const tdee = Math.round(bmr * pal);

  // 4. 目標に応じたカロリー調整
  let targetCalories: number;
  let proteinRatio: number;
  let fatRatio: number;
  let carbsRatio: number;

  switch (nutritionGoal) {
    case "lose_weight": {
      const deficitMap: Record<string, number> = { slow: 300, moderate: 500, aggressive: 750 };
      const deficit = deficitMap[weightChangeRate] || 500;
      targetCalories = tdee - deficit;
      proteinRatio = 0.3;
      fatRatio = 0.25;
      carbsRatio = 0.45;
      break;
    }
    case "gain_muscle": {
      const surplusMap: Record<string, number> = { slow: 200, moderate: 350, aggressive: 500 };
      const surplus = surplusMap[weightChangeRate] || 350;
      targetCalories = tdee + surplus;
      proteinRatio = 0.3;
      fatRatio = 0.2;
      carbsRatio = 0.5;
      break;
    }
    case "athlete_performance": {
      targetCalories = tdee + 300;
      proteinRatio = 0.25;
      fatRatio = 0.25;
      carbsRatio = 0.5;
      break;
    }
    default: {
      targetCalories = tdee;
      proteinRatio = 0.2;
      fatRatio = 0.25;
      carbsRatio = 0.55;
    }
  }

  // 最低カロリーの保証
  targetCalories = Math.max(targetCalories, gender === "male" ? 1500 : 1200);

  // 5. マクロ栄養素の計算
  const proteinG = Math.round((targetCalories * proteinRatio) / 4);
  const fatG = Math.round((targetCalories * fatRatio) / 9);
  const carbsG = Math.round((targetCalories * carbsRatio) / 4);

  // 6. 持病・薬による調整（ベース値）
  let sodiumG = 7.0;
  let potassiumMg = 2500;
  let fiberG = 21;
  let fiberSolubleG = 7;
  let fiberInsolubleG = 14;
  let cholesterolMg = 300;
  let sugarG = 50;
  let calciumMg = 650;
  let ironMg = gender === "female" ? 10.5 : 7.5;
  let vitaminKUg = 150;

  if (healthConditions.includes("高血圧")) {
    sodiumG = 6.0;
    potassiumMg = 3500;
  }
  if (healthConditions.includes("糖尿病")) {
    sugarG = 25;
    carbsRatio = 0.4;
  }
  if (healthConditions.includes("脂質異常症")) {
    fatRatio = 0.2;
    cholesterolMg = 200;
  }
  if (healthConditions.includes("腎臓病")) {
    proteinRatio = 0.15;
    potassiumMg = 2000;
  }
  if (healthConditions.includes("心臓病")) {
    sodiumG = 6.0;
    cholesterolMg = 200;
  }
  if (healthConditions.includes("骨粗しょう症")) {
    calciumMg = 1000;
  }
  if (healthConditions.includes("貧血")) {
    ironMg = 15;
  }

  if (medications.includes("warfarin")) {
    vitaminKUg = 80;
  }
  if (medications.includes("antihypertensive")) {
    potassiumMg = Math.min(potassiumMg, 2500);
  }

  // 7. 推奨値ベース
  const vitaminB1Mg = targetCalories / 1000 * 0.54;
  const vitaminB2Mg = targetCalories / 1000 * 0.6;
  const vitaminB6Mg = 1.2;
  const vitaminB12Ug = 2.4;
  const vitaminCMg = 100;
  const vitaminDUg = 8.5;
  const vitaminEMg = gender === "male" ? 6.5 : 6.0;
  const vitaminAUg = gender === "male" ? 850 : 650;
  const folicAcidUg = 240;
  const zincMg = gender === "male" ? 11 : 8;
  const phosphorusMg = 800;
  const iodineUg = 130;

  // 脂肪酸
  const saturatedFatG = Math.round(targetCalories * 0.07 / 9);
  const monounsaturatedFatG = Math.round(targetCalories * 0.1 / 9);
  const polyunsaturatedFatG = Math.round(targetCalories * 0.08 / 9);

  const calculationBasis = {
    bmr: Math.round(bmr),
    pal: Math.round(pal * 100) / 100,
    tdee,
    goal: nutritionGoal,
    weightChangeRate,
    adjustments: { healthConditions, medications },
    calculatedAt: new Date().toISOString(),
  };

  const now = new Date().toISOString();
  const targetData = {
    user_id: userId,
    daily_calories: targetCalories,
    protein_g: proteinG,
    fat_g: fatG,
    carbs_g: carbsG,
    fiber_g: fiberG,
    fiber_soluble_g: fiberSolubleG,
    fiber_insoluble_g: fiberInsolubleG,
    sodium_g: sodiumG,
    sugar_g: sugarG,
    potassium_mg: potassiumMg,
    calcium_mg: calciumMg,
    phosphorus_mg: phosphorusMg,
    iron_mg: ironMg,
    zinc_mg: zincMg,
    iodine_ug: iodineUg,
    cholesterol_mg: cholesterolMg,
    vitamin_b1_mg: Math.round(vitaminB1Mg * 100) / 100,
    vitamin_b2_mg: Math.round(vitaminB2Mg * 100) / 100,
    vitamin_c_mg: vitaminCMg,
    vitamin_b6_mg: vitaminB6Mg,
    vitamin_b12_ug: vitaminB12Ug,
    folic_acid_ug: folicAcidUg,
    vitamin_a_ug: vitaminAUg,
    vitamin_d_ug: vitaminDUg,
    vitamin_k_ug: vitaminKUg,
    vitamin_e_mg: vitaminEMg,
    saturated_fat_g: saturatedFatG,
    monounsaturated_fat_g: monounsaturatedFatG,
    polyunsaturated_fat_g: polyunsaturatedFatG,
    calculation_basis: calculationBasis,
    last_calculated_at: now,
    updated_at: now,
  };

  return {
    targetData,
    summary: {
      calories: targetCalories,
      protein: proteinG,
      fat: fatG,
      carbs: carbsG,
      fiber: fiberG,
      sodium: sodiumG,
      bmr: Math.round(bmr),
      pal: Math.round(pal * 100) / 100,
      tdee,
      goal: nutritionGoal,
    },
  };
}



