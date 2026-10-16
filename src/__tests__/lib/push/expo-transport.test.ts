import { describe, expect, it, vi } from 'vitest';
import { EXPO_PUSH_RECEIPTS_URL, EXPO_PUSH_SEND_URL, createExpoTransport } from '@/lib/push/expo-transport';
import type { PushMessage } from '@/lib/push/outbox';

// #1136 Expo Push Service への HTTP (src/lib/push/expo-transport.ts)。fetch は作り物で、本物の Expo には送らない。
// 設計: docs/design/mobile/06-push-send.md §6.4・§9

const ACCESS_TOKEN = 'dummy-expo-access-token';

const message = (n: number): PushMessage => ({
  to: `ExponentPushToken[dummy${n}]`,
  title: 't',
  body: 'b',
  data: { kind: 'weekly_menu_completed', path: '/menus' },
  sound: 'default',
  channelId: 'default',
  priority: 'default',
  ttl: 60,
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fetchReturning(response: Response | Error) {
  return vi.fn<typeof fetch>(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

describe('createExpoTransport (#1136)', () => {
  it('Authorization: Bearer と content-type を付けて send の URL に POST する', async () => {
    const fetchImpl = fetchReturning(jsonResponse(200, { data: [{ status: 'ok', id: 'ticket-1' }, { status: 'ok', id: 'ticket-2' }] }));
    const transport = createExpoTransport(ACCESS_TOKEN, fetchImpl);
    const messages = [message(1), message(2)];

    const outcome = await transport.send(messages);

    expect(outcome).toEqual({ ok: true, tickets: [{ status: 'ok', id: 'ticket-1' }, { status: 'ok', id: 'ticket-2' }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(EXPO_PUSH_SEND_URL);
    expect(EXPO_PUSH_SEND_URL).toBe('https://exp.host/--/api/v2/push/send');
    expect(init?.method).toBe('POST');
    expect(init?.cache).toBe('no-store');
    expect(init?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    expect(JSON.parse(String(init?.body))).toEqual(messages);
  });

  it('429 / 5xx / 通信エラーは retryable、4xx は非 retryable で errors[0].code を使う', async () => {
    const cases: Array<{ response: Response | Error; code: string; statusCode: number | null; retryable: boolean }> = [
      { response: jsonResponse(429, { errors: [{ code: 'TOO_MANY_REQUESTS', message: 'slow down' }] }), code: 'TOO_MANY_REQUESTS', statusCode: 429, retryable: true },
      { response: jsonResponse(500, { errors: [{ code: 'INTERNAL_SERVER_ERROR', message: 'oops' }] }), code: 'INTERNAL_SERVER_ERROR', statusCode: 500, retryable: true },
      { response: new Response('bad gateway', { status: 502 }), code: 'expo_http_error', statusCode: 502, retryable: true },
      { response: jsonResponse(401, { errors: [{ code: 'UNAUTHORIZED', message: 'no token' }] }), code: 'UNAUTHORIZED', statusCode: 401, retryable: false },
      { response: jsonResponse(413, { errors: [] }), code: 'expo_http_error', statusCode: 413, retryable: false },
      { response: new TypeError('fetch failed'), code: 'network_error', statusCode: null, retryable: true },
    ];
    for (const testCase of cases) {
      const transport = createExpoTransport(ACCESS_TOKEN, fetchReturning(testCase.response));
      const outcome = await transport.send([message(1)]);
      expect(outcome, testCase.code).toEqual({
        ok: false,
        failure: expect.objectContaining({ code: testCase.code, statusCode: testCase.statusCode, retryable: testCase.retryable }),
      });
    }
    // 通信エラーの文は message に入る (行の last_error_message に残すだけ)
    const network = await createExpoTransport(ACCESS_TOKEN, fetchReturning(new TypeError('fetch failed'))).send([message(1)]);
    expect(network).toEqual({ ok: false, failure: { code: 'network_error', message: 'fetch failed', statusCode: null, retryable: true } });
  });

  it('ticket の数がメッセージと違えば invalid_response', async () => {
    const short = createExpoTransport(ACCESS_TOKEN, fetchReturning(jsonResponse(200, { data: [{ status: 'ok', id: 'ticket-1' }] })));
    expect(await short.send([message(1), message(2)])).toEqual({
      ok: false,
      failure: expect.objectContaining({ code: 'invalid_response', statusCode: null, retryable: false }),
    });
    const notArray = createExpoTransport(ACCESS_TOKEN, fetchReturning(jsonResponse(200, { data: { status: 'ok' } })));
    expect(await notArray.send([message(1)])).toEqual({
      ok: false,
      failure: expect.objectContaining({ code: 'invalid_response', statusCode: null, retryable: false }),
    });
    const notJson = createExpoTransport(ACCESS_TOKEN, fetchReturning(new Response('<html>', { status: 200 })));
    expect(await notJson.send([message(1)])).toEqual({
      ok: false,
      failure: expect.objectContaining({ code: 'invalid_response', statusCode: null, retryable: false }),
    });
  });

  it('要求ごとの 400 (PUSH_TOO_MANY_EXPERIENCE_IDS) は code にその名前・statusCode 400・retryable false を返す', async () => {
    const body = {
      errors: [
        {
          code: 'PUSH_TOO_MANY_EXPERIENCE_IDS',
          message: 'All push notification messages in the same request must be for the same project',
          details: { '@owner/a': ['ExponentPushToken[dummy1]'], '@owner/b': ['ExponentPushToken[dummy2]'] },
        },
      ],
    };
    const transport = createExpoTransport(ACCESS_TOKEN, fetchReturning(jsonResponse(400, body)));

    const outcome = await transport.send([message(1), message(2)]);

    expect(outcome).toEqual({
      ok: false,
      failure: {
        code: 'PUSH_TOO_MANY_EXPERIENCE_IDS',
        message: 'All push notification messages in the same request must be for the same project',
        statusCode: 400,
        retryable: false,
      },
    });
  });

  it('getReceipts は ids を送り、data の表を返す', async () => {
    const receipts = {
      'receipt-1': { status: 'ok' },
      'receipt-2': { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    };
    const fetchImpl = fetchReturning(jsonResponse(200, { data: receipts }));
    const transport = createExpoTransport(ACCESS_TOKEN, fetchImpl);

    const outcome = await transport.getReceipts(['receipt-1', 'receipt-2']);

    expect(outcome).toEqual({ ok: true, receipts });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(EXPO_PUSH_RECEIPTS_URL);
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${ACCESS_TOKEN}` });
    expect(JSON.parse(String(init?.body))).toEqual({ ids: ['receipt-1', 'receipt-2'] });

    // 形が違えば invalid_response。HTTP の失敗は send と同じ判定
    const broken = createExpoTransport(ACCESS_TOKEN, fetchReturning(jsonResponse(200, { data: [] })));
    expect(await broken.getReceipts(['receipt-1'])).toEqual({
      ok: false,
      failure: expect.objectContaining({ code: 'invalid_response', retryable: false }),
    });
    const throttled = createExpoTransport(ACCESS_TOKEN, fetchReturning(jsonResponse(429, { errors: [{ code: 'TOO_MANY_REQUESTS' }] })));
    expect(await throttled.getReceipts(['receipt-1'])).toEqual({
      ok: false,
      failure: expect.objectContaining({ code: 'TOO_MANY_REQUESTS', statusCode: 429, retryable: true }),
    });
  });
});
