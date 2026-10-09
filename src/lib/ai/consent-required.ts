/**
 * 外国の AI 事業者への提供の同意: サーバーに「同意が必要です」で止められたことを画面に伝える部品 (T15 / #1154。ブラウザ用)
 *
 * AI へ送る API は、未同意の利用者のデータを送らずに 403 { code: 'AI_CONSENT_REQUIRED' } を返す
 * (src/lib/ai/consent-guard.ts / supabase/functions/_shared/ai-consent-guard.ts)。
 * 利用者が始めた AI の操作の fetch は、fetch の代わりに aiFetch を使う。aiFetch はこの応答を見つけたら
 * window に AI_CONSENT_REQUIRED_EVENT を出し、全画面共通の AiConsentRequiredHost (src/components/consent) が同意画面を出す。
 * 呼び出し側は、応答が isAiConsentRequiredResponse なら自分のエラー表示を出さずに終える (同意画面が案内する)。
 *
 * 画面を開くと自動で AI に送る処理 (ホームの栄養アドバイスなど) は aiFetch を使わない (同意画面を勝手に出さない)。
 * 403 を受けたら、AI の部分を出さないだけにする。
 */
import { AI_CONSENT_REQUIRED_MESSAGE, AI_CONSENT_REQUIRED_STATUS, isAiConsentRequiredBody } from './consent-config';

/** 「同意が必要です」で止められたことを知らせる window のイベント */
export const AI_CONSENT_REQUIRED_EVENT = 'homegohan:ai-consent-required';

/** 応答が「未同意で止めた」(403 + AI_CONSENT_REQUIRED) か。本文は clone して読むので、呼び出し側はあとで本文を読める */
export async function isAiConsentRequiredResponse(res: Response): Promise<boolean> {
  if (res.status !== AI_CONSENT_REQUIRED_STATUS) return false;
  try {
    return isAiConsentRequiredBody(await res.clone().json());
  } catch {
    return false;
  }
}

/** 同意画面を出すよう、全画面共通の AiConsentRequiredHost に知らせる */
export function notifyAiConsentRequired(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(AI_CONSENT_REQUIRED_EVENT));
}

/**
 * 「同意が必要です」で止められたことを表す例外。fetch を包む部品 (useV4MenuGeneration など) が投げ、
 * 呼び出し側はこれを見て自分のエラー表示を省く (同意画面は AiConsentRequiredHost が出している)。
 */
export class AiConsentRequiredError extends Error {
  constructor() {
    super(AI_CONSENT_REQUIRED_MESSAGE);
    this.name = 'AiConsentRequiredError';
  }
}

/**
 * 利用者が始めた AI の操作の fetch。応答が「同意が必要です」なら同意画面を出す (応答はそのまま返す)。
 * 呼び出し側は isAiConsentRequiredResponse(res) で確かめて、自分のエラー表示を省く。
 */
export async function aiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (await isAiConsentRequiredResponse(res)) notifyAiConsentRequired();
  return res;
}
