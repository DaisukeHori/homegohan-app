/**
 * 外国の AI 事業者への提供の同意: ブラウザから同意の API を呼ぶ部品 (T15 / #1154)
 *
 * 同意画面 (src/hooks/useAiConsent.tsx) と設定ページ (src/app/(main)/settings/ai-consent/page.tsx) が使う。
 * サーバー専用のコード (src/lib/ai/consent.ts) は import しない。
 *
 * 【AI への送信は止めない】ここの関数は、失敗しても例外を投げない (結果の値で返す)。
 * 呼び出し側 (useAiConsent) は、状況が取れなかったときも AI の操作をそのまま進める。
 */
import { AI_CONSENT_VERSION, type AiConsentStatus } from './consent-config';

/** 状況の取得を待つ上限 (ミリ秒)。これを過ぎたら「取れなかった」として扱う */
const FETCH_TIMEOUT_MS = 4000;
/** 同意・撤回の送信を待つ上限 (ミリ秒)。画面が固まって見えないようにする */
const WRITE_TIMEOUT_MS = 8000;

export type ConsentApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string | null; message: string };

export type AiConsentRevokeResult = AiConsentStatus & { revokedCount: number };

function isAiConsentStatus(value: unknown): value is AiConsentStatus {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.version === 'string' && typeof v.consented === 'boolean' && Array.isArray(v.providers);
}

async function request(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: controller.signal, credentials: 'same-origin' });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function failure(result: { status: number; body: unknown } | null, fallbackMessage: string): ConsentApiResult<never> {
  const body = (result?.body ?? {}) as { error?: unknown; code?: unknown };
  return {
    ok: false,
    status: result?.status ?? 0,
    code: typeof body.code === 'string' ? body.code : null,
    message: typeof body.error === 'string' && body.error ? body.error : fallbackMessage,
  };
}

/** 同意の状況を取得する。取れなかったとき (未ログイン・通信エラー・時間切れ・想定外の応答) は null */
export async function fetchAiConsentStatus(): Promise<AiConsentStatus | null> {
  const result = await request('/api/ai/consent', { method: 'GET', cache: 'no-store' }, FETCH_TIMEOUT_MS);
  if (!result || result.status < 200 || result.status >= 300) return null;
  return isAiConsentStatus(result.body) ? result.body : null;
}

/** 同意を記録する。画面に出した文面の版 (AI_CONSENT_VERSION) を一緒に送る */
export async function postAiConsentGrant(): Promise<ConsentApiResult<AiConsentStatus>> {
  const result = await request(
    '/api/ai/consent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: AI_CONSENT_VERSION }),
    },
    WRITE_TIMEOUT_MS,
  );
  if (result && result.status >= 200 && result.status < 300 && isAiConsentStatus(result.body)) {
    return { ok: true, data: result.body };
  }
  return failure(result, '同意を記録できませんでした。通信状況を確認して、もう一度お試しください。');
}

/** 同意を撤回する */
export async function postAiConsentRevoke(): Promise<ConsentApiResult<AiConsentRevokeResult>> {
  const result = await request('/api/ai/consent/revoke', { method: 'POST' }, WRITE_TIMEOUT_MS);
  if (result && result.status >= 200 && result.status < 300 && isAiConsentStatus(result.body)) {
    const revokedCount = (result.body as { revokedCount?: unknown }).revokedCount;
    return {
      ok: true,
      data: { ...result.body, revokedCount: typeof revokedCount === 'number' ? revokedCount : 0 },
    };
  }
  return failure(result, '同意を撤回できませんでした。通信状況を確認して、もう一度お試しください。');
}
