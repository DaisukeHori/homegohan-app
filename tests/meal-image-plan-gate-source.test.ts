/**
 * 料理画像のプランの門 (billing/03 §8.8・S27) と、自動の料理画像を主菜の 1 品に絞る規則 (Q-16) のソースの走査
 * (§14.1 のテスト 111 の後半・153)。コメントを除いたソースで、呼び出しの順と置き場所を見る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** ブロックコメントと行コメントを除く (URL の「://」と文字列の中の「//」は残す) */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function read(rel: string): string {
  return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

/** name( で始まる関数の本文 (最初の「{」から対応する「}」まで) */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unterminated function: ${signature}`);
}

describe('billing/03 §8.8 料理画像のプランの門 (ソース)', () => {
  it('process-meal-image-jobs reads ai_plan_feature_daily_cap with meal_image_auto after the consent check and before generateImage, cancels the job with MEAL_IMAGE_SKIPPED_ERRORS.plan when locked, and save-meal.ts still does not call consume_ai_usage', () => {
    const source = read('supabase/functions/process-meal-image-jobs/index.ts');
    const processJob = functionBody(source, 'async function processJob(');
    const consentAt = processJob.indexOf('checkAiConsent(');
    const planAt = processJob.indexOf('readMealImageJobPlanDecision(');
    const generateAt = processJob.indexOf('generateImage(');
    expect(consentAt).toBeGreaterThanOrEqual(0);
    expect(planAt, '同意の判定のあとにプランの門').toBeGreaterThan(consentAt);
    expect(generateAt, 'プランの門のあとに画像を作る').toBeGreaterThan(planAt);
    // 門で止めたときは、ジョブを取り消して料理を skipped_plan にする
    const lockedBranch = processJob.slice(planAt, generateAt);
    expect(lockedBranch).toMatch(/===\s*"locked"/);
    expect(lockedBranch).toContain('MEAL_IMAGE_SKIPPED_ERRORS.plan');
    expect(lockedBranch).toMatch(/finalizeJob\([^)]*"cancelled"/);
    expect(lockedBranch).toContain('markDishFailure(');
    // 門は DB の ai_plan_feature_daily_cap を meal_image_auto で読み、答えは mealImageJobPlanDecision
    const reader = functionBody(source, 'async function readMealImageJobPlanDecision(');
    expect(reader).toMatch(/\.rpc\("ai_plan_feature_daily_cap",\s*\{\s*p_user_id:\s*ownerId,\s*p_feature:\s*"meal_image_auto"\s*\}\)/);
    expect(reader).toContain('mealImageJobPlanDecision(data)');
    // 献立の作成の保存は数えない (数えるのは入口の menu_generation の 1 回。F22)
    const saveMeal = read('supabase/functions/_shared/save-meal.ts');
    expect(saveMeal).not.toMatch(/consume_ai_usage|consumeAiUsage|consumeEdgeAiUsage/);
  });
});

describe('billing/03 Q-16 自動の料理画像は主菜の 1 品だけ (ソース)', () => {
  it('the weekly page falls back to the meal cover only through mealCoverRepresentsDish (no dish.image_url ?? meal.imageUrl), and reconcileDishImages narrows the jobs with autoImageDishIndexOf before it returns', () => {
    const page = read('src/app/(main)/menus/weekly/page.tsx');
    expect(page).not.toMatch(/dish\.image_url\s*\?\?\s*meal\.imageUrl/);
    expect(page).toMatch(/dish\.image_url\s*\?\?\s*\(mealCoverRepresentsDish\(dishesArray,\s*idx\)\s*\?\s*meal\.imageUrl\s*:\s*null\)/);
    expect(page).toMatch(/import \{ mealCoverRepresentsDish \} from "@\/lib\/meal-image";/);

    const mealImage = read('supabase/functions/_shared/meal-image.ts');
    const reconcile = functionBody(mealImage, 'export async function reconcileDishImages<');
    const narrowAt = reconcile.indexOf('autoImageDishIndexOf(dishes)');
    const filterAt = reconcile.indexOf('jobs = jobs.filter((job) => job.dishIndex === autoImageDishIndex)');
    const returnAt = reconcile.lastIndexOf('return {');
    const coverGateAt = reconcile.indexOf('isMealCoverHeldByImagelessPreservedDish(');
    expect(narrowAt).toBeGreaterThanOrEqual(0);
    expect(filterAt, '種を主菜の 1 品に絞る').toBeGreaterThan(narrowAt);
    expect(returnAt, '絞り込みのあとに返す').toBeGreaterThan(filterAt);
    expect(narrowAt, '献立のカバーの判定のあとに絞る').toBeGreaterThan(coverGateAt);
    // 主菜の引き継ぎは for の直後 (カバーの判定より前)
    const handoverAt = reconcile.indexOf('autoImageDishHandoverIndexOf(');
    expect(handoverAt).toBeGreaterThanOrEqual(0);
    expect(handoverAt).toBeLessThan(coverGateAt);
  });
});
