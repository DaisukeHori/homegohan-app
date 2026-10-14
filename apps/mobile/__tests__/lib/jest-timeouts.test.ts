/**
 * jest-timeouts.test.ts
 * apps/mobile の Jest の時間切れの既定 (jest.timeouts.js) の検査。
 *
 *   - 1 件のテストの時間切れの既定は 30 秒、RNTL の waitFor / findBy* の待ちの既定は 5 秒
 *     (負荷の高い機械で Jest の既定の 5 秒・RNTL の既定の 1 秒を超えて、単独なら緑のテストが毎回落ちたため。根拠は jest.timeouts.js)
 *   - 環境変数 MOBILE_JEST_TEST_TIMEOUT_MS / MOBILE_JEST_ASYNC_UTIL_TIMEOUT_MS で上書きでき、正の整数でなければ止まる (黙って既定に戻さない)
 *   - 待ちの既定はテストの時間切れより小さい (逆だと、待ちが終わる前にテストが時間切れになり、待ちの余裕が意味を失う)
 *   - jest.config.js と jest.setup.js が実際にその値を使う (設定は評価して値を得る。文字列を読んで推測しない)
 *   - テストのファイルは、時間切れをファイルごとに書き換えない (書き換えると環境変数での上書きが効かないファイルができる)
 *     待ちも、既定と同じ値 ({ timeout: 5000 }) を個別に書き直さない (同じ理由)
 *   - scripts/local-ci.sh は、上書きの環境変数を mobile の段まで持ち込む
 */
import fs from 'fs';
import path from 'path';
import { waitFor } from '@testing-library/react-native';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.timeouts.js は jest.config.js から require される CommonJS
const timeouts = require('../../jest.timeouts') as {
  DEFAULT_MOBILE_JEST_TEST_TIMEOUT_MS: number;
  DEFAULT_MOBILE_JEST_ASYNC_UTIL_TIMEOUT_MS: number;
  TEST_TIMEOUT_ENV: string;
  ASYNC_UTIL_TIMEOUT_ENV: string;
  timeoutFromEnv: (env: Record<string, string | undefined>, name: string, fallback: number) => number;
  resolveMobileJestTimeouts: (env: Record<string, string | undefined>) => { testTimeout: number; asyncUtilTimeout: number };
};

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '../..');
const TESTS_DIR = path.join(MOBILE_ROOT, '__tests__');
const THIS_FILE = path.join(TESTS_DIR, 'lib', 'jest-timeouts.test.ts');
const LOCAL_CI = path.join(REPO_ROOT, 'scripts', 'local-ci.sh');

/** jest.timeouts.js の既定 (根拠は jest.timeouts.js のコメント) */
const EXPECTED_DEFAULT_TEST_TIMEOUT_MS = 30_000;
const EXPECTED_DEFAULT_ASYNC_UTIL_TIMEOUT_MS = 5_000;
/** 上書きに使う値 (既定と違い、待ち < テストを満たす値なら何でもよい) */
const OVERRIDE_TEST_TIMEOUT_MS = 45_000;
const OVERRIDE_ASYNC_UTIL_TIMEOUT_MS = 8_000;
/** RNTL 自身の待ちの既定 (これを超える待ちが通れば、jest.setup.js の設定が効いている) */
const RNTL_BUILTIN_ASYNC_UTIL_TIMEOUT_MS = 1_000;
/** 待ちの検査で条件が真になるまでの時間。RNTL 自身の既定より長く、本ファイルの既定より短い */
const CONDITION_BECOMES_TRUE_AFTER_MS = RNTL_BUILTIN_ASYNC_UTIL_TIMEOUT_MS + 500;

function listTestFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTestFiles(full);
    return /\.(test|spec)\.[jt]sx?$/.test(entry.name) ? [full] : [];
  });
}

/** 行コメント・ブロックコメントを除いた本文 (コメントの中の言及を拾わない) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('jest.timeouts.js の既定と上書き', () => {
  it('環境変数が無ければ、テストの時間切れは 30 秒、待ちの既定は 5 秒', () => {
    expect(timeouts.DEFAULT_MOBILE_JEST_TEST_TIMEOUT_MS).toBe(EXPECTED_DEFAULT_TEST_TIMEOUT_MS);
    expect(timeouts.DEFAULT_MOBILE_JEST_ASYNC_UTIL_TIMEOUT_MS).toBe(EXPECTED_DEFAULT_ASYNC_UTIL_TIMEOUT_MS);
    expect(timeouts.resolveMobileJestTimeouts({})).toEqual({
      testTimeout: EXPECTED_DEFAULT_TEST_TIMEOUT_MS,
      asyncUtilTimeout: EXPECTED_DEFAULT_ASYNC_UTIL_TIMEOUT_MS,
    });
  });

  it('環境変数で、テストの時間切れと待ちの既定を別々に上書きできる', () => {
    expect(
      timeouts.resolveMobileJestTimeouts({
        [timeouts.TEST_TIMEOUT_ENV]: String(OVERRIDE_TEST_TIMEOUT_MS),
        [timeouts.ASYNC_UTIL_TIMEOUT_ENV]: String(OVERRIDE_ASYNC_UTIL_TIMEOUT_MS),
      }),
    ).toEqual({ testTimeout: OVERRIDE_TEST_TIMEOUT_MS, asyncUtilTimeout: OVERRIDE_ASYNC_UTIL_TIMEOUT_MS });
    expect(
      timeouts.resolveMobileJestTimeouts({ [timeouts.TEST_TIMEOUT_ENV]: String(OVERRIDE_TEST_TIMEOUT_MS) }),
    ).toEqual({ testTimeout: OVERRIDE_TEST_TIMEOUT_MS, asyncUtilTimeout: EXPECTED_DEFAULT_ASYNC_UTIL_TIMEOUT_MS });
  });

  it('環境変数が正の整数でなければ止まる (黙って既定に戻さない)。空なら既定', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '30s']) {
      expect(() => timeouts.resolveMobileJestTimeouts({ [timeouts.TEST_TIMEOUT_ENV]: bad })).toThrow(timeouts.TEST_TIMEOUT_ENV);
      expect(() => timeouts.resolveMobileJestTimeouts({ [timeouts.ASYNC_UTIL_TIMEOUT_ENV]: bad })).toThrow(
        timeouts.ASYNC_UTIL_TIMEOUT_ENV,
      );
    }
    expect(timeouts.timeoutFromEnv({ [timeouts.TEST_TIMEOUT_ENV]: ' ' }, timeouts.TEST_TIMEOUT_ENV, EXPECTED_DEFAULT_TEST_TIMEOUT_MS)).toBe(
      EXPECTED_DEFAULT_TEST_TIMEOUT_MS,
    );
  });

  it('待ちの既定がテストの時間切れ以上なら止まる (待ちの余裕が意味を失うため)', () => {
    // 待ちをテストの時間切れと同じにした / テストの時間切れを待ちの既定まで縮めた
    expect(() =>
      timeouts.resolveMobileJestTimeouts({ [timeouts.ASYNC_UTIL_TIMEOUT_ENV]: String(EXPECTED_DEFAULT_TEST_TIMEOUT_MS) }),
    ).toThrow(/より小さく/);
    expect(() =>
      timeouts.resolveMobileJestTimeouts({
        [timeouts.TEST_TIMEOUT_ENV]: String(EXPECTED_DEFAULT_ASYNC_UTIL_TIMEOUT_MS),
      }),
    ).toThrow(/より小さく/);
    // 1 ミリ秒でも小さければ通る (境界)
    expect(
      timeouts.resolveMobileJestTimeouts({
        [timeouts.TEST_TIMEOUT_ENV]: String(EXPECTED_DEFAULT_ASYNC_UTIL_TIMEOUT_MS + 1),
      }),
    ).toEqual({ testTimeout: EXPECTED_DEFAULT_ASYNC_UTIL_TIMEOUT_MS + 1, asyncUtilTimeout: EXPECTED_DEFAULT_ASYNC_UTIL_TIMEOUT_MS });
  });
});

describe('jest.config.js と jest.setup.js が既定を使う', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of [timeouts.TEST_TIMEOUT_ENV, timeouts.ASYNC_UTIL_TIMEOUT_ENV]) saved[name] = process.env[name];
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('jest.config.js の testTimeout は jest.timeouts.js の値 (環境変数の上書きも効く)', () => {
    process.env[timeouts.TEST_TIMEOUT_ENV] = String(OVERRIDE_TEST_TIMEOUT_MS);
    let overridden: { testTimeout?: number } = {};
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.config.js は CommonJS の設定ファイル
      overridden = require('../../jest.config.js');
    });
    expect(overridden.testTimeout).toBe(OVERRIDE_TEST_TIMEOUT_MS);

    delete process.env[timeouts.TEST_TIMEOUT_ENV];
    let byDefault: { testTimeout?: number } = {};
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.config.js は CommonJS の設定ファイル
      byDefault = require('../../jest.config.js');
    });
    expect(byDefault.testTimeout).toBe(EXPECTED_DEFAULT_TEST_TIMEOUT_MS);
  });

  it('jest.setup.js の設定で、RNTL の waitFor は RNTL 自身の既定 (1 秒) より長く待つ', async () => {
    // 上書きの環境変数が付いた実行でも検査が成り立つよう、実際に効いている値を使う
    const { asyncUtilTimeout } = timeouts.resolveMobileJestTimeouts(process.env);
    expect(asyncUtilTimeout).toBeGreaterThan(CONDITION_BECOMES_TRUE_AFTER_MS);
    const start = Date.now();
    // 条件が真になるのは RNTL 自身の既定の待ちを過ぎてから。jest.setup.js の設定が無ければ、ここで時間切れになる
    await waitFor(() => expect(Date.now() - start).toBeGreaterThanOrEqual(CONDITION_BECOMES_TRUE_AFTER_MS));
  });
});

describe('時間切れの既定を一か所にまとめる', () => {
  it('テストのファイルは、ファイル全体の時間切れを書き換えない (jest.setTimeout を使わない)', () => {
    const offenders = listTestFiles(TESTS_DIR)
      .filter((file) => file !== THIS_FILE)
      .filter((file) => /\bjest\.setTimeout\s*\(/.test(stripComments(fs.readFileSync(file, 'utf8'))))
      .map((file) => path.relative(MOBILE_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('テストの中で数値で書いた待ち ({ timeout: N }) は、テストの時間切れより短い', () => {
    const tooLong = listTestFiles(TESTS_DIR).flatMap((file) => {
      const body = stripComments(fs.readFileSync(file, 'utf8'));
      return [...body.matchAll(/\btimeout:\s*([0-9_]+)/g)]
        .map((m) => Number(m[1].replace(/_/g, '')))
        .filter((ms) => ms >= EXPECTED_DEFAULT_TEST_TIMEOUT_MS)
        .map((ms) => `${path.relative(MOBILE_ROOT, file)}: ${ms}`);
    });
    expect(tooLong).toEqual([]);
  });

  it('テストの中で、待ちの既定と同じ値 ({ timeout: 5000 }) を書き直さない (環境変数での上書きが効かない待ちができる)', () => {
    const same = listTestFiles(TESTS_DIR)
      .filter((file) => file !== THIS_FILE)
      .flatMap((file) => {
        const body = stripComments(fs.readFileSync(file, 'utf8'));
        return [...body.matchAll(/\btimeout:\s*([0-9_]+)/g)]
          .map((m) => Number(m[1].replace(/_/g, '')))
          .filter((ms) => ms === EXPECTED_DEFAULT_ASYNC_UTIL_TIMEOUT_MS)
          .map((ms) => `${path.relative(MOBILE_ROOT, file)}: ${ms}`);
      });
    expect(same).toEqual([]);
  });

  it('scripts/local-ci.sh は、時間切れを上書きする環境変数を子プロセスに持ち込む', () => {
    const text = fs.readFileSync(LOCAL_CI, 'utf8');
    const m = /^readonly ENV_ALLOWLIST="([^"]*)"$/m.exec(text);
    expect(m).not.toBeNull();
    const names = (m?.[1] ?? '').split(/\s+/);
    expect(names).toContain(timeouts.TEST_TIMEOUT_ENV);
    expect(names).toContain(timeouts.ASYNC_UTIL_TIMEOUT_ENV);
  });
});
