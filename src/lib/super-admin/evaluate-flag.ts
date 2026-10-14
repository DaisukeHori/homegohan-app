/**
 * 機能フラグ評価
 * operator/02-api-spec.md §7 準拠
 *
 * feature_flags テーブル (#1029, 20260710210029_feature_flags_table.sql) に保存された
 * enabled / rollout_strategy / constraints を、実際のユーザーコンテキストに対して判定する。
 *
 * evaluateFlag は DB I/O を含まない純粋関数にしてある (ユニットテストで
 * percentage/plan/role/org の全ロールアウトパターンを検証するため)。判定の本体は Edge Functions と共用の
 * supabase/functions/_shared/feature-flag-eval.ts に置く (#1486)。
 * fetchFlagRecord が DB からの読み出し (service_role 経由、RLS バイパス) を担う。
 * feature_flags テーブルの RLS は super_admin 限定のため、一般ユーザーからのフラグ
 * 判定は必ずこの経由 (service_role) で行う。
 *
 * アプリの機能の ON/OFF の判定 (献立生成のエンジン切り替え・AI 相談の緊急停止・メンテナンスモードなど) は、
 * このファイルを直接呼ばず src/lib/feature-flags.ts の isFeatureEnabled を使う (#1148)。
 * 行が無い・読めないときの既定値、メモリのキャッシュ、読み出しの待ち時間の上限は、そちらが持つ。
 */
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { evaluateFlagRule } from '../../../supabase/functions/_shared/feature-flag-eval';
import type { RolloutStrategy, FeatureFlagConstraints } from './flags-schemas';

export interface FeatureFlagRecord {
  key: string;
  enabled: boolean;
  rollout_strategy: RolloutStrategy | null;
  constraints: FeatureFlagConstraints | null;
}

export interface UserFlagContext {
  userId: string;
  planKey?: string | null;
  roles?: string[];
  organizationId?: string | null;
  /** アカウント作成日時 (ISO 文字列)。constraints.min_user_age_days の判定に使用 */
  accountCreatedAt?: string | null;
}

/**
 * feature_flags 1 行 + ユーザーコンテキストから有効/無効を判定する純粋関数。
 * 判定の本体は Edge Functions と共用の supabase/functions/_shared/feature-flag-eval.ts (evaluateFlagRule)。
 * Edge Function (knowledge-gpt) の AI 相談の緊急停止スイッチも、同じ判定を使う (#1486)。
 * @param flag - feature_flags テーブルの 1 行相当。存在しない (null) 場合は無効扱い (fail-closed)
 * @param ctx - 判定対象ユーザーのコンテキスト
 */
export function evaluateFlag(flag: FeatureFlagRecord | null, ctx: UserFlagContext): boolean {
  return evaluateFlagRule(flag, ctx);
}

/**
 * feature_flags テーブルから key の行を 1 行取得する。行が無ければ null。
 * service_role (getSupabaseAdmin) で RLS をバイパスする — feature_flags は
 * super_admin 限定 RLS のため、一般ユーザーのセッションクライアントでは SELECT できない。
 * 読み出しに失敗したときは例外を投げる (null にはしない)。
 * 「行が無い」と「読めなかった」を呼び出し側が区別できるようにするため (#1148)。
 * 失敗しても動き続けたい呼び出し側は、このファイルではなく src/lib/feature-flags.ts の isFeatureEnabled を使う。
 *
 * 読むのはフラグの行 (全ユーザー共通の設定) を key で 1 行だけ。ミドルウェアのように認可の前に呼ばれても、
 * ユーザーの情報は読まない。
 */
export async function fetchFlagRecord(key: string): Promise<FeatureFlagRecord | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('feature_flags')
    .select('key, enabled, rollout_strategy, constraints')
    .eq('key', key)
    .maybeSingle();

  if (error) {
    // supabase-js のエラーは Error ではなく { message, code, ... } の素のオブジェクトなので、Error に包んで投げる
    // (呼び出し側のログに、メッセージとスタックが残るようにする)
    throw new Error(`feature_flags の読み出しに失敗しました: ${error.message} (code: ${error.code ?? 'unknown'})`);
  }

  return (data as FeatureFlagRecord | null) ?? null;
}

/**
 * feature_flags テーブルから key を取得し evaluateFlag で判定する。
 * 行が無いときは無効 (fail-closed。evaluateFlag の規則どおり)。読み出しに失敗したときは例外を投げる。
 * アプリの機能の ON/OFF の判定には、これではなく isFeatureEnabled (src/lib/feature-flags.ts) を使う
 * (行が無い・読めないときの既定値、メモリのキャッシュ、読み出しの待ち時間の上限をそちらが持つ)。
 */
export async function fetchAndEvaluateFlag(key: string, ctx: UserFlagContext): Promise<boolean> {
  return evaluateFlag(await fetchFlagRecord(key), ctx);
}
