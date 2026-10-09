/**
 * 本番エラーの急増を運用メールに知らせる (#1157) — しきい値の判定と、メールに載せる内容の整え方
 *
 * 純粋な関数と定数だけを置く (DB・メール送信・環境変数は読まない)。実際の処理は
 * GET /api/cron/app-log-alerts (src/app/api/cron/app-log-alerts/route.ts) が行い、ここの関数を呼ぶ。
 *
 * 仕組み:
 *   1. Vercel Cron が 15 分おきに route を呼ぶ (vercel.json)。
 *   2. DB の app_log_error_counts で、直近 APP_LOG_ALERT_WINDOW_MINUTES 分の app_logs.level='error' を function_name ごとに数える。
 *   3. 合計が APP_LOG_ALERT_ERROR_THRESHOLD を超えていたら (= 21 件以上)、運用のメールアドレス (OPS_ALERT_EMAIL) に 1 通送る。
 *   4. 同じアラートは APP_LOG_ALERT_COOLDOWN_MINUTES 分は送り直さない (DB の ops_alert_state。claim_ops_alert / release_ops_alert)。
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

/** error を数える窓 (分)。cron の間隔 (vercel.json で 15 分おき) と同じにする */
export const APP_LOG_ALERT_WINDOW_MINUTES = 15;

/** 窓の中の error の合計が、この件数を超えたら (これより多いとき) 通知する */
export const APP_LOG_ALERT_ERROR_THRESHOLD = 20;

/** 同じアラートを送り直さない時間 (分) */
export const APP_LOG_ALERT_COOLDOWN_MINUTES = 60;

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
