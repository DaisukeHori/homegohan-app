/**
 * A/B テスト variant 割当エンジン
 *
 * #1041 (F4-13) 修正: `experiments.status` を 'running' にできても、
 * ユーザーを variant に割り当てる処理が一切存在せず `experiment_assignments`
 * が常に空のままだった (= 実験は「起動」しているように見えて runtime では
 * 完全に無効という偽成功状態)。
 *
 * ここで決定的ハッシュに基づく割当 + upsert (sticky assignment) を実装する。
 * 同一 experiment_id + user_id には常に同じ variant_key が返る (再割当しない)。
 *
 * #1041 round-2 (B) 修正: `experiment_assignments` に INSERT ポリシーが無く
 * (service_role 前提)、呼び出し元は requireUser() 通過後に
 * `getSupabaseAdmin()` (service-role) を渡す。本関数のクエリは全て
 * `userId` 引数でスコープされているため、呼び出し元が常に session の
 * 自分自身の userId のみを渡す限り IDOR にはならない (他ユーザーの
 * userId を渡せる経路を作らないこと)。
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ExperimentVariant {
  key: string;
  weight: number;
}

export class ExperimentNotRunningError extends Error {
  constructor(message = '実験は running 状態ではありません') {
    super(message);
    this.name = 'ExperimentNotRunningError';
  }
}

export class InvalidVariantsError extends Error {
  constructor(message = 'variants の定義が不正です') {
    super(message);
    this.name = 'InvalidVariantsError';
  }
}

/** FNV-1a (32bit) — 決定的・高速・依存なしのハッシュ関数 */
function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * variants の JSON 定義をパースする。不正な形式なら InvalidVariantsError を throw。
 */
export function parseVariants(raw: unknown): ExperimentVariant[] {
  if (!Array.isArray(raw)) {
    throw new InvalidVariantsError('variants は配列である必要があります');
  }
  const variants: ExperimentVariant[] = raw.map((v) => {
    if (
      typeof v !== 'object' ||
      v === null ||
      typeof (v as { key?: unknown }).key !== 'string' ||
      typeof (v as { weight?: unknown }).weight !== 'number'
    ) {
      throw new InvalidVariantsError('variants の各要素は { key: string, weight: number } である必要があります');
    }
    return { key: (v as { key: string }).key, weight: (v as { weight: number }).weight };
  });
  if (variants.length === 0) {
    throw new InvalidVariantsError('variants が空です');
  }
  return variants;
}

/**
 * 決定的ハッシュに基づき variants から 1 つを選択する。
 * 同一 experimentId + userId の組では常に同じ結果を返す (純粋関数)。
 */
export function selectVariantKey(variants: ExperimentVariant[], experimentId: string, userId: string): string {
  const positiveWeightVariants = variants.filter((v) => v.weight > 0);
  const totalWeight = positiveWeightVariants.reduce((sum, v) => sum + v.weight, 0);
  if (positiveWeightVariants.length === 0 || totalWeight <= 0) {
    throw new InvalidVariantsError('weight > 0 の variant が存在しません');
  }

  const bucket = fnv1aHash(`${experimentId}:${userId}`) % totalWeight;
  let cumulative = 0;
  for (const variant of positiveWeightVariants) {
    cumulative += variant.weight;
    if (bucket < cumulative) {
      return variant.key;
    }
  }
  // 整数演算のため到達しないはずだが、安全側に最後の variant を返す
  return positiveWeightVariants[positiveWeightVariants.length - 1].key;
}

export interface ExperimentForAssignment {
  id: string;
  status: string;
  variants: unknown;
}

/**
 * ユーザーの variant 割当を取得する。存在しなければ決定的ハッシュで新規割当し、
 * experiment_assignments に記録する (sticky — 一度割り当てたら変更しない)。
 *
 * @throws ExperimentNotRunningError 実験が running でない場合
 * @throws InvalidVariantsError variants の定義が不正な場合
 * @throws Error DB エラー時 (呼び出し側で fail-closed に処理すること)
 */
export async function getOrAssignVariant(
  supabase: SupabaseClient<any>,
  experiment: ExperimentForAssignment,
  userId: string,
): Promise<string> {
  if (experiment.status !== 'running') {
    throw new ExperimentNotRunningError();
  }

  const { data: existing, error: fetchErr } = await supabase
    .from('experiment_assignments')
    .select('variant_key')
    .eq('experiment_id', experiment.id)
    .eq('user_id', userId)
    .maybeSingle();

  if (fetchErr) throw fetchErr;
  if (existing) return existing.variant_key;

  const variants = parseVariants(experiment.variants);
  const variantKey = selectVariantKey(variants, experiment.id, userId);

  const { data: inserted, error: insertErr } = await supabase
    .from('experiment_assignments')
    .insert({ experiment_id: experiment.id, user_id: userId, variant_key: variantKey })
    .select('variant_key')
    .single();

  if (insertErr) {
    // 競合レース (同時リクエストで既に他方が割当済み) の可能性を考慮し再取得する。
    // sticky assignment を保つため、ここで新規に別の variant を返してはならない。
    const { data: raceData, error: raceErr } = await supabase
      .from('experiment_assignments')
      .select('variant_key')
      .eq('experiment_id', experiment.id)
      .eq('user_id', userId)
      .maybeSingle();
    if (raceErr || !raceData) throw insertErr;
    return raceData.variant_key;
  }

  return inserted.variant_key;
}
