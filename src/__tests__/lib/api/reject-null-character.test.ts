/**
 * src/lib/api/reject-null-character.ts (#1657)
 *
 * route の入口で、本文 (JSON) の NULL 文字 (U+0000) を 400 INVALID_CHARACTER で断る。
 * 本文は request.clone() で読むので、断らなかったときは route がそのあと同じ本文を読める。
 * JSON として読めない本文はここでは断らない (route の既存の扱いに任せる)。
 */
import { describe, expect, it } from 'vitest';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { NULL_CHARACTER_ERROR_CODE, NULL_CHARACTER_ERROR_MESSAGE } from '@/lib/api/null-character';

const NUL = '\u0000';
const URL_FOR_TEST = 'http://localhost/api/example';

function jsonRequest(body: unknown): Request {
  return new Request(URL_FOR_TEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string | null): Request {
  return new Request(URL_FOR_TEST, { method: 'POST', body });
}

describe('rejectNullCharacterBody', () => {
  it.each([
    ['値の文字列', { note: `メモ${NUL}` }],
    ['入れ子の配列の要素', { dishes: [{ name: 'ok' }, { name: `ng${NUL}` }] }],
    ['キー', { [`key${NUL}`]: 'v' }],
    ['本文が文字列そのもの', `a${NUL}b`],
  ])('%s に NULL 文字があれば 400 INVALID_CHARACTER を返す', async (_name, body) => {
    const res = await rejectNullCharacterBody(jsonRequest(body));

    expect(res).not.toBeNull();
    expect(res?.status).toBe(400);
    expect(await res?.json()).toEqual({ error: NULL_CHARACTER_ERROR_MESSAGE, code: NULL_CHARACTER_ERROR_CODE });
  });

  it('shape を渡さない・flat なら flat の本文、nested なら nested の本文 (#1917 の続き。route のほかの本文の形に合わせる)', async () => {
    const body = { note: `メモ${NUL}` };
    const flatDefault = await rejectNullCharacterBody(jsonRequest(body));
    const flat = await rejectNullCharacterBody(jsonRequest(body), { shape: 'flat' });
    const nested = await rejectNullCharacterBody(jsonRequest(body), { shape: 'nested' });

    expect(await flatDefault?.json()).toEqual({ error: NULL_CHARACTER_ERROR_MESSAGE, code: NULL_CHARACTER_ERROR_CODE });
    expect(await flat?.json()).toEqual({ error: NULL_CHARACTER_ERROR_MESSAGE, code: NULL_CHARACTER_ERROR_CODE });
    expect(nested?.status).toBe(400);
    // error.message を読む画面 (運営の画面など) で理由の文が出る
    expect(await nested?.json()).toEqual({ error: { code: NULL_CHARACTER_ERROR_CODE, message: NULL_CHARACTER_ERROR_MESSAGE } });
  });

  it('nested でも NULL 文字が無ければ null を返す', async () => {
    expect(await rejectNullCharacterBody(jsonRequest({ note: 'ふつう' }), { shape: 'nested' })).toBeNull();
  });

  it('NULL 文字が無ければ null を返し、route はそのあと同じ本文を request.json() で読める', async () => {
    const body = { note: 'ふつうのメモ\u0001', count: 2, nested: { items: ['a', 'b'] } };
    const request = jsonRequest(body);

    expect(await rejectNullCharacterBody(request)).toBeNull();
    expect(await request.json()).toEqual(body);
  });

  it('JSON の文字列の中の「\\\\u0000」(バックスラッシュと u0000 の 6 文字) は NULL 文字ではないので断らない', async () => {
    const body = { note: '\\u0000' };
    const request = jsonRequest(body);

    expect(await rejectNullCharacterBody(request)).toBeNull();
    expect(await request.json()).toEqual(body);
  });

  it('JSON として読めない本文は断らず null を返し、route はそのあと同じ本文を読める (route の既存の扱いに任せる)', async () => {
    const broken = `{"note": "abc${NUL}`;
    const request = rawRequest(broken);

    expect(await rejectNullCharacterBody(request)).toBeNull();
    expect(await request.text()).toBe(broken);
  });

  it('本文が無いときは null を返す', async () => {
    expect(await rejectNullCharacterBody(rawRequest(null))).toBeNull();
  });
});
