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
