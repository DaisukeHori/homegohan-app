// @vitest-environment node
/**
 * #1444 (CodeQL js/insecure-randomness) の回帰テスト。
 *
 * generateRequestId (Web 側 src/lib/db-logger.ts と Edge 側 supabase/functions/_shared/db-logger.ts) の乱数の部分は
 * crypto.getRandomValues で作り、Math.random を使わない。ID の形 (req_<ミリ秒>_<英小文字と数字>) は以前と同じ。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateRequestId as generateWebRequestId } from '../src/lib/db-logger';
import { generateRequestId as generateEdgeRequestId } from '../supabase/functions/_shared/db-logger';

/** 乱数の部分の長さ (6 バイトを 16 進で書いた 12 文字) */
const RANDOM_PART_LENGTH = 12;
/** 重ならないことを確かめるときに作る数 */
const UNIQUENESS_SAMPLE = 1_000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([
  ['Web (src/lib/db-logger.ts)', generateWebRequestId],
  ['Edge (supabase/functions/_shared/db-logger.ts)', generateEdgeRequestId],
])('generateRequestId: %s', (_label, generateRequestId) => {
  it('Math.random を使わず、crypto.getRandomValues で乱数の部分を作る', () => {
    const mathRandom = vi.spyOn(Math, 'random');
    const getRandomValues = vi.spyOn(globalThis.crypto, 'getRandomValues');

    generateRequestId();

    expect(mathRandom).not.toHaveBeenCalled();
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('形は以前と同じ (req_<ミリ秒>_<英小文字と数字>)。乱数の部分は getRandomValues の値の 16 進', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_760_000_000_000);
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) array.set([0x00, 0x0f, 0xa0, 0xff, 0x12, 0x3c]);
      return array;
    });

    const id = generateRequestId();

    expect(id).toBe('req_1760000000000_000fa0ff123c');
    expect(id).toMatch(/^req_\d+_[a-z0-9]+$/);
  });

  it('乱数の部分は 12 文字で、続けて作っても重ならない', () => {
    const ids = Array.from({ length: UNIQUENESS_SAMPLE }, () => generateRequestId());
    for (const id of ids) expect(id.split('_')[2]).toHaveLength(RANDOM_PART_LENGTH);
    expect(new Set(ids).size).toBe(UNIQUENESS_SAMPLE);
  });
});
