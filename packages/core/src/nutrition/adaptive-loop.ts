/**
 * Performance OS v3 - 7日ループ調整ロジック
 *
 * チェックインデータの7日移動平均に基づいて栄養目標を微調整する
 */

import type { PerformanceProfile, NutritionGoal } from './types';

// ================================================
// 型定義
// ================================================

/**
 * 7日間のチェックイン平均データ
 */
export interface CheckinAverages {
  sleepHoursAvg: number | null;
  sleepQualityAvg: number | null;
  fatigueAvg: number | null;
  focusAvg: number | null;
  trainingLoadAvg: number | null;
  hungerAvg: number | null;
  weightStart: number | null;
  weightEnd: number | null;
  checkinCount: number;
}

/**
 * 調整提案
 */
export interface AdjustmentRecommendation {
  type: 'calories' | 'protein' | 'carbs' | 'fat';
  delta: number;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  priority: number; // 1が最優先
}

/**
 * ループ分析結果
 */
export interface LoopAnalysisResult {
  eligible: boolean; // 調整可能かどうか（7日分のデータがあるか）
  eligibilityReason?: string;

  // トレンド分析
  trends: {
    weightChangePerWeek: number | null; // kg/week
    fatigueLevel: 'low' | 'normal' | 'high' | null;
    focusLevel: 'low' | 'normal' | 'high' | null;
    sleepQuality: 'poor' | 'average' | 'good' | null;
    trainingLoadTrend: 'low' | 'moderate' | 'high' | null;
    hungerLevel: 'low' | 'normal' | 'high' | null;
  };

  // 調整提案
  recommendations: AdjustmentRecommendation[];

  // 今日の一手（最優先の1つ）
  nextAction: {
    summary: string;
    details: string;
    actionType: 'increase_calories' | 'decrease_calories' | 'increase_protein' | 'increase_carbs' | 'maintain' | 'rest_priority';
  } | null;
}

// ================================================
// 分析ロジック
// ================================================

/**
 * 7日間のチェックインデータを分析し、調整提案を生成
 */
export function analyzeCheckinLoop(
  averages: CheckinAverages,
  currentTargets: {
    calories: number;
    protein: number;
    fat: number;
    carbs: number;
  },
  profile: {
    nutritionGoal: NutritionGoal;
    weight: number;
    performanceProfile?: PerformanceProfile | null;
  }
): LoopAnalysisResult {
  const { checkinCount, weightStart, weightEnd, fatigueAvg, focusAvg, sleepQualityAvg, trainingLoadAvg, hungerAvg } = averages;
  const { nutritionGoal, performanceProfile } = profile;

  // ================================================
  // 1. 資格チェック（7日分のデータがあるか）
  // ================================================
  if (checkinCount < 5) { // 最低5日分は必要
    return {
      eligible: false,
      eligibilityReason: `チェックインデータが不足しています（${checkinCount}/5日）`,
      trends: {
        weightChangePerWeek: null,
        fatigueLevel: null,
        focusLevel: null,
        sleepQuality: null,
        trainingLoadTrend: null,
        hungerLevel: null,
      },
      recommendations: [],
      nextAction: null,
    };
  }

  // ================================================
  // 2. トレンド分析
  // ================================================

  // 体重変化（週あたり）
  let weightChangePerWeek: number | null = null;
  if (weightStart !== null && weightEnd !== null) {
    weightChangePerWeek = weightEnd - weightStart;
  }

  // 疲労レベル (1-5スケール)
  let fatigueLevel: 'low' | 'normal' | 'high' | null = null;
  if (fatigueAvg !== null) {
    if (fatigueAvg <= 2) fatigueLevel = 'low';
    else if (fatigueAvg <= 3.5) fatigueLevel = 'normal';
    else fatigueLevel = 'high';
  }

  // 集中力レベル (1-5スケール)
  let focusLevel: 'low' | 'normal' | 'high' | null = null;
  if (focusAvg !== null) {
    if (focusAvg <= 2) focusLevel = 'low';
    else if (focusAvg <= 3.5) focusLevel = 'normal';
    else focusLevel = 'high';
  }

  // 睡眠の質 (1-5スケール)
  let sleepQuality: 'poor' | 'average' | 'good' | null = null;
  if (sleepQualityAvg !== null) {
    if (sleepQualityAvg <= 2) sleepQuality = 'poor';
    else if (sleepQualityAvg <= 3.5) sleepQuality = 'average';
    else sleepQuality = 'good';
  }

  // トレーニング負荷 (RPE 1-10)
  let trainingLoadTrend: 'low' | 'moderate' | 'high' | null = null;
  if (trainingLoadAvg !== null) {
    if (trainingLoadAvg <= 4) trainingLoadTrend = 'low';
    else if (trainingLoadAvg <= 7) trainingLoadTrend = 'moderate';
    else trainingLoadTrend = 'high';
  }

  // 空腹感 (1-5スケール)
  let hungerLevel: 'low' | 'normal' | 'high' | null = null;
  if (hungerAvg !== null) {
    if (hungerAvg <= 2) hungerLevel = 'low';
    else if (hungerAvg <= 3.5) hungerLevel = 'normal';
    else hungerLevel = 'high';
  }

  const trends = {
    weightChangePerWeek,
    fatigueLevel,
    focusLevel,
    sleepQuality,
    trainingLoadTrend,
    hungerLevel,
  };

  // ================================================
  // 3. 調整提案の生成
  // ================================================
  const recommendations: AdjustmentRecommendation[] = [];

  // 目標別の理想的な体重変化率
  const idealWeightChange = getIdealWeightChange(nutritionGoal, performanceProfile);

  // 体重ベースの調整
  if (weightChangePerWeek !== null) {
    const deviation = weightChangePerWeek - idealWeightChange.target;

    // 減量目標なのに体重が落ちていない/増えている
    if (nutritionGoal === 'lose_weight' && weightChangePerWeek > -0.1) {
      // 空腹感が高くなければカロリーを減らす
      if (hungerLevel !== 'high') {
        recommendations.push({
          type: 'calories',
          delta: -150,
          reason: `体重減少ペースが遅いです（週${weightChangePerWeek.toFixed(1)}kg）。カロリーを少し減らすことをお勧めします`,
          confidence: hungerLevel === 'low' ? 'high' : 'medium',
          priority: 1,
        });
      } else {
        // 空腹感が高い場合は維持を推奨
        recommendations.push({
          type: 'calories',
          delta: 0,
          reason: '空腹感が強いため、現在のカロリーを維持することをお勧めします。焦らず継続しましょう',
          confidence: 'medium',
          priority: 2,
        });
      }
    }

    // 減量目標で体重が落ちすぎ（週0.75kg以上）
    if (nutritionGoal === 'lose_weight' && weightChangePerWeek < -0.75) {
      recommendations.push({
        type: 'calories',
        delta: 100,
        reason: `体重減少ペースが速すぎます（週${Math.abs(weightChangePerWeek).toFixed(1)}kg）。筋量維持のためカロリーを少し増やすことをお勧めします`,
        confidence: 'high',
        priority: 1,
      });
    }

    // 筋肥大目標なのに体重が増えていない
    if (nutritionGoal === 'gain_muscle' && weightChangePerWeek < 0.1) {
      recommendations.push({
        type: 'calories',
        delta: 150,
        reason: `体重増加ペースが遅いです（週${weightChangePerWeek.toFixed(1)}kg）。カロリーを増やすことをお勧めします`,
        confidence: 'medium',
        priority: 1,
      });
    }

    // 筋肥大目標で体重が増えすぎ（週0.5kg以上）
    if (nutritionGoal === 'gain_muscle' && weightChangePerWeek > 0.5) {
      recommendations.push({
        type: 'calories',
        delta: -100,
        reason: `体重増加ペースが速すぎます（週${weightChangePerWeek.toFixed(1)}kg）。体脂肪増加を抑えるためカロリーを少し減らすことをお勧めします`,
        confidence: 'medium',
        priority: 2,
      });
    }
  }

  // 疲労・回復ベースの調整
  if (fatigueLevel === 'high' && trainingLoadTrend === 'high') {
    recommendations.push({
      type: 'carbs',
      delta: 30,
      reason: '疲労が蓄積しています。トレーニング負荷に対して炭水化物を増やし、回復を促進しましょう',
      confidence: 'medium',
      priority: 2,
    });
  }

  // 睡眠の質が悪い場合
  if (sleepQuality === 'poor') {
    recommendations.push({
      type: 'calories',
      delta: 0,
      reason: '睡眠の質が低下しています。まずは睡眠環境の改善を優先しましょう。カフェインの摂取時間にも注意してください',
      confidence: 'low',
      priority: 3,
    });
  }

  // 集中力低下 + 高トレ負荷 → 炭水化物不足の可能性
  if (focusLevel === 'low' && trainingLoadTrend !== 'low') {
    recommendations.push({
      type: 'carbs',
      delta: 20,
      reason: '集中力が低下しています。脳のエネルギー源である炭水化物を少し増やすことで改善する可能性があります',
      confidence: 'low',
      priority: 4,
    });
  }

  // 空腹感が高い + 減量目標 → タンパク質増加を提案
  if (hungerLevel === 'high' && nutritionGoal === 'lose_weight') {
    recommendations.push({
      type: 'protein',
      delta: 15,
      reason: '空腹感が強いです。タンパク質を増やすことで満腹感が持続しやすくなります',
      confidence: 'medium',
      priority: 2,
    });
  }

  // 競技特有の調整
  if (performanceProfile?.sport) {
    const { phase, demandVector } = performanceProfile.sport;

    // 試合期は炭水化物を優先
    if (phase === 'competition' && demandVector.endurance > 0.5) {
      recommendations.push({
        type: 'carbs',
        delta: 40,
        reason: '試合期に入っています。パフォーマンス発揮のため炭水化物を増やすことをお勧めします',
        confidence: 'high',
        priority: 1,
      });
    }

    // リカバリー期は睡眠・回復を優先
    if (phase === 'recovery') {
      recommendations.push({
        type: 'calories',
        delta: 100,
        reason: 'リカバリー期です。回復を促進するため、十分なカロリー摂取を心がけましょう',
        confidence: 'medium',
        priority: 2,
      });
    }
  }

  // 優先度でソート
  recommendations.sort((a, b) => a.priority - b.priority);

  // ================================================
  // 4. 今日の一手を決定
  // ================================================
  let nextAction: LoopAnalysisResult['nextAction'] = null;

  if (recommendations.length > 0) {
    const top = recommendations[0];
    nextAction = {
      summary: getActionSummary(top),
      details: top.reason,
      actionType: getActionType(top),
    };
  } else {
    // 特に調整不要
    nextAction = {
      summary: '順調です！このまま継続しましょう',
      details: '現在の食事プランは目標に沿って機能しています。引き続きチェックインを続けてください。',
      actionType: 'maintain',
    };
  }

  return {
    eligible: true,
    trends,
    recommendations,
    nextAction,
  };
}

// ================================================
// ヘルパー関数
// ================================================

function getIdealWeightChange(
  goal: NutritionGoal,
  profile?: PerformanceProfile | null
): { target: number; min: number; max: number } {
  switch (goal) {
    case 'lose_weight':
      // 週0.3〜0.7kgの減量が理想的
      return { target: -0.5, min: -0.7, max: -0.3 };
    case 'gain_muscle':
      // 週0.1〜0.3kgの増量が理想的
      return { target: 0.2, min: 0.1, max: 0.3 };
    case 'athlete_performance':
      // パフォーマンス目標は期によって異なる
      if (profile?.sport?.phase === 'cut') {
        return { target: -0.5, min: -1.0, max: -0.2 };
      }
      return { target: 0, min: -0.1, max: 0.1 };
    default:
      // 維持
      return { target: 0, min: -0.2, max: 0.2 };
  }
}

function getActionSummary(rec: AdjustmentRecommendation): string {
  if (rec.delta === 0) {
    return rec.type === 'calories' ? '現在のカロリーを維持' : `現在の${getTypeLabel(rec.type)}を維持`;
  }

  const direction = rec.delta > 0 ? '増やす' : '減らす';
  const amount = Math.abs(rec.delta);

  switch (rec.type) {
    case 'calories':
      return `カロリーを${amount}kcal${direction}`;
    case 'protein':
      return `タンパク質を${amount}g${direction}`;
    case 'carbs':
      return `炭水化物を${amount}g${direction}`;
    case 'fat':
      return `脂質を${amount}g${direction}`;
    default:
      return `${getTypeLabel(rec.type)}を調整`;
  }
}

function getTypeLabel(type: AdjustmentRecommendation['type']): string {
  switch (type) {
    case 'calories': return 'カロリー';
    case 'protein': return 'タンパク質';
    case 'carbs': return '炭水化物';
    case 'fat': return '脂質';
  }
}

type ActionType = 'increase_calories' | 'decrease_calories' | 'increase_protein' | 'increase_carbs' | 'maintain' | 'rest_priority';

function getActionType(rec: AdjustmentRecommendation): ActionType {
  if (rec.type === 'calories') {
    if (rec.delta > 0) return 'increase_calories';
    if (rec.delta < 0) return 'decrease_calories';
    return 'maintain';
  }
  if (rec.type === 'protein') return 'increase_protein';
  if (rec.type === 'carbs') return 'increase_carbs';
  return 'maintain';
}

/**
 * 調整提案を適用して新しい目標値を計算
 */
export function applyRecommendations(
  currentTargets: {
    calories: number;
    protein: number;
    fat: number;
    carbs: number;
  },
  recommendations: AdjustmentRecommendation[],
  options: {
    maxCalorieChange?: number; // デフォルト200
    applyTop?: number; // 上位N件のみ適用（デフォルト1）
  } = {}
): {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  appliedRecommendations: AdjustmentRecommendation[];
} {
  const { maxCalorieChange = 200, applyTop = 1 } = options;

  let { calories, protein, fat, carbs } = currentTargets;
  const appliedRecommendations: AdjustmentRecommendation[] = [];

  // 上位N件のみ適用
  const toApply = recommendations.slice(0, applyTop);

  for (const rec of toApply) {
    if (rec.delta === 0) continue;

    switch (rec.type) {
      case 'calories': {
        const clampedDelta = Math.max(-maxCalorieChange, Math.min(maxCalorieChange, rec.delta));
        calories = Math.max(1200, calories + clampedDelta);
        appliedRecommendations.push({ ...rec, delta: clampedDelta });
        break;
      }
      case 'protein':
        protein = Math.max(40, protein + rec.delta);
        appliedRecommendations.push(rec);
        break;
      case 'carbs':
        carbs = Math.max(50, carbs + rec.delta);
        appliedRecommendations.push(rec);
        break;
      case 'fat':
        fat = Math.max(20, fat + rec.delta);
        appliedRecommendations.push(rec);
        break;
    }
  }

  return {
    calories,
    protein,
    fat,
    carbs,
    appliedRecommendations,
  };
}
