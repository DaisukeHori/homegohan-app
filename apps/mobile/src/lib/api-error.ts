/**
 * API エラーから、画面に出すメッセージを取り出す (#1137)
 *
 * @homegohan/core の createHttpClient は HTTP エラーを
 *   new Error(`HTTP ${status} ${statusText}: ${JSON.stringify(本文)}`)
 * の形で投げる。運営 API のエラー本文は { error: { code, message } } なので、
 * そのまま出すと「HTTP 403 Forbidden: {"error":{"code":"FORBIDDEN",...}}」のようになる。
 * ここでは本文の message だけを取り出す (Web の運営画面が body.error?.message を出すのと同じ)。
 *
 * 取り出せないとき (通信エラー・JSON 以外の本文など) は、Error の message、それも無ければ fallback を返す。
 */

// "HTTP 403 Forbidden: {...}" / HTTP/2 で statusText が空の "HTTP 403 : {...}" のどちらにも一致させる
const HTTP_ERROR_PATTERN = /^HTTP \d{3}[^:]*:\s*([\s\S]+)$/;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** { error: { message } } / { error: "..." } / { message: "..." } の順に message を探す */
function messageFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { error, message } = body as { error?: unknown; message?: unknown };
  if (error && typeof error === "object") {
    const nested = nonEmptyString((error as { message?: unknown }).message);
    if (nested) return nested;
  }
  return nonEmptyString(error) ?? nonEmptyString(message);
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  const raw = nonEmptyString(typeof error === "string" ? error : (error as { message?: unknown } | null | undefined)?.message);
  if (!raw) return fallback;

  const match = HTTP_ERROR_PATTERN.exec(raw);
  if (match) {
    try {
      const fromBody = messageFromBody(JSON.parse(match[1]));
      if (fromBody) return fromBody;
    } catch {
      // 本文が JSON ではない: 下で Error の message をそのまま返す
    }
  }
  return raw;
}
