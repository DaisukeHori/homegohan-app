// @vitest-environment node
/**
 * #2025: 野菜スコア (planned_meals.veg_score) の尺度の正本 supabase/functions/_shared/veg-score.ts (Edge) と、
 * Web / モバイル用の写し packages/shared/src/planned-meals-integrity.ts の一致、と計算の境界を見る。
 * 設計: docs/design/cross/23-planned-meals-score-integrity.md §6.3・§7.5・§7.6・§7.22・§13
 *
 * Edge の module (Deno) は Node で import せず、ファイルの文面を ts.transpileModule で CommonJS にして評価する。
 *
 * 段 A (設計書 §15): 定数の一致と vegScoreOfVegetableGrams / nutritionScoreOfVegScoreAverage。
 * 段 B: PLANNED_MEAL_NOT_FOUND_CODE と analyze-meal-photo/index.ts の一致・org-challenges.ts の targetMax。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  PLANNED_MEAL_NOT_FOUND_CODE,
  VEG_SCORE_MAX as SHARED_VEG_SCORE_MAX,
  VEG_SCORE_MIN as SHARED_VEG_SCORE_MIN,
} from '@homegohan/shared';
import { ORG_CHALLENGE_TYPE_META } from '@/lib/org-challenges';

const ROOT = path.resolve(__dirname, '..');
const EDGE_VEG_SCORE_PATH = path.join(ROOT, 'supabase', 'functions', '_shared', 'veg-score.ts');
/** 写真の解析の Edge Function (本人の行が見つからないときの文を、packages/shared を import せずに自分で定義する。§7.15) */
const ANALYZE_MEAL_PHOTO_PATH = path.join(ROOT, 'supabase', 'functions', 'analyze-meal-photo', 'index.ts');
/** org-challenges.ts の targetMax を VEG_SCORE_MAX から読むこと (数の直書きでない) を見る文 */
const ORG_CHALLENGES_PATH = path.join(ROOT, 'src', 'lib', 'org-challenges.ts');

/** veg-score.ts が export するもの (評価した module の exports の形) */
interface EdgeVegScoreModule {
  VEG_SCORE_MIN: number;
  VEG_SCORE_MAX: number;
  VEG_SCORE_FULL_MARK_GRAMS: number;
  NUTRITION_SCORE_PER_VEG_SCORE: number;
  vegScoreOfVegetableGrams: (vegetableGrams: number) => number;
  nutritionScoreOfVegScoreAverage: (vegScoreAverage: number) => number;
}

/** veg-score.ts を CommonJS に変換し、import の無い module として評価する (何も import しないことは §7.6 の決まり) */
function loadEdgeVegScore(): EdgeVegScoreModule {
  const source = fs.readFileSync(EDGE_VEG_SCORE_PATH, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: EDGE_VEG_SCORE_PATH,
  });
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  vm.runInNewContext(outputText, { module: moduleObject, exports: moduleObject.exports, Math, Number });
  const exported = moduleObject.exports;
  const numberExport = (name: string): number => {
    const value = exported[name];
    if (typeof value !== 'number') throw new Error(`veg-score.ts の ${name} が数でない: ${String(value)}`);
    return value;
  };
  const numericFunctionExport = (name: string): ((input: number) => number) => {
    const fn = exported[name];
    if (typeof fn !== 'function') throw new Error(`veg-score.ts の ${name} が関数でない`);
    return (input: number) => {
      const result: unknown = Reflect.apply(fn, undefined, [input]);
      if (typeof result !== 'number') throw new Error(`veg-score.ts の ${name}(${input}) が数を返さない: ${String(result)}`);
      return result;
    };
  };
  return {
    VEG_SCORE_MIN: numberExport('VEG_SCORE_MIN'),
    VEG_SCORE_MAX: numberExport('VEG_SCORE_MAX'),
    VEG_SCORE_FULL_MARK_GRAMS: numberExport('VEG_SCORE_FULL_MARK_GRAMS'),
    NUTRITION_SCORE_PER_VEG_SCORE: numberExport('NUTRITION_SCORE_PER_VEG_SCORE'),
    vegScoreOfVegetableGrams: numericFunctionExport('vegScoreOfVegetableGrams'),
    nutritionScoreOfVegScoreAverage: numericFunctionExport('nutritionScoreOfVegScoreAverage'),
  };
}

const edge = loadEdgeVegScore();

describe('#2025 野菜スコアの尺度の一致', () => {
  it('veg-score.ts は何も import しない (Edge と Node の両方で同じ文面を読むため)', () => {
    const source = fs.readFileSync(EDGE_VEG_SCORE_PATH, 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });

  it('packages/shared と _shared/veg-score.ts の VEG_SCORE_MIN / VEG_SCORE_MAX は同じ値', () => {
    expect(edge.VEG_SCORE_MIN).toBe(SHARED_VEG_SCORE_MIN);
    expect(edge.VEG_SCORE_MAX).toBe(SHARED_VEG_SCORE_MAX);
    expect(edge.VEG_SCORE_MIN).toBe(0);
    expect(edge.VEG_SCORE_MAX).toBe(100);
  });
});

describe('#2025 野菜スコアの計算 (veg-score.ts)', () => {
  it('vegScoreOfVegetableGrams: 0 g → 0・60 g → 50・120 g → 100・240 g → 100 (上限)・NaN / 負 → 0・整数を返す', () => {
    expect(edge.vegScoreOfVegetableGrams(0)).toBe(0);
    expect(edge.vegScoreOfVegetableGrams(60)).toBe(50);
    expect(edge.vegScoreOfVegetableGrams(edge.VEG_SCORE_FULL_MARK_GRAMS)).toBe(edge.VEG_SCORE_MAX);
    expect(edge.vegScoreOfVegetableGrams(120)).toBe(100);
    expect(edge.vegScoreOfVegetableGrams(240)).toBe(100);
    expect(edge.vegScoreOfVegetableGrams(Number.NaN)).toBe(0);
    expect(edge.vegScoreOfVegetableGrams(Number.POSITIVE_INFINITY)).toBe(0);
    expect(edge.vegScoreOfVegetableGrams(-30)).toBe(0);
    // 端数は四捨五入した整数 (1 g → 0.83 → 1・100 g → 83.3 → 83)
    for (const grams of [1, 37, 100, 119]) {
      const score = edge.vegScoreOfVegetableGrams(grams);
      expect(Number.isInteger(score), `${grams} g`).toBe(true);
      expect(score, `${grams} g`).toBe(Math.round((grams / 120) * 100));
    }
  });

  it('nutritionScoreOfVegScoreAverage: 70 → 70・100 → 100・0 → 0・NaN → 0 (係数は 100 / VEG_SCORE_MAX)', () => {
    expect(edge.NUTRITION_SCORE_PER_VEG_SCORE).toBe(100 / edge.VEG_SCORE_MAX);
    expect(edge.nutritionScoreOfVegScoreAverage(70)).toBe(70);
    expect(edge.nutritionScoreOfVegScoreAverage(100)).toBe(100);
    expect(edge.nutritionScoreOfVegScoreAverage(0)).toBe(0);
    expect(edge.nutritionScoreOfVegScoreAverage(Number.NaN)).toBe(0);
    // 小数第 1 位の平均は四捨五入した整数に
    expect(edge.nutritionScoreOfVegScoreAverage(66.7)).toBe(67);
  });
});

describe('#2025 段 B: Edge と Web の文・目標値の上限の一致', () => {
  it('PLANNED_MEAL_NOT_FOUND_CODE は analyze-meal-photo/index.ts の定数と同じ文', () => {
    const source = fs.readFileSync(ANALYZE_MEAL_PHOTO_PATH, 'utf8');
    const declared = [...source.matchAll(/^const PLANNED_MEAL_NOT_FOUND_CODE = '([^']*)'/gm)].map((m) => m[1]);
    expect(declared).toEqual([PLANNED_MEAL_NOT_FOUND_CODE]);
    // 本人の行が見つからないときは、その定数で投げる (文を直書きしない)
    expect(source).toContain('throw new Error(PLANNED_MEAL_NOT_FOUND_CODE)');
  });

  it('src/lib/org-challenges.ts の veg_score の targetMax は VEG_SCORE_MAX', () => {
    expect(ORG_CHALLENGE_TYPE_META.veg_score.targetMax).toBe(SHARED_VEG_SCORE_MAX);
    expect(ORG_CHALLENGE_TYPE_META.veg_score.targetMax).toBe(edge.VEG_SCORE_MAX);
    // 値が同じ 100 の直書きでなく、定数から読む (尺度を変えたときに追随する)
    const source = fs.readFileSync(ORG_CHALLENGES_PATH, 'utf8');
    const vegBlock = /\n  veg_score: \{[\s\S]*?\n  \},/.exec(source)?.[0] ?? '';
    expect(vegBlock).toContain('targetMax: VEG_SCORE_MAX,');
  });
});
