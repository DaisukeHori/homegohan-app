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
 *
 * 許可対象:
 *   - `/` から始まる相対パス (`/home`, `/invite/xxx?a=b` 等)
 */

const MAX_DECODE_ITERATIONS = 3;

/** スキーム付き URL (`https:`, `javascript:` 等) を検出する正規表現 */
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

/** 制御文字 (タブ・改行等) を用いた難読化を潰すため事前に除去する */
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
 */
function isSafeRelativePath(candidate: string): boolean {
  if (candidate.length === 0) return false;

  // スキーム付き絶対 URL (https://, javascript: 等) は拒否
  if (SCHEME_PATTERN.test(candidate)) return false;

  // バックスラッシュを `/` とみなして正規化した上で判定する
  // (ブラウザの URL パーサがバックスラッシュを `/` と等価に扱うため)
  const normalized = candidate.split('\\').join('/');

  // 単一の `/` から始まる相対パスのみ許可。`//` (プロトコル相対) は拒否
  if (!normalized.startsWith('/') || normalized.startsWith('//')) return false;

  return true;
}

/**
 * 遷移先パラメータ (`next` クエリ等) を検証し、安全な相対パスのみを返す。
 * 不正・不在の場合は null を返すので、呼び出し側でフォールバック先を決めること。
 */
export function getSafeRedirectPath(rawNext: string | null | undefined): string | null {
  if (!rawNext) return null;

  const trimmed = stripControlChars(rawNext.trim());
  if (trimmed.length === 0) return null;

  const candidate = decodeRepeatedly(trimmed);

  if (!isSafeRelativePath(candidate)) return null;

  return candidate;
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
