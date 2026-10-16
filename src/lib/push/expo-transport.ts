/**
 * Expo Push Service への HTTP (#1136)。Expo を呼ぶのはこのファイルだけ (tests/push-expo-boundary-scan.test.ts が見張る)。
 * 送信 (push/send) と receipt (push/getReceipts) の 2 つの API を fetch で呼び、応答を ./outbox の Zod で検証する。
 * 再試行の判定: 通信エラー・429・5xx → retryable、それ以外の 4xx・応答の形の誤り → 非 retryable (Expo 公式)。
 * 4xx (429 以外) を 2 件以上の塊で受けたときに 1 件ずつ送り直すのは worker (./outbox の sendBatch) で、ここは 1 回の要求の結果を返すだけ。
 * 設計: docs/design/mobile/06-push-send.md §6.4
 */
import { z } from 'zod';
import {
  ExpoPushReceiptSchema, ExpoPushTicketSchema, HTTP_TOO_MANY_REQUESTS, PUSH_OUTBOX_ERROR_CODES,
  type PushMessage, type PushReceiptsOutcome, type PushSendOutcome, type PushTransport, type PushTransportFailure,
} from './outbox';

export const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
/** 429 (HTTP_TOO_MANY_REQUESTS。正は ./outbox) と 5xx は待てば直る (Expo 公式)。それ以外の 4xx は直らない */
const HTTP_SERVER_ERROR_MIN = 500;
const SendResponseSchema = z.object({ data: z.array(ExpoPushTicketSchema) });
const ReceiptsResponseSchema = z.object({ data: z.record(z.string(), ExpoPushReceiptSchema) });
const ErrorResponseSchema = z.object({ errors: z.array(z.object({ code: z.string().optional(), message: z.string().optional() })) });

function httpFailure(status: number, body: unknown): PushTransportFailure {
  const parsed = ErrorResponseSchema.safeParse(body);
  const code = parsed.success ? (parsed.data.errors[0]?.code ?? PUSH_OUTBOX_ERROR_CODES.HTTP_ERROR) : PUSH_OUTBOX_ERROR_CODES.HTTP_ERROR;
  const message = parsed.success ? (parsed.data.errors[0]?.message ?? code) : code;
  return { code, message, statusCode: status, retryable: status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR_MIN };
}
async function post(url: string, accessToken: string, body: unknown, fetchImpl: typeof fetch): Promise<{ ok: true; json: unknown } | { ok: false; failure: PushTransportFailure }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, failure: { code: PUSH_OUTBOX_ERROR_CODES.NETWORK_ERROR, message: error instanceof Error ? error.message : String(error), statusCode: null, retryable: true } };
  }
  let json: unknown = null;
  try { json = await response.json(); } catch { json = null; }
  if (!response.ok) return { ok: false, failure: httpFailure(response.status, json) };
  return { ok: true, json };
}
/** accessToken は route が EXPO_ACCESS_TOKEN から渡す。fetchImpl はテストが差し替える */
export function createExpoTransport(accessToken: string, fetchImpl: typeof fetch = fetch): PushTransport {
  return {
    async send(messages: readonly PushMessage[]): Promise<PushSendOutcome> {
      const result = await post(EXPO_PUSH_SEND_URL, accessToken, messages, fetchImpl);
      if (!result.ok) return result;
      const parsed = SendResponseSchema.safeParse(result.json);
      if (!parsed.success || parsed.data.data.length !== messages.length) {
        return { ok: false, failure: { code: PUSH_OUTBOX_ERROR_CODES.INVALID_RESPONSE, message: 'Expo の応答が ticket の配列ではありません', statusCode: null, retryable: false } };
      }
      return { ok: true, tickets: parsed.data.data };
    },
    async getReceipts(receiptIds: readonly string[]): Promise<PushReceiptsOutcome> {
      const result = await post(EXPO_PUSH_RECEIPTS_URL, accessToken, { ids: receiptIds }, fetchImpl);
      if (!result.ok) return result;
      const parsed = ReceiptsResponseSchema.safeParse(result.json);
      if (!parsed.success) return { ok: false, failure: { code: PUSH_OUTBOX_ERROR_CODES.INVALID_RESPONSE, message: 'Expo の応答が receipt の表ではありません', statusCode: null, retryable: false } };
      return { ok: true, receipts: parsed.data.data };
    },
  };
}
