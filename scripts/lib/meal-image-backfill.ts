/**
 * 料理画像を待ったまま (image_status が pending / stale) で、処理するジョブが無い料理に、ジョブを積み直す (#1505)
 *
 * 背景: 2026-10-12 まで、料理画像のジョブを積む処理が upsert (ON CONFLICT (idempotency_key)) で、冪等キーの一意な索引が
 * 部分索引のため 42P10 で必ず失敗していた (Next.js は #1487、Edge Function は #1505 で直した)。そのあいだに保存された料理は
 * 'pending' (前の料理から変わったものは 'stale') のまま、画像も処理するジョブも無く「生成中」に残っている。
 *
 * ここは判定と実行の部品だけを置く。コマンドは scripts/requeue-pending-meal-images.ts (既定は数えるだけの dry-run)。
 * 本番のデータへの一括の書き込みになるので、--apply での実行は Issue #1505 に書いた承認のあとに行う。
 *
 * 積み直す料理 (planDishImageJobs):
 *   - image_status が 'pending' か 'stale' (画像を待っている)
 *   - image_url が無い (画像がまだ無い)
 *   - image_source が 'generated_ai' か未設定 (AI が作る画像。写真・手で付けた画像・商品は対象外)
 *   - image_subject_hash がある (処理する側 process-meal-image-jobs は、料理の image_subject_hash とジョブの subject_hash が
 *     同じときだけ画像を書く。無い料理は保存し直さないと直らないので数えるだけにする)
 * プロンプト・モデルは、保存したときに料理に書いた image_prompt / image_model を使う (無ければ今の作り方・既定のモデル)。
 * 同じ料理のジョブが待ち・処理中なら、積み方 (enqueueMealImageJobs) が一意制約の違反 (23505) を重複として数え、行を増やさない。
 * 同意が無い利用者のジョブは、処理する側が AI へ送らずに取り消す (料理は 'failed' + 同意の理由になる)。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_MEAL_IMAGE_MODEL,
  buildDishImagePrompt,
  type EnqueueMealImageJobsResult,
  type MealImageDish,
  type MealImageJobSeed,
} from '../../supabase/functions/_shared/meal-image';
import { enqueueMealImageJobs, triggerMealImageJobProcessing } from '../../supabase/functions/_shared/meal-image-jobs.ts';

/** ジョブの trigger_source (どこから積んだかを、あとで meal_image_jobs から数えられるように) */
export const MEAL_IMAGE_BACKFILL_TRIGGER_SOURCE = 'backfill:requeue-pending-meal-images';

/** 積み直す料理の状態 (画像を待っている) */
export const MEAL_IMAGE_BACKFILL_TARGET_STATUSES = ['pending', 'stale'] as const;

/** 1 回の実行で積み直す献立の数の既定 (--max-meals を付けないとき)。少しずつ様子を見ながら進めるための小さな値 */
export const MEAL_IMAGE_BACKFILL_DEFAULT_MAX_MEALS = 50;

/**
 * 1 回の実行で積み直す献立の数の上限 (--max-meals はこれより大きくできない)。
 * 1 献立は料理 1〜数品 = 画像 1〜数枚。2026-10-12 の対象は料理 1,251 件で、1 回で全部を AI へ送らないための上限
 */
export const MEAL_IMAGE_BACKFILL_MAX_MEALS_LIMIT = 500;

/** 献立を読むときの 1 ページの行数 (PostgREST の既定の上限 1,000 行より小さく) */
export const MEAL_IMAGE_BACKFILL_PAGE_SIZE = 200;

/**
 * 献立ごとに処理を起こしたあとの待ち (ミリ秒)。画像を作る AI (Google) への要求を一度に集中させないため。
 * 運用で変えられるよう、環境変数 MEAL_IMAGE_BACKFILL_INTERVAL_MS で上書きできる
 */
export const MEAL_IMAGE_BACKFILL_DEFAULT_INTERVAL_MS = 10_000;

/** 積み直さない料理の理由 */
export type MealImageBackfillSkipReason = 'not_waiting' | 'has_image' | 'not_ai_image' | 'no_subject_hash' | 'not_object';

export interface DishImageJobPlan {
  seeds: MealImageJobSeed[];
  skipped: Record<MealImageBackfillSkipReason, number>;
}

function emptySkipCounts(): Record<MealImageBackfillSkipReason, number> {
  return { not_waiting: 0, has_image: 0, not_ai_image: 0, no_subject_hash: 0, not_object: 0 };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isWaitingStatus(value: unknown): boolean {
  return MEAL_IMAGE_BACKFILL_TARGET_STATUSES.some((status) => status === value);
}

/** 献立の料理 (planned_meals.dishes) から、積み直すジョブを作る (読むだけ。書き込みはしない) */
export function planDishImageJobs(dishes: unknown, triggerSource: string = MEAL_IMAGE_BACKFILL_TRIGGER_SOURCE): DishImageJobPlan {
  const plan: DishImageJobPlan = { seeds: [], skipped: emptySkipCounts() };
  if (!Array.isArray(dishes)) return plan;

  dishes.forEach((value: unknown, dishIndex) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      plan.skipped.not_object += 1;
      return;
    }
    const dish = value as MealImageDish;
    if (!isWaitingStatus(dish.image_status)) {
      plan.skipped.not_waiting += 1;
      return;
    }
    if (dish.image_url) {
      plan.skipped.has_image += 1;
      return;
    }
    const source = dish.image_source ?? null;
    if (source !== null && source !== 'generated_ai') {
      plan.skipped.not_ai_image += 1;
      return;
    }
    const subjectHash = nonEmptyString(dish.image_subject_hash);
    if (!subjectHash) {
      plan.skipped.no_subject_hash += 1;
      return;
    }
    plan.seeds.push({
      dishIndex,
      dishName: nonEmptyString(dish.name)?.trim() ?? `dish-${dishIndex + 1}`,
      subjectHash,
      prompt: nonEmptyString(dish.image_prompt) ?? buildDishImagePrompt(dish),
      model: nonEmptyString(dish.image_model) ?? DEFAULT_MEAL_IMAGE_MODEL,
      triggerSource,
      referenceImageUrls: [],
    });
  });
  return plan;
}

export interface MealImageBackfillOptions {
  /** false (既定) なら数えるだけで、何も書かない */
  apply: boolean;
  /** 積み直す献立の数の上限 (apply のとき。MEAL_IMAGE_BACKFILL_MAX_MEALS_LIMIT まで) */
  maxMeals: number;
  /** この日 (YYYY-MM-DD) 以降の献立だけ */
  since?: string | null;
  /** この利用者の献立だけ (試しに 1 人分で確かめるとき) */
  userId?: string | null;
  /** 積んだあとに process-meal-image-jobs を起こす (apply のとき)。起こさなければジョブは待ちのまま残る */
  trigger: boolean;
  /** 処理を起こしたあとの待ち (ミリ秒) */
  intervalMs: number;
  /** process-meal-image-jobs を起こすための接続先と鍵 (trigger のとき) */
  supabaseUrl?: string;
  serviceRoleKey?: string;
  /** 待ちの実装 (テストで差し替える) */
  sleep?: (ms: number) => Promise<void>;
}

export interface MealImageBackfillCandidate {
  plannedMealId: string;
  userId: string;
  dayDate: string;
  seeds: MealImageJobSeed[];
}

export interface MealImageBackfillReport {
  apply: boolean;
  /** 読んだ献立 (待ちの料理を含むもの) の数 */
  scannedMeals: number;
  /** 積み直す料理がある献立の数・料理の数 */
  candidateMeals: number;
  candidateDishes: number;
  /** 積み直さない料理の数 (理由ごと) */
  skipped: Record<MealImageBackfillSkipReason, number>;
  /** apply のとき: 積み直した献立の数と、行ごとの結果の合計・処理を起こした献立の数 */
  processedMeals: number;
  enqueue: EnqueueMealImageJobsResult;
  triggeredMeals: number;
}

interface PlannedMealRow {
  id: string;
  dishes: unknown;
  user_daily_meals: { user_id: string; day_date: string } | Array<{ user_id: string; day_date: string }> | null;
}

function dailyMealOf(row: PlannedMealRow): { user_id: string; day_date: string } | null {
  const value = row.user_daily_meals;
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * 待ちの料理を含む献立を読む (読むだけ)。料理の状態ごとに、jsonb の包含 (dishes @> [{"image_status": ...}]) で絞り、
 * id の順にページを送る。同じ献立が 2 つの状態に当たっても 1 回だけ数える
 */
async function loadWaitingMeals(admin: SupabaseClient, options: Pick<MealImageBackfillOptions, 'since' | 'userId'>): Promise<PlannedMealRow[]> {
  const byId = new Map<string, PlannedMealRow>();
  for (const status of MEAL_IMAGE_BACKFILL_TARGET_STATUSES) {
    let lastId: string | null = null;
    for (;;) {
      let query = admin
        .from('planned_meals')
        .select('id, dishes, user_daily_meals!inner(user_id, day_date)')
        // supabase-js の contains に配列を渡すと Postgres の配列 ({...}) として送られるので、jsonb の値は JSON の文字列で渡す
        .filter('dishes', 'cs', JSON.stringify([{ image_status: status }]))
        .order('id', { ascending: true })
        .limit(MEAL_IMAGE_BACKFILL_PAGE_SIZE);
      if (lastId) query = query.gt('id', lastId);
      if (options.since) query = query.gte('user_daily_meals.day_date', options.since);
      if (options.userId) query = query.eq('user_daily_meals.user_id', options.userId);
      const { data, error } = await query;
      if (error) throw new Error(`planned_meals の読み取りに失敗しました: ${error.message}`);
      const rows = (data ?? []) as PlannedMealRow[];
      for (const row of rows) byId.set(row.id, row);
      if (rows.length < MEAL_IMAGE_BACKFILL_PAGE_SIZE) break;
      lastId = rows[rows.length - 1].id;
    }
  }
  return [...byId.values()];
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 数える (apply: false)・積み直す (apply: true)。積み直すのは、日付の新しい献立から maxMeals 件まで。
 * 1 献立ずつ順に積み、処理を起こし、intervalMs 待つ
 */
export async function runMealImageBackfill(admin: SupabaseClient, options: MealImageBackfillOptions): Promise<MealImageBackfillReport> {
  if (!Number.isInteger(options.maxMeals) || options.maxMeals < 1 || options.maxMeals > MEAL_IMAGE_BACKFILL_MAX_MEALS_LIMIT) {
    throw new Error(`maxMeals は 1〜${MEAL_IMAGE_BACKFILL_MAX_MEALS_LIMIT} の整数にしてください`);
  }
  const rows = await loadWaitingMeals(admin, options);

  const skipped = emptySkipCounts();
  const candidates: MealImageBackfillCandidate[] = [];
  for (const row of rows) {
    const daily = dailyMealOf(row);
    const plan = planDishImageJobs(row.dishes);
    for (const reason of Object.keys(skipped) as MealImageBackfillSkipReason[]) skipped[reason] += plan.skipped[reason];
    if (!daily || plan.seeds.length === 0) continue;
    candidates.push({ plannedMealId: row.id, userId: daily.user_id, dayDate: daily.day_date, seeds: plan.seeds });
  }
  // 日付の新しい献立 (これから食べる・最近の献立) から
  candidates.sort((a, b) => (a.dayDate === b.dayDate ? a.plannedMealId.localeCompare(b.plannedMealId) : b.dayDate.localeCompare(a.dayDate)));

  const report: MealImageBackfillReport = {
    apply: options.apply,
    scannedMeals: rows.length,
    candidateMeals: candidates.length,
    candidateDishes: candidates.reduce((sum, candidate) => sum + candidate.seeds.length, 0),
    skipped,
    processedMeals: 0,
    enqueue: { inserted: 0, duplicates: 0, failed: 0 },
    triggeredMeals: 0,
  };
  if (!options.apply) return report;

  const sleep = options.sleep ?? defaultSleep;
  for (const candidate of candidates.slice(0, options.maxMeals)) {
    const result = await enqueueMealImageJobs({
      supabase: admin,
      plannedMealId: candidate.plannedMealId,
      userId: candidate.userId,
      jobs: candidate.seeds,
      requestId: null,
    });
    report.processedMeals += 1;
    report.enqueue.inserted += result.inserted;
    report.enqueue.duplicates += result.duplicates;
    report.enqueue.failed += result.failed;

    if (options.trigger && result.inserted + result.duplicates > 0) {
      await triggerMealImageJobProcessing({
        supabaseUrl: options.supabaseUrl ?? '',
        serviceRoleKey: options.serviceRoleKey ?? '',
        plannedMealId: candidate.plannedMealId,
        limit: candidate.seeds.length,
      });
      report.triggeredMeals += 1;
      await sleep(options.intervalMs);
    }
  }
  return report;
}

export interface MealImageBackfillArgs {
  apply: boolean;
  maxMeals: number;
  since: string | null;
  userId: string | null;
  trigger: boolean;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** コマンドの引数を読む。分からない引数・範囲外の値は例外 (何もしないで止める) */
export function parseMealImageBackfillArgs(argv: ReadonlyArray<string>): MealImageBackfillArgs {
  const args: MealImageBackfillArgs = {
    apply: false,
    maxMeals: MEAL_IMAGE_BACKFILL_DEFAULT_MAX_MEALS,
    since: null,
    userId: null,
    trigger: true,
  };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--dry-run') args.apply = false;
    else if (arg === '--no-trigger') args.trigger = false;
    else if (arg.startsWith('--max-meals=')) {
      const raw = arg.slice('--max-meals='.length);
      const value = Number(raw);
      if (!/^\d+$/.test(raw) || value < 1 || value > MEAL_IMAGE_BACKFILL_MAX_MEALS_LIMIT) {
        throw new Error(`--max-meals は 1〜${MEAL_IMAGE_BACKFILL_MAX_MEALS_LIMIT} の整数にしてください`);
      }
      args.maxMeals = value;
    } else if (arg.startsWith('--since=')) {
      const value = arg.slice('--since='.length);
      if (!DATE_PATTERN.test(value)) throw new Error('--since は YYYY-MM-DD にしてください');
      args.since = value;
    } else if (arg.startsWith('--user-id=')) {
      const value = arg.slice('--user-id='.length);
      if (!UUID_PATTERN.test(value)) throw new Error('--user-id は利用者の ID (uuid) にしてください');
      args.userId = value;
    } else {
      throw new Error(`分からない引数です: ${arg}`);
    }
  }
  return args;
}

/** 処理を起こしたあとの待ち (ミリ秒)。環境変数 MEAL_IMAGE_BACKFILL_INTERVAL_MS があればそれ (0 以上の整数) */
export function resolveMealImageBackfillIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return MEAL_IMAGE_BACKFILL_DEFAULT_INTERVAL_MS;
  if (!/^\d+$/.test(raw.trim())) throw new Error('MEAL_IMAGE_BACKFILL_INTERVAL_MS は 0 以上の整数 (ミリ秒) にしてください');
  return Number(raw.trim());
}
