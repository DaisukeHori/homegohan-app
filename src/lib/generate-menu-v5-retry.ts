const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_500;
const DEFAULT_MAX_DELAY_MS = 8_000;
const MAX_ERROR_MESSAGE_LENGTH = 400;

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export type GenerateMenuV5RetryOptions = {
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export type GenerateMenuV5CallResult =
  | {
      ok: true;
      attempts: number;
      response: Response;
    }
  | {
      ok: false;
      attempts: number;
      status?: number;
      errorMessage: string;
    };

type GenerateMenuV5CallParams = {
  supabaseUrl: string;
  serviceRoleKey: string;
  payload: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  retry?: GenerateMenuV5RetryOptions;
};

type AttemptFailure = {
  attempt: number;
  status?: number;
  detail: string;
  retryable: boolean;
};

function normalizeRetryOptions(retry?: GenerateMenuV5RetryOptions): Required<GenerateMenuV5RetryOptions> {
  return {
    timeoutMs: Math.max(1_000, retry?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    maxAttempts: Math.max(1, retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    baseDelayMs: Math.max(100, retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS),
    maxDelayMs: Math.max(100, retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS),
  };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown_error");
}

function compactAndTruncate(message: string, maxLen = MAX_ERROR_MESSAGE_LENGTH): string {
  const compact = message.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 3)}...`;
}

function isRetryableErrorMessage(message: string): boolean {
  return /(timeout|timed out|network|fetch failed|connection|econn|enotfound|socket|temporar|bad gateway|service unavailable)/i.test(
    message,
  );
}

function getBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * Math.min(500, baseDelayMs));
  return Math.min(maxDelayMs, exponential + jitter);
}

function shouldRetryStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFinalFailureMessage(failure: AttemptFailure | null, maxAttempts: number): string {
  if (!failure) {
    return `generate-menu-v5 failed after ${maxAttempts} attempts`;
  }
  return `generate-menu-v5 failed after ${failure.attempt}/${maxAttempts} attempts: ${failure.detail}`;
}

export async function callGenerateMenuV5WithRetry(params: GenerateMenuV5CallParams): Promise<GenerateMenuV5CallResult> {
  const { timeoutMs, maxAttempts, baseDelayMs, maxDelayMs } = normalizeRetryOptions(params.retry);
  const supabaseUrl = params.supabaseUrl.replace(/\/+$/, "");
  const url = `${supabaseUrl}/functions/v1/generate-menu-v5`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${params.serviceRoleKey}`,
    apikey: params.serviceRoleKey,
    ...params.extraHeaders,
  };

  let lastFailure: AttemptFailure | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(params.payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        return { ok: true, attempts: attempt, response };
      }

      const responseText = await response.text().catch(() => "");
      const detail = responseText
        ? `status ${response.status}, body=${compactAndTruncate(responseText)}`
        : `status ${response.status}`;
      const retryable = shouldRetryStatus(response.status);
      lastFailure = { attempt, status: response.status, detail, retryable };

      if (!retryable || attempt >= maxAttempts) {
        break;
      }
    } catch (error) {
      clearTimeout(timeout);
      const detail = isAbortError(error)
        ? `timeout after ${timeoutMs}ms`
        : compactAndTruncate(toErrorMessage(error));
      const retryable = isAbortError(error) || isRetryableErrorMessage(detail);
      lastFailure = { attempt, detail, retryable };

      if (!retryable || attempt >= maxAttempts) {
        break;
      }
    }

    await sleep(getBackoffMs(attempt, baseDelayMs, maxDelayMs));
  }

  return {
    ok: false,
    attempts: lastFailure?.attempt ?? maxAttempts,
    status: lastFailure?.status,
    errorMessage: buildFinalFailureMessage(lastFailure, maxAttempts),
  };
}
