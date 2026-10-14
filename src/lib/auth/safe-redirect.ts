/**
 * open redirect 対策の共通ヘルパー
 * Issue #1043 (F1a-08/F6-14) 対応 / #1057 でも再利用予定
 *
 * ログイン後・auth/callback 後の遷移先として、外部ドメインへ飛ばされる
 * 「オープンリダイレクト」を防ぐため、内部の相対パスのみを安全な遷移先として許可する。
 *
 * 拒否対象:
 *   - プロトコル相対 URL (プレフィックス2つの `/`, 例: `//evil.com`)
 *   - スキーム付き絶対 URL (`https://evil.com`, `javascript:...` 等)
 *   - バックスラッシュ変種 (`/` + `\` + `evil.com` 等) — ブラウザの URL パーサは
 *     特別スキームにおいてバックスラッシュを `/` と等価に扱うため、プロトコル相対と同義になる
 *   - 上記を percent-encoding で難読化したもの (`%2F%2Fevil.com` 等)
 *   - タブ・改行等の制御文字を挟んで `//` 判定を回避する変種
 *     (`%09`/`%0A`/`%0D` およびその多重エンコード, 例: `/%09/evil.com`) —
 *     WHATWG URL パーサはパース時にタブ・改行を除去するため、
 *     `/<tab>/evil.com` は `new URL()` に渡すと `//evil.com` と同義になる
 *
 * 許可対象:
 *   - `/` から始まる相対パス (`/home`, `/invite/xxx?a=b` 等)
 *
 * 戻り値は「デコード・制御文字除去・バックスラッシュ正規化」済みの文字列であり、
 * 常に単一の `/` から始まる (呼び出し側は素朴な文字列前提で扱ってよい契約)。
 */

const MAX_DECODE_ITERATIONS = 3;

/** スキーム付き URL (`https:`, `javascript:` 等) を検出する正規表現 */
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

/** 制御文字 (タブ・改行等) を用いた難読化を潰すため除去する */
function stripControlChars(value: string): string {
  return Array.from(value)
    .filter((ch) => ch.charCodeAt(0) > 31)
    .join('');
}

/**
 * percent-encoding による難読化 (`%2F%2Fevil.com` 等) を吸収するため、
 * 変化がなくなるまで最大 MAX_DECODE_ITERATIONS 回 decodeURIComponent する。
 * 不正なエンコードは安全側 (拒否) に倒すため、その時点の値をそのまま返す。
 */
function decodeRepeatedly(value: string): string {
  let current = value;
  for (let i = 0; i < MAX_DECODE_ITERATIONS; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      break;
    }
    if (decoded === current) break;
    current = decoded;
  }
  return current;
}

/**
 * 遷移先候補が「同一オリジンの相対パス」として安全かどうかを判定する。
 * 呼び出し側は、正規化 (制御文字除去 + バックスラッシュ→`/`変換) 済みの
 * 文字列を渡すこと。
 */
function isSafeRelativePath(normalized: string): boolean {
  if (normalized.length === 0) return false;

  // スキーム付き絶対 URL (https://, javascript: 等) を拒否する防御。
  // 実際には「先頭が単一の `/`」ルール (下記) がスキーム付き URL も
  // 包含して拒否するため冗長だが、多層防御として残す。
  if (SCHEME_PATTERN.test(normalized)) return false;

  // 単一の `/` から始まる相対パスのみ許可。`//` (プロトコル相対) は拒否
  if (!normalized.startsWith('/') || normalized.startsWith('//')) return false;

  return true;
}

/**
 * 遷移先パラメータ (`next` クエリ等) を検証し、安全な相対パスのみを返す。
 * 不正・不在の場合は null を返すので、呼び出し側でフォールバック先を決めること。
 *
 * 検証・正規化の順序:
 *   1. トリム
 *   2. percent-encoding をデコード (`decodeRepeatedly`)
 *   3. デコード後の文字列から制御文字を除去 (`stripControlChars`) —
 *      デコードによって新たに出現したタブ・改行等 (`%0A` 等) が
 *      `//` チェックを回避する経路を防ぐため、デコードの「後」に行う。
 *   4. バックスラッシュを `/` とみなして正規化
 *   5. 上記で得た正規化済み文字列を検証・返却する (検証と返却の対象を一致させる)
 */
export function getSafeRedirectPath(rawNext: string | null | undefined): string | null {
  if (!rawNext) return null;

  const trimmed = rawNext.trim();
  if (trimmed.length === 0) return null;

  const decoded = decodeRepeatedly(trimmed);

  // デコード後に出現した制御文字を除去してからバックスラッシュを正規化する
  const normalized = stripControlChars(decoded).split('\\').join('/');

  if (!isSafeRelativePath(normalized)) return null;

  return normalized;
}

/**
 * getSafeRedirectPath のフォールバック付きバージョン。
 * 不正・不在の場合は fallback (デフォルト `/home`) を返す。
 */
export function getSafeRedirectPathOrDefault(
  rawNext: string | null | undefined,
  fallback: string = '/home'
): string {
  return getSafeRedirectPath(rawNext) ?? fallback;
}
