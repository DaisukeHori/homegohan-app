const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_500;
const DEFAULT_MAX_DELAY_MS = 8_000;
const MAX_ERROR_MESSAGE_LENGTH = 400;

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export type GenerateMenuV4RetryOptions = {
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export type GenerateMenuV4CallResult =
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

export type GenerateMenuV4InvokeResult<T> =
  | {
      ok: true;
      attempts: number;
      data: T | null;
    }
  | {
      ok: false;
      attempts: number;
      status?: number;
      errorMessage: string;
    };

type GenerateMenuV4CallParams = {
  supabaseUrl: string;
  serviceRoleKey: string;
  payload: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  retry?: GenerateMenuV4RetryOptions;
};

type AttemptFailure = {
  attempt: number;
  status?: number;
  detail: string;
  retryable: boolean;
};

type InvokeErrorLike = {
  message?: string;
  status?: number;
  context?: {
    status?: number;
    text?: () => Promise<string>;
  };
};

function normalizeRetryOptions(retry?: GenerateMenuV4RetryOptions): Required<GenerateMenuV4RetryOptions> {
  return {
    timeoutMs: Math.max(1_000, retry?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    maxAttempts: Math.max(1, retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    baseDelayMs: Math.max(100, retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS),
    maxDelayMs: Math.max(100, retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS),
  };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? 'unknown_error');
}

function compactAndTruncate(message: string, maxLen = MAX_ERROR_MESSAGE_LENGTH): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 3)}...`;
}

function isRetryableErrorMessage(message: string): boolean {
  return /(timeout|timed out|network|fetch failed|connection|econn|enotfound|socket|temporar|bad gateway|service unavailable)/i.test(
    message
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

function parseStatusFromMessage(message: string): number | undefined {
  const match = message.match(/\b([45]\d{2})\b/);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : undefined;
}

async function extractInvokeFailure(error: unknown): Promise<{ status?: number; detail: string }> {
  const invokeError = (error ?? {}) as InvokeErrorLike;
  const baseMessage = compactAndTruncate(
    invokeError.message || toErrorMessage(error) || 'unknown invoke error'
  );
  const status = invokeError.context?.status || invokeError.status || parseStatusFromMessage(baseMessage);

  let contextText = '';
  if (invokeError.context?.text) {
    contextText = compactAndTruncate(await invokeError.context.text().catch(() => ''));
  }

  if (status != null) {
    const detail = contextText
      ? `status ${status}, body=${contextText}`
      : `status ${status}, error=${baseMessage}`;
    return { status, detail };
  }

  return { detail: contextText ? `${baseMessage}, body=${contextText}` : baseMessage };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFinalFailureMessage(failure: AttemptFailure | null, maxAttempts: number): string {
  if (!failure) {
    return `generate-menu-v4 failed after ${maxAttempts} attempts`;
  }
  return `generate-menu-v4 failed after ${failure.attempt}/${maxAttempts} attempts: ${failure.detail}`;
}

export async function callGenerateMenuV4WithRetry(params: GenerateMenuV4CallParams): Promise<GenerateMenuV4CallResult> {
  const { timeoutMs, maxAttempts, baseDelayMs, maxDelayMs } = normalizeRetryOptions(params.retry);
  const supabaseUrl = params.supabaseUrl.replace(/\/+$/, '');
  const url = `${supabaseUrl}/functions/v1/generate-menu-v4`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${params.serviceRoleKey}`,
    ...params.extraHeaders,
  };

  let lastFailure: AttemptFailure | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params.payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        return { ok: true, attempts: attempt, response };
      }

      const responseText = await response.text().catch(() => '');
      const compactText = compactAndTruncate(responseText);
      const detail = compactText
        ? `status ${response.status}, body=${compactText}`
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

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function invokeGenerateMenuV4WithRetry<T>(params: {
  invoke: () => Promise<{ data: T | null; error: unknown }>;
  retry?: GenerateMenuV4RetryOptions;
}): Promise<GenerateMenuV4InvokeResult<T>> {
  const { timeoutMs, maxAttempts, baseDelayMs, maxDelayMs } = normalizeRetryOptions(params.retry);
  let lastFailure: AttemptFailure | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data, error } = await withTimeout(params.invoke, timeoutMs);
      if (!error) {
        return { ok: true, attempts: attempt, data };
      }

      const { status, detail } = await extractInvokeFailure(error);
      const retryable = status != null ? shouldRetryStatus(status) : isRetryableErrorMessage(detail);
      lastFailure = { attempt, status, detail, retryable };

      if (!retryable || attempt >= maxAttempts) {
        break;
      }
    } catch (error) {
      const detail = compactAndTruncate(toErrorMessage(error));
      const retryable = isRetryableErrorMessage(detail);
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

export async function markWeeklyMenuRequestFailed(params: {
  supabase: any;
  requestId: string;
  errorMessage: string;
}): Promise<void> {
  const message = compactAndTruncate(params.errorMessage || 'unknown_error');
  const { error } = await params.supabase
    .from('weekly_menu_requests')
    .update({
      status: 'failed',
      error_message: message,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.requestId);

  if (error) {
    console.error('Failed to update weekly_menu_requests as failed:', {
      requestId: params.requestId,
      updateError: error.message,
      originalError: message,
    });
  }
}
