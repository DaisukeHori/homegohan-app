/**
 * #1157 (T23) 運用ログ閲覧 API の入力検証・カーソル (src/lib/super-admin/app-logs.ts) の単体テスト
 *
 * route 全体の挙動 (認可・絞り込み・ページ送り) は tests/super-admin-logs-route.test.ts で確かめる。
 * ここでは、route が PostgREST の絞り込み文字列 (or=(...)) に埋め込む前の入力を、純粋関数として細かく確かめる。
 *   - 日時: 形だけでなく暦も見る (Date.parse は 2 月 30 日を 3 月 2 日に直して通してしまう)
 *   - カーソル: DB が返した日時と id だけを通す。絞り込みの記号を含む値は通さない (or 条件を書き換えさせない)
 *   - クエリ: 空文字は指定なし、limit は範囲内に直す
 */
import { describe, expect, it } from 'vitest';
import {
  APP_LOGS_DEFAULT_LIMIT,
  APP_LOGS_MAX_LIMIT,
  decodeAppLogCursor,
  encodeAppLogCursor,
  isValidIsoDateTime,
  olderThanCursorFilter,
  parseAppLogsQuery,
} from '../src/lib/super-admin/app-logs';

const ID = '00000000-0000-4000-8000-000000000001';
const TS = '2026-10-08T05:00:00.123456+00:00';

const params = (query: string) => new URLSearchParams(query);
const encodeRaw = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('isValidIsoDateTime', () => {
  it.each([
    '2026-10-08T05:00:00Z',
    '2026-10-08T05:00:00.1Z',
    '2026-10-08T05:00:00.123Z',
    '2026-10-08T05:00:00.123456Z',
    '2026-10-08T05:00:00.123456+00:00', // PostgREST が timestamptz を返す形
    '2026-10-08T14:00:00+09:00',
    '2026-10-08T14:00:00-05:30',
    '2024-02-29T00:00:00Z', // うるう日
    '2026-12-31T23:59:59Z',
    '1970-01-01T00:00:00Z',
  ])('%s は正しい', (value) => {
    expect(isValidIsoDateTime(value)).toBe(true);
  });

  it.each([
    ['空文字', ''],
    ['日付だけ', '2026-10-08'],
    ['時差が無い', '2026-10-08T05:00:00'],
    ['T の代わりに空白', '2026-10-08 05:00:00Z'],
    ['うるう年でない年の 2 月 29 日', '2026-02-29T00:00:00Z'],
    ['2 月 30 日', '2026-02-30T00:00:00Z'],
    ['30 日までの月の 31 日', '2026-04-31T00:00:00Z'],
    ['0 月', '2026-00-10T00:00:00Z'],
    ['13 月', '2026-13-10T00:00:00Z'],
    ['0 日', '2026-10-00T00:00:00Z'],
    ['24 時', '2026-10-08T24:00:00Z'],
    ['60 分', '2026-10-08T23:60:00Z'],
    ['60 秒', '2026-10-08T23:59:60Z'],
    ['小数部が 7 桁', '2026-10-08T05:00:00.1234567Z'],
    ['小数点だけで数字が無い', '2026-10-08T05:00:00.Z'],
    ['時差が 24 時間以上', '2026-10-08T05:00:00+24:00'],
    ['時差の分が 60 以上', '2026-10-08T05:00:00+09:60'],
    ['コロンの無い時差 (+0900)', '2026-10-08T05:00:00+0900'],
    ['時だけの時差 (+09)', '2026-10-08T05:00:00+09'],
    ['1970 年より前', '1969-12-31T23:59:59Z'],
    ['年 0', '0000-01-01T00:00:00Z'],
    ['前後に余計な文字 (改行)', '2026-10-08T05:00:00Z\n'],
    ['前後に余計な文字 (カンマ)', '2026-10-08T05:00:00Z,id.eq.x'],
  ])('%s は正しくない', (_label, value) => {
    expect(isValidIsoDateTime(value)).toBe(false);
  });

  it('文字列以外は正しくない', () => {
    for (const value of [null, undefined, 0, 1791435600000, {}, [], true]) {
      expect(isValidIsoDateTime(value)).toBe(false);
    }
  });
});

describe('カーソル', () => {
  it('encode したものを decode すると、日時は DB が返した文字列のまま (マイクロ秒を丸めない) 戻る', () => {
    for (const createdAt of [TS, '2026-10-08T05:00:00+00:00', '2026-10-08T05:00:00.5+00:00', '2026-10-08T14:00:00.000001+09:00']) {
      expect(decodeAppLogCursor(encodeAppLogCursor({ created_at: createdAt, id: ID }))).toEqual({
        created_at: createdAt,
        id: ID,
      });
    }
  });

  it('文字列は URL にそのまま載せられる (base64url。+ / = を含まない)', () => {
    const encoded = encodeAppLogCursor({ created_at: TS, id: ID });

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  it('UUID は大文字でも通る', () => {
    const upper = ID.replace(/[a-f]/g, (c) => c.toUpperCase()).replace('4000-8000', '4ABC-8DEF');

    expect(decodeAppLogCursor(encodeAppLogCursor({ created_at: TS, id: upper }))?.id).toBe(upper);
  });

  it('encode: 次のページで必ず 400 になる行 (日時・id が想定外の形) は、黙って作らず例外にする', () => {
    expect(() => encodeAppLogCursor({ created_at: 'garbage', id: ID })).toThrow();
    expect(() => encodeAppLogCursor({ created_at: TS, id: 'not-a-uuid' })).toThrow();
    expect(() => encodeAppLogCursor({ created_at: '2026-10-08T05:00:00', id: ID })).toThrow();
  });

  it.each([
    ['空文字', ''],
    ['base64url でない', '!!!!'],
    ['JSON でない', encodeRaw('x').slice(0, 4)],
    ['null', encodeRaw(null)],
    ['空のオブジェクト', encodeRaw({})],
    ['オブジェクトで日時と id を持つ (配列でない)', encodeRaw({ created_at: TS, id: ID })],
    ['要素が 1 つ', encodeRaw([TS])],
    ['要素が 3 つ', encodeRaw([TS, ID, 'extra'])],
    ['要素が数値', encodeRaw([1791435600, 1])],
    ['日時が文字列でない', encodeRaw([null, ID])],
    ['日時の形が違う', encodeRaw(['yesterday', ID])],
    ['存在しない日', encodeRaw(['2026-02-30T00:00:00Z', ID])],
    ['id が UUID でない', encodeRaw([TS, '1'])],
    ['id が SQL / 絞り込みの記号を含む', encodeRaw([TS, `${ID},id.not.is.null`])],
    ['日時が絞り込みの記号 (閉じ括弧・カンマ) を含む', encodeRaw(['2026-10-08T00:00:00Z),id.not.is.null,and(id.eq.x', ID])],
    ['日時の後ろに絞り込みを足す', encodeRaw([`${TS},id.not.is.null`, ID])],
  ])('decode: %s は null (例外にしない)', (_label, raw) => {
    expect(decodeAppLogCursor(raw)).toBeNull();
  });

  it('decode: 非常に長い入力でも例外を出さず null', () => {
    expect(decodeAppLogCursor('A'.repeat(100_000))).toBeNull();
  });

  it('「このカーソルより古い行」の絞り込みは、新しい順の並びに合わせた形 (created_at が小さい、または同時刻で id が小さい)', () => {
    expect(olderThanCursorFilter({ created_at: TS, id: ID })).toBe(
      `created_at.lt.${TS},and(created_at.eq.${TS},id.lt.${ID})`,
    );
  });
});

describe('parseAppLogsQuery', () => {
  it('何も指定しなければ、絞り込み無し・既定の件数', () => {
    const result = parseAppLogsQuery(params(''));

    expect(result).toEqual({ ok: true, query: { limit: APP_LOGS_DEFAULT_LIMIT, cursor: undefined } });
    expect(APP_LOGS_DEFAULT_LIMIT).toBe(50);
    expect(APP_LOGS_MAX_LIMIT).toBe(200);
  });

  it('全部の絞り込みを読む (列名は API の項目名 = app_logs の列名)', () => {
    const cursor = encodeAppLogCursor({ created_at: TS, id: ID });
    const result = parseAppLogsQuery(
      params(
        `level=error&source=api-route&function_name=GET%20%2Fapi%2Fx&user_id=${ID}&request_id=req_1` +
          `&from=2026-10-08T00:00:00Z&to=2026-10-09T00:00:00Z&cursor=${cursor}&limit=20`,
      ),
    );

    expect(result).toEqual({
      ok: true,
      query: {
        level: 'error',
        source: 'api-route',
        function_name: 'GET /api/x',
        user_id: ID,
        request_id: 'req_1',
        from: '2026-10-08T00:00:00Z',
        to: '2026-10-09T00:00:00Z',
        cursor: { created_at: TS, id: ID },
        limit: 20,
      },
    });
  });

  it('前後の空白は取り除く。空文字・空白だけは指定なし', () => {
    const result = parseAppLogsQuery(params('level=%20warn%20&source=&function_name=%20%20&request_id=%09'));

    expect(result).toEqual({ ok: true, query: { level: 'warn', limit: 50, cursor: undefined } });
  });

  it('同じパラメータが複数あるときは先頭を使う', () => {
    const result = parseAppLogsQuery(params('level=error&level=warn'));

    expect(result.ok && result.query.level).toBe('error');
  });

  it('知らないパラメータは無視する', () => {
    expect(parseAppLogsQuery(params('page=2&per_page=10&sort=asc&q=x'))).toEqual({
      ok: true,
      query: { limit: 50, cursor: undefined },
    });
  });

  it.each([
    ['', 50],
    ['abc', 50],
    ['NaN', 50],
    ['Infinity', 50],
    ['0', 1],
    ['-5', 1],
    ['1', 1],
    ['7.9', 7],
    ['200', 200],
    ['201', 200],
    ['1000000', 200],
  ])('limit=%s は %i 件に直す (400 にはしない)', (raw, expected) => {
    const result = parseAppLogsQuery(params(`limit=${raw}`));

    expect(result.ok && result.query.limit).toBe(expected);
  });

  it('level は debug / info / warn / error だけ', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) {
      expect(parseAppLogsQuery(params(`level=${level}`)).ok).toBe(true);
    }
    for (const level of ['fatal', 'ERROR', 'warning', 'trace']) {
      expect(parseAppLogsQuery(params(`level=${level}`)).ok).toBe(false);
    }
  });

  it('文字数の上限: source 64 / function_name 200 / request_id 200 (超えると 400)', () => {
    expect(parseAppLogsQuery(params(`source=${'a'.repeat(64)}`)).ok).toBe(true);
    expect(parseAppLogsQuery(params(`source=${'a'.repeat(65)}`)).ok).toBe(false);
    expect(parseAppLogsQuery(params(`function_name=${'a'.repeat(200)}`)).ok).toBe(true);
    expect(parseAppLogsQuery(params(`function_name=${'a'.repeat(201)}`)).ok).toBe(false);
    expect(parseAppLogsQuery(params(`request_id=${'a'.repeat(200)}`)).ok).toBe(true);
    expect(parseAppLogsQuery(params(`request_id=${'a'.repeat(201)}`)).ok).toBe(false);
  });

  it('エラーは項目ごとにまとめて返す (複数の誤りを一度に伝える)', () => {
    const result = parseAppLogsQuery(params('level=fatal&user_id=1&from=x&cursor=%21'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.details.fieldErrors).sort()).toEqual(['cursor', 'from', 'level', 'user_id']);
    expect(result.details.formErrors).toEqual([]);
  });

  it('from が to より後なら from のエラー。同じ時刻、または時差違いで同じ瞬間なら通る', () => {
    const after = parseAppLogsQuery(params('from=2026-10-09T00:00:00Z&to=2026-10-08T00:00:00Z'));
    expect(after.ok).toBe(false);
    if (!after.ok) expect(Object.keys(after.details.fieldErrors)).toEqual(['from']);

    expect(parseAppLogsQuery(params('from=2026-10-08T00:00:00Z&to=2026-10-08T00:00:00Z')).ok).toBe(true);
    // 2026-10-08T09:00:00+09:00 は 2026-10-08T00:00:00Z と同じ瞬間
    expect(parseAppLogsQuery(params('from=2026-10-08T09:00:00%2B09:00&to=2026-10-08T00:00:00Z')).ok).toBe(true);
    // 時差を考えると from の方が後 (2026-10-08T10:00:00+09:00 = 01:00Z)
    expect(parseAppLogsQuery(params('from=2026-10-08T10:00:00%2B09:00&to=2026-10-08T00:00:00Z')).ok).toBe(false);
  });

  it('from だけ誤っていても、to との比較の追加エラーは出さない (誤りを二重に言わない)', () => {
    const result = parseAppLogsQuery(params('from=garbage&to=2026-10-08T00:00:00Z'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.details.fieldErrors.from).toHaveLength(1);
  });
});
