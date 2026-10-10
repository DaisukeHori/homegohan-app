/**
 * 本番エラーの急増を運用メールに知らせる (#1157) — しきい値の判定と、メールに載せる内容の整え方
 *
 * 純粋な関数と定数だけを置く (DB・メール送信・環境変数は読まない)。実際の処理は
 * GET /api/cron/app-log-alerts (src/app/api/cron/app-log-alerts/route.ts) が行い、ここの関数を呼ぶ。
 *
 * 仕組み:
 *   1. Vercel Cron が 15 分おきに route を呼ぶ (vercel.json)。
 *   2. DB の app_log_error_counts で、直近 APP_LOG_ALERT_WINDOW_MINUTES 分の app_logs.level='error' を function_name ごとに数える。
 *   3. 合計がしきい値 (既定 APP_LOG_ALERT_ERROR_THRESHOLD = 20) を超えていたら (= 21 件以上)、運用のメールアドレス (OPS_ALERT_EMAIL) に 1 通送る。
 *   4. 同じアラートはクールダウン (既定 APP_LOG_ALERT_COOLDOWN_MINUTES = 60) 分は送り直さない
 *      (DB の ops_alert_state。claim_ops_alert / release_ops_alert)。
 *   しきい値とクールダウンは、環境変数 OPS_ALERT_ERROR_THRESHOLD / OPS_ALERT_COOLDOWN_MINUTES で上書きできる
 *   (route が読んで resolveAppLogAlertSettings に渡す。不正な値は既定値に戻し、warn を残す)。
 *
 * メールに載せるのは「件数」と「関数名」と「運用ログ画面へのリンク」だけ。ユーザー ID・メールアドレス・ログの本文は載せない
 * (送信先の Resend は米国の事業者。個人情報を国外へ出さない)。関数名はログを書くコードが決める固定の名前 (例: `GET /api/org/settings`) だが、
 * 将来 ID などを含む名前が書かれても漏れないよう、載せる前に sanitizeFunctionNameForAlert でマスクする。
 *
 * 限界 (知っておくこと):
 *   - 窓 (15 分) と cron の間隔 (15 分) が同じなので、窓の境目をまたいで集中した少数の error は、どちらの窓でも
 *     しきい値に届かず、見逃すことがある。続いている障害は、次の窓で必ず届く。
 *   - 数えるのは app_logs に書かれた error だけ。ログを書く前に落ちた障害 (関数ごと落ちる、DB に繋がらない) は数えられない。
 *     死活の監視 (/api/health) は別の仕組み (設計書 operator/07-audit-monitoring.md §9)。
 *   - error レベルのログは、そのままアラートの種になる。想定内の失敗 (入力の誤りなど) を error で書き続けると、
 *     本物の障害と区別できなくなる。想定内のものは warn で書く。
 */

import { maskSecretsInText } from '../../../supabase/functions/_shared/log-sanitizer';

// ── 定数 ──────────────────────────────────────────────────────────────────

/** ops_alert_state のキー。このアラートの種類を表す固定の名前 (ユーザー・関数名などの値は入れない) */
export const APP_LOG_ALERT_KEY = 'app_logs_error_spike';

/**
 * error を数える窓 (分)。cron の間隔 (vercel.json で 15 分おき) と同じにする。
 * 環境変数では変えない: 間隔は vercel.json (デプロイで決まる) にあり、窓だけを変えると、数え漏れ (窓 < 間隔) か
 * 二重に数える (窓 > 間隔) ことになるため。変えるときは vercel.json と一緒に変える (テスト O-2 が突き合わせる)。
 */
export const APP_LOG_ALERT_WINDOW_MINUTES = 15;

/**
 * 窓の中の error の合計が、この件数を超えたら (これより多いとき) 通知する (既定値)。
 * 運用で変えるときは環境変数 OPS_ALERT_ERROR_THRESHOLD で上書きする (resolveAppLogAlertSettings)。
 */
export const APP_LOG_ALERT_ERROR_THRESHOLD = 20;

/**
 * 同じアラートを送り直さない時間 (分) (既定値)。
 * 運用で変えるときは環境変数 OPS_ALERT_COOLDOWN_MINUTES で上書きする (resolveAppLogAlertSettings)。
 */
export const APP_LOG_ALERT_COOLDOWN_MINUTES = 60;

/** OPS_ALERT_ERROR_THRESHOLD で受け付ける最小値。0 だと error が 1 件でも通知になり、急増の通知でなくなるため 1 から */
export const APP_LOG_ALERT_ERROR_THRESHOLD_MIN = 1;

/**
 * OPS_ALERT_ERROR_THRESHOLD で受け付ける最大値。15 分でこれだけの error が出ていれば規模を問わず障害なので、
 * これより大きい値は打ち間違いとみなして既定値に戻す (通知を止めたいときは OPS_ALERT_EMAIL を消す)
 */
export const APP_LOG_ALERT_ERROR_THRESHOLD_MAX = 100_000;

/** OPS_ALERT_COOLDOWN_MINUTES で受け付ける最小値 (分)。DB の claim_ops_alert が受け付ける下限 (1 分) に合わせる */
export const APP_LOG_ALERT_COOLDOWN_MINUTES_MIN = 1;

/** OPS_ALERT_COOLDOWN_MINUTES で受け付ける最大値 (分)。DB の claim_ops_alert が受け付ける上限 (7 日) に合わせる */
export const APP_LOG_ALERT_COOLDOWN_MINUTES_MAX = 7 * 24 * 60;

/** メールに載せる関数名の最大数 (残りは「ほかの関数」として合計だけ載せる) */
export const APP_LOG_ALERT_MAX_FUNCTIONS = 10;

/** 運用ログ画面 (super_admin 専用。#1157) のパス。メールには、サイトの URL につないだ絶対 URL で載せる */
export const SUPER_ADMIN_LOGS_PATH = '/super-admin/logs';

/** function_name が無いログ (ブラウザから届いたログなど) の表示名 */
export const NO_FUNCTION_NAME_LABEL = '(関数名なし)';

/** メールに載せる関数名の最大文字数 (超えた分は … にする) */
const MAX_FUNCTION_NAME_CHARS = 80;

// ── 関数名のマスク ────────────────────────────────────────────────────────

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * メールの 1 行に収めるとき、空白に置き換える文字か: 制御文字 (改行・タブを含む)、行区切り・段落区切り、双方向の制御文字。
 * 文字そのものではなく、コードポイントの数値で判定する (正規表現やソースに、目に見えない文字を直接書かないため)。
 */
function isControlCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f || // C0 制御文字 (改行・タブを含む)
    (codePoint >= 0x7f && codePoint <= 0x9f) || // DEL と C1 制御文字
    (codePoint >= 0x200e && codePoint <= 0x200f) || // 左→右・右→左マーク
    (codePoint >= 0x2028 && codePoint <= 0x202e) || // 行区切り・段落区切り・双方向の埋め込みと上書き
    (codePoint >= 0x2066 && codePoint <= 0x2069) // 双方向の分離
  );
}

/** 制御文字を空白にし、連続する空白を 1 つにして、1 行にそろえる */
function toSingleLine(text: string): string {
  let out = '';
  for (const ch of text) out += isControlCodePoint(ch.codePointAt(0) ?? 0) ? ' ' : ch;
  return out.replace(/\s+/g, ' ').trim();
}

/** UTF-16 の長さで max 以内に収める。絵文字などのサロゲートペアは途中で切らない */
function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break; // 末尾の「…」の分を空ける
    out += ch;
  }
  return `${out}…`;
}

/**
 * アラートのメールに載せる関数名にする。
 *   - null・空 → NO_FUNCTION_NAME_LABEL
 *   - メールアドレス・トークン・鍵 (ログの保存時と同じ規則: log-sanitizer) と、UUID (ユーザー ID など) を伏せる
 *   - 改行などの制御文字は空白 1 つにして、80 文字までに収める
 * 何度かけても同じ結果になる (メール側で念のためもう一度かけても、表示は変わらない)。
 */
export function sanitizeFunctionNameForAlert(name: string | null | undefined): string {
  if (typeof name !== 'string') return NO_FUNCTION_NAME_LABEL;
  const masked = maskSecretsInText(name).replace(UUID_PATTERN, '[id]');
  const oneLine = toSingleLine(masked);
  return oneLine ? truncateChars(oneLine, MAX_FUNCTION_NAME_CHARS) : NO_FUNCTION_NAME_LABEL;
}

// ── DB の応答の読み取り ───────────────────────────────────────────────────

/** app_log_error_counts (DB の関数) が返す 1 行 */
export interface ErrorCountRow {
  /** NULL は function_name の無いログ */
  function_name: string | null;
  /** この function_name の error の件数 */
  error_count: number;
  /** 窓の中の error の全体の件数 (どの行にも同じ値が入る。返した行が上位 N 件だけでも、全体の合計) */
  total_count: number;
}

function toCount(value: unknown, field: string): number {
  // PostgREST は bigint を JSON の数値で返す。設定によっては文字列で来ることがあるので、数字だけの文字列も受ける
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`app_log_error_counts の応答の ${field} が 0 以上の整数ではありません`);
  }
  return n;
}

/**
 * app_log_error_counts の応答 (supabase-js の data) を検証して、型付きの行にする。
 * 形が想定と違うときは例外にする (黙って 0 件として扱うと、アラートが静かに止まるため)。
 */
export function parseErrorCountRows(data: unknown): ErrorCountRow[] {
  if (!Array.isArray(data)) {
    throw new Error('app_log_error_counts の応答が配列ではありません');
  }
  return data.map((row: unknown) => {
    if (row === null || typeof row !== 'object') {
      throw new Error('app_log_error_counts の応答の行がオブジェクトではありません');
    }
    const { function_name: functionName, error_count: errorCount, total_count: totalCount } = row as Record<string, unknown>;
    if (functionName !== null && functionName !== undefined && typeof functionName !== 'string') {
      throw new Error('app_log_error_counts の応答の function_name が文字列ではありません');
    }
    return {
      function_name: functionName ?? null,
      error_count: toCount(errorCount, 'error_count'),
      total_count: toCount(totalCount, 'total_count'),
    };
  });
}

// ── 集計としきい値 ────────────────────────────────────────────────────────

export interface ErrorSpikeFunction {
  /** メールに載せる関数名 (sanitizeFunctionNameForAlert 済み) */
  name: string;
  count: number;
}

export interface ErrorSummary {
  /** 窓の中の error の全体の件数 */
  total: number;
  /** 件数の多い順 (同数なら名前順)。最大 APP_LOG_ALERT_MAX_FUNCTIONS 件 */
  functions: ErrorSpikeFunction[];
  /** functions に載らなかった error の件数 (全体 − 載せた分) */
  otherCount: number;
}

/**
 * DB の行から、メールに載せる集計を作る。
 * 関数名はマスクしてから集めるので、マスク後に同じ名前になるもの (例: ID だけが違う名前) は 1 つにまとめて件数を足す。
 * 行が無ければ total は 0。
 */
export function summarizeErrorCounts(
  rows: readonly ErrorCountRow[],
  maxFunctions: number = APP_LOG_ALERT_MAX_FUNCTIONS,
): ErrorSummary {
  const merged = new Map<string, number>();
  let total = 0;
  let listed = 0;
  for (const row of rows) {
    total = Math.max(total, row.total_count);
    listed += row.error_count;
    const name = sanitizeFunctionNameForAlert(row.function_name);
    merged.set(name, (merged.get(name) ?? 0) + row.error_count);
  }
  // total_count は返した行の合計以上のはず。食い違っても、載せる件数より小さい全体にはしない
  total = Math.max(total, listed);

  const functions = [...merged]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, Math.max(0, maxFunctions));
  const shown = functions.reduce((sum, f) => sum + f.count, 0);

  return { total, functions, otherCount: Math.max(0, total - shown) };
}

/** 通知すべき件数か。しきい値「を超えた」とき (しきい値ちょうどは通知しない) */
export function exceedsErrorThreshold(total: number, threshold: number = APP_LOG_ALERT_ERROR_THRESHOLD): boolean {
  return total > threshold;
}

// ── 運用で変える値 (環境変数での上書き) ───────────────────────────────────

/** 上書きに使う環境変数の名前 (値を読むのは route だけ。ここは渡された文字列を検証するだけ) */
export type AppLogAlertSettingEnvName = 'OPS_ALERT_ERROR_THRESHOLD' | 'OPS_ALERT_COOLDOWN_MINUTES';

/** 環境変数から読んだ、上書きの元の文字列 (未設定は undefined) */
export interface AppLogAlertSettingSources {
  readonly errorThreshold: string | undefined;
  readonly cooldownMinutes: string | undefined;
}

export interface AppLogAlertSettings {
  /** しきい値 (この件数を超えたら通知する) */
  readonly errorThreshold: number;
  /** 同じ通知を送り直さない時間 (分) */
  readonly cooldownMinutes: number;
  /** 値が不正で、既定値に戻した環境変数の名前 (ログで知らせる用。値そのものは返さない) */
  readonly ignored: readonly AppLogAlertSettingEnvName[];
}

/** 10 進の整数だけを受け付ける (符号・小数・指数・16 進は不可)。桁数は Number で正確に表せる範囲に抑える */
const DECIMAL_INTEGER_PATTERN = /^\d{1,15}$/;

/**
 * 1 つの上書きを解釈する。未設定・空白だけは既定値 (無視したことにはしない)。
 * 整数でない・範囲外は既定値に戻し、ignored に入れる (打ち間違いで通知が止まったり、毎回届いたりしないように)。
 */
function resolveIntegerSetting(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): { readonly value: number; readonly ignored: boolean } {
  const text = raw?.trim();
  if (!text) return { value: fallback, ignored: false };
  if (!DECIMAL_INTEGER_PATTERN.test(text)) return { value: fallback, ignored: true };
  const n = Number(text);
  if (n < min || n > max) return { value: fallback, ignored: true };
  return { value: n, ignored: false };
}

/**
 * しきい値とクールダウンを決める。環境変数 OPS_ALERT_ERROR_THRESHOLD / OPS_ALERT_COOLDOWN_MINUTES があればそれを使い、
 * 無ければ既定値 (APP_LOG_ALERT_ERROR_THRESHOLD / APP_LOG_ALERT_COOLDOWN_MINUTES)。
 * 窓 (APP_LOG_ALERT_WINDOW_MINUTES) は vercel.json の間隔と結びついているので、ここでは変えない。
 */
export function resolveAppLogAlertSettings(sources: AppLogAlertSettingSources): AppLogAlertSettings {
  const threshold = resolveIntegerSetting(
    sources.errorThreshold,
    APP_LOG_ALERT_ERROR_THRESHOLD,
    APP_LOG_ALERT_ERROR_THRESHOLD_MIN,
    APP_LOG_ALERT_ERROR_THRESHOLD_MAX,
  );
  const cooldown = resolveIntegerSetting(
    sources.cooldownMinutes,
    APP_LOG_ALERT_COOLDOWN_MINUTES,
    APP_LOG_ALERT_COOLDOWN_MINUTES_MIN,
    APP_LOG_ALERT_COOLDOWN_MINUTES_MAX,
  );
  const ignored: AppLogAlertSettingEnvName[] = [];
  if (threshold.ignored) ignored.push('OPS_ALERT_ERROR_THRESHOLD');
  if (cooldown.ignored) ignored.push('OPS_ALERT_COOLDOWN_MINUTES');
  return { errorThreshold: threshold.value, cooldownMinutes: cooldown.value, ignored };
}
