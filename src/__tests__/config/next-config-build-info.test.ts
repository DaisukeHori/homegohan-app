import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * next.config.mjs の env (NEXT_PUBLIC_APP_VERSION / NEXT_PUBLIC_BUILD_DATE) の既定値 (#1434)
 *
 * .env.example は `NEXT_PUBLIC_APP_VERSION=` / `NEXT_PUBLIC_BUILD_DATE=` と空で書いてある。src/lib/env.ts と check:env は
 * 空・空白だけの値を未設定として扱うのに、next.config.mjs は `??` だったため、空のまま設定画面に出ていた。
 */

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as { version: string }
).version;
/** ビルド日の形 (YYYYMMDD) */
const BUILD_DATE_PATTERN = /^\d{8}$/;

// next.config.mjs は import 時に process.env を読むため、テストごとにクエリ文字列付きで動的 import して評価し直す
async function loadNextConfigEnv(): Promise<Record<string, string>> {
  vi.resetModules();
  const mod = await import(/* @vite-ignore */ `../../../next.config.mjs?t=${Date.now()}-${Math.random()}`);
  return (mod.default as { env: Record<string, string> }).env;
}

describe('next.config.mjs の env: 空の値は未設定として扱う (#1434)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['', '   '])('NEXT_PUBLIC_APP_VERSION が %j なら package.json の version を入れる', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', value);

    const env = await loadNextConfigEnv();

    expect(env.NEXT_PUBLIC_APP_VERSION).toBe(`v${PACKAGE_VERSION}`);
  });

  it.each(['', '   '])('NEXT_PUBLIC_BUILD_DATE が %j ならビルド時の日付 (YYYYMMDD) を入れる', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_BUILD_DATE', value);

    const env = await loadNextConfigEnv();

    expect(env.NEXT_PUBLIC_BUILD_DATE).toMatch(BUILD_DATE_PATTERN);
  });

  it('値が設定されていれば、加工せずにそのまま使う', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', 'v9.9.9-test');
    vi.stubEnv('NEXT_PUBLIC_BUILD_DATE', '20260101');

    const env = await loadNextConfigEnv();

    expect(env.NEXT_PUBLIC_APP_VERSION).toBe('v9.9.9-test');
    expect(env.NEXT_PUBLIC_BUILD_DATE).toBe('20260101');
  });
});

/**
 * NEXT_PUBLIC_BUILD_DATE の既定値は JST の暦日 (#1467)
 *
 * 以前は `new Date().toISOString()` (UTC の暦日) だったので、JST の 0:00〜8:59 のビルドは前日の日付になっていた
 * (#1433 の「日付は JST の暦日で決める」方針と食い違う)。テストは TZ=UTC で回すので、実行環境のタイムゾーンに
 * 頼った実装 (getDate など) もここで落ちる。
 */
describe('NEXT_PUBLIC_BUILD_DATE の既定値は JST の暦日 (#1467)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    // [UTC の時刻, JST の暦日]
    ['2026-10-10T15:00:00.000Z', '20261011'], // JST 10/11 00:00 (UTC ではまだ 10/10)
    ['2026-10-10T16:30:00.000Z', '20261011'], // JST 10/11 01:30
    ['2026-10-10T23:59:59.999Z', '20261011'], // JST 10/11 08:59:59 (UTC の日付が変わる直前)
    ['2026-10-11T00:00:00.000Z', '20261011'], // JST 10/11 09:00 (ここから UTC も同じ日)
    ['2026-10-10T14:59:59.999Z', '20261010'], // JST 10/10 23:59:59 (前日のまま)
    ['2026-12-31T15:00:00.000Z', '20270101'], // JST の元日 00:00 (年をまたぐ)
  ])('%s のビルドは %s になる', async (utc, expected) => {
    const { formatBuildDateJst } = await import('../../../shared/build-date.mjs');
    expect(formatBuildDateJst(new Date(utc))).toBe(expected);
  });

  it('packages/shared の formatLocalDate (Asia/Tokyo) と同じ日付を返す (1 日を 30 分刻みで確かめる)', async () => {
    const { formatBuildDateJst } = await import('../../../shared/build-date.mjs');
    const { formatLocalDate } = await import('@homegohan/shared');
    const STEP_MS = 30 * 60 * 1000;
    const start = Date.parse('2026-10-10T00:00:00.000Z');
    const end = Date.parse('2026-10-11T00:00:00.000Z');
    for (let t = start; t < end; t += STEP_MS) {
      const at = new Date(t);
      expect(formatBuildDateJst(at)).toBe(formatLocalDate(at, 'Asia/Tokyo').replace(/-/g, ''));
    }
  });

  it('未設定なら、JST の 0:00〜9:00 のビルドも当日の日付を next.config.mjs が入れる', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T18:00:00.000Z')); // JST 2026-10-11 03:00
    vi.stubEnv('NEXT_PUBLIC_BUILD_DATE', '');

    const env = await loadNextConfigEnv();

    expect(env.NEXT_PUBLIC_BUILD_DATE).toBe('20261011');
  });

  it('不正な Date は RangeError にする (変な日付を黙って入れない)', async () => {
    const { formatBuildDateJst } = await import('../../../shared/build-date.mjs');
    expect(() => formatBuildDateJst(new Date(Number.NaN))).toThrow(RangeError);
  });
});
