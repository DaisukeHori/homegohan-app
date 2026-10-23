// @vitest-environment node
/**
 * #1917 一覧の API が「件数より後ろのページ」(PostgREST の 416 / PGRST103) を 500 にしないことの見張りと、
 * 共通の扱い (src/lib/api/list-range.ts の resolveBeyondLastPage) の単体テスト
 *
 * 問題:
 *   `.range(from, to)` の from が件数以上だと、PostgREST は 0 件ではなく 416 (PGRST103) の失敗を返す。
 *   最後のページの唯一の行が消えたあとの読み直しや、URL のページ番号で、一覧が「処理中にエラー」(500) になっていた
 *   (扱っていたのは組織・問い合わせ・お気に入りの一覧だけ)。
 *
 * 見張り: src/app/api の route で `.range(` を使うファイルは、範囲外のページの扱いを持つこと
 *   (resolveBeyondLastPage / isBeyondLastPage を呼ぶか、416 / PGRST103 を自分で見分ける)。
 *   限界: 扱いを持つかどうかをファイル単位で見るだけで、同じファイルの別の `.range(` が扱いを通っているかは見ない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoggerError = vi.fn();
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: (...args: unknown[]) => mockLoggerError(...args) };
    return { ...logger, withUser: () => logger };
  },
  generateRequestId: () => 'req_test',
}));

const { HTTP_RANGE_NOT_SATISFIABLE, POSTGREST_RANGE_NOT_SATISFIABLE_CODE, isBeyondLastPage, resolveBeyondLastPage } =
  await import('@/lib/api/list-range');

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'src/app/api';
/** 範囲外のページの扱いを持つことの目印 (どれか 1 つがあればよい) */
const HANDLING_MARKERS = [/\bresolveBeyondLastPage\(/, /\bisBeyondLastPage\(/, /===\s*416\b/, /'PGRST103'/];

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRouteFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** コメントを除いた本文 (行コメントとブロックコメント。文字列の中の // は URL くらいなので、ここでは気にしない) */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('一覧の route は件数より後ろのページを 500 にしない (#1917)', () => {
  it('src/app/api で .range( を使う route は、どれも範囲外のページの扱いを持つ', () => {
    const files = listRouteFiles(path.join(ROOT, SCAN_ROOT));
    const rangeFiles = files.filter((file) => /\.range\(/.test(withoutComments(fs.readFileSync(file, 'utf-8'))));
    // 一覧の route が見つからないときは、走査そのものが壊れている
    expect(rangeFiles.length).toBeGreaterThan(0);
    const missing = rangeFiles
      .filter((file) => {
        const code = withoutComments(fs.readFileSync(file, 'utf-8'));
        return !HANDLING_MARKERS.some((marker) => marker.test(code));
      })
      .map((file) => path.relative(ROOT, file));
    expect(missing).toEqual([]);
  });
});

describe('isBeyondLastPage', () => {
  it('HTTP 416 か error.code PGRST103 なら範囲外のページ', () => {
    expect(isBeyondLastPage({ message: '{"' }, HTTP_RANGE_NOT_SATISFIABLE)).toBe(true);
    expect(isBeyondLastPage({ code: POSTGREST_RANGE_NOT_SATISFIABLE_CODE, message: 'x' }, undefined)).toBe(true);
  });

  it('失敗が無い・ほかの失敗は範囲外のページにしない', () => {
    expect(isBeyondLastPage(null, HTTP_RANGE_NOT_SATISFIABLE)).toBe(false);
    expect(isBeyondLastPage({ code: '08006', message: 'connection reset' }, 500)).toBe(false);
    expect(isBeyondLastPage({ code: 'PGRST116', message: 'x' }, 406)).toBe(false);
  });
});

describe('resolveBeyondLastPage', () => {
  const ROUTE = 'GET /api/test';
  const BEYOND = { data: null, error: { code: 'PGRST103', message: 'Requested range not satisfiable' }, count: null, status: 416 };

  beforeEach(() => {
    mockLoggerError.mockClear();
  });

  it('範囲外のページは、数え直した件数と空のページにする (失敗にしない)', async () => {
    const recount = vi.fn(async () => ({ count: 7, error: null }));
    const result = await resolveBeyondLastPage(BEYOND, recount, ROUTE);
    expect(result).toEqual({ data: [], error: null, count: 7 });
    expect(recount).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('件数が 0 でも (最後の 1 件が消えた) 空のページと件数 0 にする', async () => {
    const result = await resolveBeyondLastPage(BEYOND, async () => ({ count: 0, error: null }), ROUTE);
    expect(result).toEqual({ data: [], error: null, count: 0 });
  });

  it('範囲外でない結果はそのまま返し、数え直さない', async () => {
    const recount = vi.fn(async () => ({ count: 1, error: null }));
    const ok = { data: [{ id: 1 }], error: null, count: 1, status: 200 };
    expect(await resolveBeyondLastPage(ok, recount, ROUTE)).toEqual({ data: [{ id: 1 }], error: null, count: 1 });
    const failed = { data: null, error: { code: '08006', message: 'reset' }, count: null, status: 500 };
    expect(await resolveBeyondLastPage(failed, recount, ROUTE)).toEqual({ data: null, error: failed.error, count: null });
    expect(recount).not.toHaveBeenCalled();
  });

  it('数え直しが失敗したら、元の失敗のまま返し (呼び出し側が 500 にする)、構造化ログに残す', async () => {
    const result = await resolveBeyondLastPage(BEYOND, async () => ({ count: null, error: { message: 'reset' } }), ROUTE);
    expect(result).toEqual({ data: null, error: BEYOND.error, count: null });
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it('数え直しの件数が null・例外のときも、元の失敗のまま返す', async () => {
    expect(await resolveBeyondLastPage(BEYOND, async () => ({ count: null, error: null }), ROUTE)).toEqual({
      data: null,
      error: BEYOND.error,
      count: null,
    });
    expect(
      await resolveBeyondLastPage(
        BEYOND,
        async () => {
          throw new Error('boom');
        },
        ROUTE,
      ),
    ).toEqual({ data: null, error: BEYOND.error, count: null });
    expect(mockLoggerError).toHaveBeenCalledTimes(2);
  });
});
