/**
 * ログのサニタイザ - Next.js API Routes / Supabase Edge Functions 共用 (#1171)
 *
 * app_logs に保存する直前に、message / error_message / error_stack / metadata から秘密情報を
 * マスクし、文字数を切り詰める。RLS (app_logs の SELECT 範囲) が本来の防御で、これは多層防御。
 *
 * このファイルが守る制約 (崩すと Edge Functions か Next.js のどちらかが動かなくなる):
 *  - 純粋な TypeScript。import なし、Deno / Node 固有の API なし
 *    (Deno の Edge Functions と Next.js が同じファイルを読む。Next.js 側は src/lib/db-logger.ts が
 *     相対パスで import する。lib/meal-image.ts → _shared/meal-image.ts と同じ前例)。
 *  - 正規表現の量指定子はすべて上限付きで、先頭は固定のリテラルにする。走査する長さにも上限
 *    (SCAN_LIMIT) を設けるので、悪意のある長い入力でも処理時間は入力長に対して線形に収まる。
 *  - 失敗しても生の文面を返さない (fail closed)。ロガーは例外を投げない。
 *
 * マスクは best-effort。ユーザーが入力した自由文 (例: レシピ本文) までは消せない。
 */

// ── 上限値 ────────────────────────────────────────────────────────────────

/** message の最大文字数 (超えた分は切り詰めて接尾辞を付ける) */
export const MAX_LOG_MESSAGE_CHARS = 2000;
/** error_message の最大文字数 */
export const MAX_LOG_ERROR_MESSAGE_CHARS = 2000;
/** error_stack の最大文字数 */
export const MAX_LOG_STACK_CHARS = 8000;
/** 1 つの文字列に対してマスクの正規表現を走らせる最大文字数。これより後ろは捨てる (生のまま保存しない) */
export const SCAN_LIMIT = 8192;
/** 切り詰めたときに末尾へ付ける印 */
export const LOG_TRUNCATED_SUFFIX = '…[truncated]';
/** sanitizeLogEntry が失敗したときに message へ入れる固定文 (生の文面は入れない) */
export const LOG_SANITIZER_FAILED_MESSAGE = '[log sanitizer failed]';

// 切り口 (SCAN_LIMIT) をまたぐ秘密情報 (JWT など) が断片のまま残らないよう、SCAN_LIMIT より
// この文字数だけ多く読んでマスクしてから、SCAN_LIMIT に切り詰める。JWT (数百〜千数百文字) が収まる余白。
const SCAN_TAIL_GUARD = 2048;
// 切り詰め済みの文字列 (先頭 SCAN_LIMIT 文字 + 接尾辞) をもう一度通しても、同じ結果になるようにするための余裕。
// この長さまでの文字列は切り詰めない (+1 はサロゲートペアの後半を含める分)。
const SCAN_LIMIT_WITH_MARK = SCAN_LIMIT + 1 + LOG_TRUNCATED_SUFFIX.length;
// maskSecrets 1 回の呼び出しで走査する文字列の総量。巨大な配列に小さい文字列を大量に入れて
// 正規表現を走らせ続けさせる攻撃 (/api/log の metadata はクライアント由来) を防ぐ。超えた分の値は *** にする。
// metadata は最終的に 8KB へ切り詰めるので、通常の使い方では届かない大きさ。
const MAX_TOTAL_SCAN_CHARS = 64 * 1024;
// 文字列 1 個ごとの固定コスト (空文字列を大量に並べても走査量に数える)
const SCAN_COST_PER_LEAF = 16;

// ── 文字列のマスク ────────────────────────────────────────────────────────

/**
 * 文字列に含まれる秘密情報の書式を ***（またはメール → [email]）に置き換えるルール。
 * 順番に意味がある (先に長い・具体的なものを置き換え、最後に汎用のものを置き換える)。
 *
 * 量指定子は必ず上限付きにすること (`+` `*` `{n,}` は使わない)。上限なしだと、悪意のある入力で
 * 同じ区間を何度も走査し直し、処理時間が入力長の 2 乗になる。tests/log-sanitizer.test.ts が検査する。
 * 上限は実在する秘密情報の長さに対して十分大きく取ってある (上限より長い値は、上限までがマスクされ続きが残る)。
 */
export const LOG_TEXT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM 形式の秘密鍵 (ヘッダ以降の本体ごと消す)
  [/-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----[\s\S]{0,4096}/g, '***'],
  // JWT (Supabase の anon / service_role / ユーザーのアクセストークンもこの形)
  [/eyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,2048}/g, '***'],
  // Authorization ヘッダの Bearer トークン
  [/\b(Bearer)\s{1,8}[A-Za-z0-9._~+/=-]{16,4096}/gi, '$1 ***'],
  // Supabase (新形式のシークレットキー / 個人アクセストークン) / Stripe (秘密鍵・Webhook シークレット)
  [
    /\bsb_secret_[A-Za-z0-9_-]{10,256}|\bsbp_[A-Za-z0-9]{20,256}|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,256}|\bwhsec_[A-Za-z0-9]{10,256}/g,
    '***',
  ],
  // OpenAI / xAI / Google (Gemini) / Perplexity の API キー
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,512}|\bxai-[A-Za-z0-9]{20,256}|\bAIza[0-9A-Za-z_-]{35}|\bpplx-[A-Za-z0-9]{20,256}/g, '***'],
  // GitHub / Slack / AWS / Resend
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,256}|github_pat_[A-Za-z0-9_]{30,256}|xox[abprs]-[A-Za-z0-9-]{10,256}|AKIA[0-9A-Z]{16}|re_[A-Za-z0-9]{8,64}_[A-Za-z0-9]{8,256})/g,
    '***',
  ],
  // 接続文字列などの scheme://user:password@host のパスワード部分 (ホストは残す)
  [/\b([a-z][a-z0-9+.-]{0,20}:\/\/[^\s:@/?#]{1,64}):[^\s/?#]{1,1024}@/gi, '$1:***@'],
  // password=... / "api_key":"..." / Authorization: Bearer ... / token=... のように、キー名の直後にある値。
  // JSON の引用符 (エスケープされた \" を含む) と、Authorization の認証方式の語 (Bearer / Basic) も値の一部として消す
  [
    /((?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\\?["']?\s{0,16}[:=]\s{0,16}\\?["']?)(?:(?:Bearer|Basic|Token)\s{1,8})?[^\s"',;&)}\]]{1,8192}/gi,
    '$1***',
  ],
  // Postgres のエラー詳細に含まれる、衝突した値 / 制約に違反した行の中身 (メールアドレスなどが入る)
  [/(Key \([^)]{0,200}\)=\()[^)]{0,2048}(\))/g, '$1***$2'],
  [/(Failing row contains \()[^\n]{0,8192}/g, '$1***)'],
  // メールアドレス (ユーザー ID は調査に必要なので残す)。URL のクエリに入る @ の %40 表記も対象
  [/[A-Za-z0-9._%+-]{1,64}(?:@|%40)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,4}\.[A-Za-z]{2,24}/g, '[email]'],
];

/**
 * 先頭 n 文字を返す。サロゲートペア (絵文字など) の途中で切ると、DB (JSON) が孤立サロゲートを拒否して
 * ログごと保存に失敗するため、ペアの後半までを含めて切る。切り位置は先頭部分だけで決まるので、
 * 切ったあとの文字列をもう一度切っても同じ結果になる。
 */
function sliceChars(text: string, n: number): string {
  if (text.length <= n) return text;
  const last = text.charCodeAt(n - 1);
  const next = text.charCodeAt(n);
  const splitsPair = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return text.slice(0, splitsPair ? n + 1 : n);
}

/**
 * 自由文に含まれる秘密情報 (トークン・キー・接続文字列・メールアドレスなど) をマスクする。
 * SCAN_LIMIT を超える分は捨てて接尾辞を付ける (残りを生のまま保存しない)。
 */
export function maskSecretsInText(text: string): string {
  const source = typeof text === 'string' ? text : String(text);
  const truncated = source.length > SCAN_LIMIT_WITH_MARK;
  let out = truncated ? source.slice(0, SCAN_LIMIT + SCAN_TAIL_GUARD) : source;
  for (const [pattern, replacement] of LOG_TEXT_RULES) {
    out = out.replace(pattern, replacement);
  }
  return truncated ? `${sliceChars(out, SCAN_LIMIT)}${LOG_TRUNCATED_SUFFIX}` : out;
}

/**
 * ログの文字列項目 (message / error_message / error_stack) をマスクし、max 文字で切り詰める。
 * null / undefined は undefined、文字列以外は文字列に直してから処理する。
 * 秘密情報は切り詰めの前にマスクするので、切り口にかかった秘密情報の断片は残らない。
 * 切り詰めた場合の長さは max + 接尾辞。
 */
export function sanitizeLogText(value: unknown, max: number): string | undefined {
  if (value == null) return undefined;
  let text: string;
  try {
    text = typeof value === 'string' ? value : String(value);
  } catch {
    // toString が例外を投げる値 (Object.create(null) など)
    text = '[unprintable]';
  }
  const masked = maskSecretsInText(text);
  return masked.length > max ? `${sliceChars(masked, max)}${LOG_TRUNCATED_SUFFIX}` : masked;
}

// ── metadata のマスク ─────────────────────────────────────────────────────

// #1044 (F6-20): metadata に混入した秘密情報をマスキングする
const SECRET_KEY_PATTERN = /password|token|secret|authorization|api[_-]?key/i;
const MASK_VALUE = '***';
const MAX_MASK_DEPTH = 6;

interface ScanBudget {
  chars: number;
}

function maskValue(value: unknown, depth: number, budget: ScanBudget): unknown {
  // #1044 round-2: 深さ上限に達した場合、生値をそのまま返すと上限より深いネストに
  // 潜む秘密情報がマスクされずに漏洩する。fail-safe として値ごとマスクする。
  if (depth >= MAX_MASK_DEPTH) return MASK_VALUE;

  // #1171: 文字列の値 (error: '... sk-xxx' のような) もキー名に関係なく書式でマスクする。
  // 走査量の総和が上限を超えたら、残りは中身を見ずに値ごとマスクする (fail-safe)。
  if (typeof value === 'string') {
    budget.chars -= SCAN_COST_PER_LEAF + Math.min(value.length, SCAN_LIMIT);
    return budget.chars < 0 ? MASK_VALUE : maskSecretsInText(value);
  }

  // JSON.stringify は BigInt で TypeError を投げ、ログごと落ちるので文字列にしておく
  if (typeof value === 'bigint') return value.toString();

  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, depth + 1, budget));
  }

  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SECRET_KEY_PATTERN.test(key) ? MASK_VALUE : maskValue(val, depth + 1, budget);
    }
    return result;
  }

  return value;
}

/**
 * オブジェクト/配列を再帰的に走査し、キー名が秘密情報パターンに一致する値と、
 * 値の文字列に含まれる秘密情報の書式をマスクする。
 * 循環参照や深いネストで無限ループしないよう深さ上限を設ける。
 */
export function maskSecrets<T>(value: T, depth = 0): T {
  return maskValue(value, depth, { chars: MAX_TOTAL_SCAN_CHARS }) as T;
}

const DEFAULT_MAX_METADATA_BYTES = 8 * 1024; // 8KB

/**
 * metadata のシリアライズ後サイズが上限を超える場合、プレビューのみを残して切り詰める。
 */
export function truncateMetadata(
  metadata: Record<string, unknown> | undefined,
  maxBytes: number = DEFAULT_MAX_METADATA_BYTES,
): Record<string, unknown> | undefined {
  if (!metadata) return metadata;

  const json = JSON.stringify(metadata);
  const byteLength = new TextEncoder().encode(json).length;
  if (byteLength <= maxBytes) return metadata;

  return {
    _truncated: true,
    _original_bytes: byteLength,
    _preview: sliceChars(json, Math.max(0, maxBytes - 200)),
  };
}

/**
 * metadata にマスキングとサイズ切り詰めをまとめて適用する。
 */
export function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined,
  maxBytes: number = DEFAULT_MAX_METADATA_BYTES,
): Record<string, unknown> | undefined {
  if (!metadata) return metadata;
  return truncateMetadata(maskSecrets(metadata), maxBytes);
}

// ── ログ 1 行のサニタイズ ─────────────────────────────────────────────────

/** サニタイズ前のログ 1 行 (app_logs の列。src/lib/db-logger.ts と _shared/db-logger.ts の LogEntry と互換) */
export interface SanitizableLogEntry {
  level: string;
  source: string;
  function_name?: string | null;
  user_id?: string | null;
  message: string;
  metadata?: Record<string, unknown> | null;
  error_message?: string | null;
  error_stack?: string | null;
  request_id?: string | null;
}

/** サニタイズ後のログ 1 行 (そのまま app_logs に insert できる) */
export interface SanitizedLogEntry {
  level: string;
  source: string;
  function_name?: string;
  user_id?: string;
  message: string;
  metadata?: Record<string, unknown>;
  error_message?: string;
  error_stack?: string;
  request_id?: string;
}

// app_logs.user_id は auth.users への外部キー付きの uuid 列。uuid でない値 (例: "unknown") を入れると
// insert が失敗してログごと捨てられるので、uuid の形をしたものだけを残して、そうでなければ NULL (= 省略) にする。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toUserId(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 失敗時の最小の行。生の文面 (message / error_* / metadata) は一切入れない */
function failedLogEntry(entry: SanitizableLogEntry): SanitizedLogEntry {
  try {
    return {
      level: optionalString(entry.level) ?? 'error',
      source: optionalString(entry.source) ?? 'unknown',
      function_name: optionalString(entry.function_name),
      user_id: toUserId(entry.user_id),
      message: LOG_SANITIZER_FAILED_MESSAGE,
      request_id: optionalString(entry.request_id),
    };
  } catch {
    return { level: 'error', source: 'unknown', message: LOG_SANITIZER_FAILED_MESSAGE };
  }
}

/**
 * app_logs へ insert する直前のログ 1 行を整える (#1171)。
 *  - message / error_message / error_stack: 秘密情報をマスクして文字数を切り詰める
 *  - metadata: キー名と値の両方でマスクして 8KB に切り詰める
 *  - user_id: uuid の形をしていなければ省略する (NULL になる)
 *  - app_logs の列以外のキーは落とす。引数は書き換えない。
 * 例外は投げない。失敗したときは生の文面を含まない最小の行を返す (fail closed)。
 */
export function sanitizeLogEntry(entry: SanitizableLogEntry): SanitizedLogEntry {
  try {
    return {
      level: entry.level,
      source: entry.source,
      function_name: optionalString(entry.function_name),
      user_id: toUserId(entry.user_id),
      message: sanitizeLogText(entry.message, MAX_LOG_MESSAGE_CHARS) ?? '',
      metadata: entry.metadata == null ? undefined : sanitizeMetadata(entry.metadata),
      error_message: sanitizeLogText(entry.error_message, MAX_LOG_ERROR_MESSAGE_CHARS),
      error_stack: sanitizeLogText(entry.error_stack, MAX_LOG_STACK_CHARS),
      request_id: optionalString(entry.request_id),
    };
  } catch {
    return failedLogEntry(entry);
  }
}
