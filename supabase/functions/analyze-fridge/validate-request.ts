/**
 * analyze-fridge のリクエスト検証 (#1227)
 *
 * imageUrl はそのまま外部の Vision API (xAI) に渡り、向こうで取得される。
 * 以前は「値がある (truthy)」ことしか見ていなかったため、次のようになっていた。
 *   - 数値・真偽値・オブジェクトは、ログ出力用の imageUrl.slice(0, 80) で TypeError になり、400 ではなく 500 を返す
 *     (配列は slice が通るため、そのまま上流に渡り、上流のエラーで 500 になる)
 *   - 文字列なら、スキームを問わず (http: / data: / javascript: / file: など) そのまま上流に渡る
 * ここで、本文・型・長さ・URL の形式を確かめてから渡す。
 *
 * Deno と Vitest のどちらからも読み込めるよう、Deno 専用の API には依存しない純粋関数にしている。
 */

/**
 * imageUrl の最大文字数。
 * Supabase Storage の署名付き URL (token つき) でも通常は 1,000 文字に届かないので、余裕を見て 2,048 にしている。
 */
export const MAX_IMAGE_URL_LENGTH = 2048;

export type RejectReason =
  | 'invalid_body' // 本文が JSON のオブジェクトでない (null / 配列 / 文字列 / 数値)
  | 'missing' // imageUrl が無い (undefined / null / 空文字 / 空白だけ)
  | 'not_string' // imageUrl が文字列でない
  | 'too_long' // imageUrl が長すぎる
  | 'invalid_url' // URL として解釈できない
  | 'not_https' // https 以外のスキーム
  | 'has_credentials' // https://user:pass@host/ のように認証情報を含む
  | 'host_not_allowed'; // IP アドレスの直指定、localhost、社内向けの名前など

export type AnalyzeFridgeValidation =
  | {
      ok: true;
      /** URL パーサが正規化した値。検証したものと上流に渡すものを同じにするため、元の文字列ではなくこちらを使う */
      imageUrl: string;
      /** ログ用。URL 全体 (署名付き URL の token など) はログに残さない */
      host: string;
    }
  | {
      ok: false;
      reason: RejectReason;
      /** クライアントに返すメッセージ */
      message: string;
      /** ログ用の補足。入力された URL そのものは入れない */
      meta: Record<string, unknown>;
    };

function reject(
  reason: RejectReason,
  message: string,
  meta: Record<string, unknown> = {},
): AnalyzeFridgeValidation {
  return { ok: false, reason, message, meta };
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// 入力に由来する値をログに入れるときの上限 (巨大な文字列でログを膨らませない)
function clip(value: string, max = 64): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * 画像の配信元として使えるホスト名か。
 * 取得するのは上流 (xAI) だが、社内向けのアドレスや名前は画像の配信元として正当な用途がないので弾く。
 * URL パーサが 2130706433 や 0x7f.1 のような書き方も 127.0.0.1 の形に直すため、IPv4 は正規化後の形だけ見ればよい。
 */
function isAllowedHost(hostname: string): boolean {
  // IPv6 の直指定 ([::1] など)
  if (hostname.startsWith('[')) return false;
  // IPv4 の直指定 (127.0.0.1, 169.254.169.254, 10.0.0.1 など)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false;
  // ドットを含まない名前 (localhost や社内の短縮名)
  if (!hostname.includes('.')) return false;
  // 内部向けとして予約されている名前 (foo.localhost, printer.local, metadata.google.internal など)
  if (/\.(localhost|local|internal)\.?$/.test(hostname)) return false;
  return true;
}

function validateImageUrl(value: unknown): AnalyzeFridgeValidation {
  if (value === undefined || value === null) {
    return reject('missing', 'Image URL is required', { valueType: describeType(value) });
  }
  if (typeof value !== 'string') {
    return reject('not_string', 'Image URL must be a string', { valueType: describeType(value) });
  }
  // 巨大な文字列を URL として解釈しないよう、解釈の前に長さを見る
  if (value.length > MAX_IMAGE_URL_LENGTH) {
    return reject(
      'too_long',
      `Image URL must be ${MAX_IMAGE_URL_LENGTH} characters or fewer`,
      { length: value.length, maxLength: MAX_IMAGE_URL_LENGTH },
    );
  }
  if (value.trim() === '') {
    return reject('missing', 'Image URL is required', { valueType: 'string', length: value.length });
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject('invalid_url', 'Image URL is not a valid URL', { length: value.length });
  }

  if (url.protocol !== 'https:') {
    return reject('not_https', 'Image URL must use HTTPS', { protocol: clip(url.protocol, 32) });
  }
  // https://信頼できるホスト@別のホスト/ のように、見かけを偽る書き方を避ける
  if (url.username !== '' || url.password !== '') {
    return reject('has_credentials', 'Image URL must not contain credentials', {
      host: clip(url.hostname, 255),
    });
  }
  if (!isAllowedHost(url.hostname)) {
    return reject('host_not_allowed', 'Image URL host is not allowed', {
      host: clip(url.hostname, 255),
    });
  }

  return { ok: true, imageUrl: url.href, host: url.hostname };
}

/**
 * リクエスト本文 (JSON として読み込み済みの値) を検証する。
 * 通れば上流に渡してよい imageUrl を、通らなければ 400 で返すメッセージとログ用の情報を返す。
 */
export function validateAnalyzeFridgeRequest(body: unknown): AnalyzeFridgeValidation {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return reject('invalid_body', 'Request body must be a JSON object', {
      valueType: describeType(body),
    });
  }
  return validateImageUrl((body as Record<string, unknown>).imageUrl);
}
