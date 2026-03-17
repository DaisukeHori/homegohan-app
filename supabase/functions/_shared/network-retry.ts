export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  label?: string;
  shouldRetry?: (error: any) => boolean;
}

export interface TimeoutOptions {
  timeoutMs?: number;
  label?: string;
}

export interface FetchRetryOptions extends RetryOptions, TimeoutOptions {}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getErrorStatus(error: any): number | null {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status ?? null;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

export function isRetryableStatus(status: number | null | undefined): boolean {
  if (status == null) return false;
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function isRetryableError(error: any): boolean {
  const status = getErrorStatus(error);
  if (isRetryableStatus(status)) return true;

  const name = String(error?.name ?? "");
  if (name === "AbortError") return true;

  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("connection reset") ||
    message.includes("socket hang up") ||
    message.includes("temporarily unavailable")
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 800;
  const label = opts.label ?? "retryable";
  const shouldRetry = opts.shouldRetry ?? isRetryableError;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries || !shouldRetry(error)) {
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      const status = getErrorStatus(error);
      console.log(`⏳ ${label}: retry in ${delay}ms (attempt ${attempt + 1}/${retries}) status=${status ?? "n/a"}`);
      await sleep(delay);
    }
  }

  throw lastError;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  opts: TimeoutOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const label = opts.label ?? "operation";

  return await new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`) as Error & { status?: number };
      error.status = 504;
      reject(error);
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  opts: TimeoutOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const label = opts.label ?? "request";
  const controller = new AbortController();
  const externalSignal = init.signal;
  let timedOut = false;

  const onAbort = () => {
    controller.abort(externalSignal?.reason ?? "aborted");
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason ?? "aborted");
    } else {
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(`${label}_timeout`);
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`) as Error & { status?: number };
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onAbort);
    }
  }
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit = {},
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const label = opts.label ?? "request";

  return await withRetry(async () => {
    const response = await fetchWithTimeout(input, init, opts);
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const error = new Error(`${label} failed: ${response.status}${errorText ? ` - ${errorText}` : ""}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return response;
  }, opts);
}
