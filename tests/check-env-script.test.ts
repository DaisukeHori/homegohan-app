// @vitest-environment node
/**
 * tests/check-env-script.test.ts
 *
 * #1182: `npm run check:env` (scripts/check-env.mjs → scripts/lib/check-env.mjs) の契約テスト。
 *
 *   - 引数の解釈 (--file / --strict / --help)。Node.js 自身が横取りする --env-file は使わない
 *   - .env ファイルと実行中の環境変数の合成 (.env.local が .env より優先、実行中の環境変数がファイルより優先)
 *   - 必須の変数が欠けたら終了コード 1、任意の変数の未設定は説明を出すだけで終了コード 0
 *   - --strict は任意の変数の「値の形式の誤り」「組の片方だけの設定」を失敗にする (未設定だけでは失敗にしない)
 *   - 環境変数の値を出力に出さない
 *   - 実際の CLI (node scripts/check-env.mjs) が、TypeScript の src/lib/env.ts を直接読み込んで動くこと
 *
 * ファイルと環境変数は差し替える (CLI のテストだけ、一時ディレクトリの .env を使う)。本物の .env.local は読まない。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_ENV_FILES,
  USAGE,
  UsageError,
  collectEnvSource,
  formatReport,
  loadEnvModule,
  main,
  parseArgs,
} from '../scripts/lib/check-env.mjs';

const ROOT = path.resolve(__dirname, '..');

const SECRET_SERVICE = 'service-role-secret-do-not-print';
const SECRET_ANON = 'anon-key-secret-do-not-print';
const SECRET_RESEND = 're_secret_do_not_print';

const REQUIRED_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: SECRET_ANON,
  SUPABASE_SERVICE_ROLE_KEY: SECRET_SERVICE,
};

/** main() を、ファイルシステムを差し替えて実行する */
async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  files: Record<string, string> = {},
  overrides: Record<string, unknown> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, env, {
    log: (line: string) => out.push(line),
    errorLog: (line: string) => err.push(line),
    cwd: '/virtual',
    existsSync: (file: string) => Object.prototype.hasOwnProperty.call(files, file),
    readFileSync: (file: string) => Buffer.from(files[file] ?? ''),
    ...overrides,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('parseArgs', () => {
  it('引数なしなら既定値', () => {
    expect(parseArgs([])).toEqual({ envFiles: [], strict: false, help: false });
  });

  it('--file は繰り返し指定でき、--strict と -h / --help を解釈する', () => {
    expect(parseArgs(['--file=a.env', '--file=b.env', '--strict'])).toEqual({
      envFiles: ['a.env', 'b.env'],
      strict: true,
      help: false,
    });
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it.each([['--bogus'], ['positional'], ['--file'], ['--file='], ['--env-file=x.env']])(
    '%s は UsageError (--env-file は Node.js が先に横取りするので受け付けない)',
    (arg) => {
      expect(() => parseArgs([arg])).toThrow(UsageError);
    },
  );
});

describe('collectEnvSource', () => {
  const existsAll = () => true;

  it('.env.local が .env より優先され、実行中の環境変数がファイルより優先される', () => {
    const files: Record<string, string> = {
      '/virtual/.env.local': 'A=local\nB=local\n',
      '/virtual/.env': 'A=dotenv\nC=dotenv\nD=dotenv\n',
    };

    const { source, loadedFiles } = collectEnvSource({
      envFiles: [],
      env: { B: 'process', E: 'process' },
      cwd: '/virtual',
      existsSync: (file: string) => file in files,
      readFileSync: (file: string) => Buffer.from(files[file]),
    });

    expect(loadedFiles).toEqual(['.env.local', '.env']);
    expect(source).toMatchObject({ A: 'local', B: 'process', C: 'dotenv', D: 'dotenv', E: 'process' });
  });

  it('既定のファイルが無ければ読み飛ばし、実行中の環境変数だけで検査する', () => {
    const { source, loadedFiles } = collectEnvSource({
      envFiles: [],
      env: { X: '1' },
      cwd: '/virtual',
      existsSync: () => false,
      readFileSync: () => Buffer.from(''),
    });

    expect(loadedFiles).toEqual([]);
    expect(source).toEqual({ X: '1' });
    expect(DEFAULT_ENV_FILES).toEqual(['.env.local', '.env']);
  });

  it('--file で指定したファイルが無ければ UsageError', () => {
    expect(() =>
      collectEnvSource({
        envFiles: ['missing.env'],
        env: {},
        cwd: '/virtual',
        existsSync: () => false,
        readFileSync: () => Buffer.from(''),
      }),
    ).toThrow(UsageError);
  });

  it('--file を指定したときは既定のファイル (.env.local / .env) を読まない', () => {
    const read: string[] = [];
    collectEnvSource({
      envFiles: ['only.env'],
      env: {},
      cwd: '/virtual',
      existsSync: existsAll,
      readFileSync: (file: string) => {
        read.push(file);
        return Buffer.from('A=1');
      },
    });

    expect(read).toEqual(['/virtual/only.env']);
  });

  it('空の環境変数も、ファイルの値を上書きする (Next.js と同じ。アプリが見る値に合わせる)', () => {
    const { source } = collectEnvSource({
      envFiles: [],
      env: { A: '' },
      cwd: '/virtual',
      existsSync: (file: string) => file === '/virtual/.env.local',
      readFileSync: () => Buffer.from('A=from-file'),
    });

    expect(source.A).toBe('');
  });
});

describe('main', () => {
  it('必須がそろっていれば終了コード 0。任意の未設定は説明つきで表示するだけ', async () => {
    const { code, out, err } = await run([], { ...REQUIRED_ENV });

    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('結果: OK');
    expect(out).toContain('[OK] SUPABASE_SERVICE_ROLE_KEY');
    // 任意の変数は未設定の理由 (無いと何が起きるか) が出る
    expect(out).toMatch(/\[--\] RESEND_API_KEY - 未設定です。メール/);
    expect(out).toMatch(/\[--\] UPSTASH_REDIS_REST_URL - 未設定です。レート制限/);
  });

  it('必須が欠けていれば終了コード 1 で、欠けている変数名を [NG] で示す', async () => {
    const { code, out } = await run([], { NEXT_PUBLIC_SUPABASE_URL: REQUIRED_ENV.NEXT_PUBLIC_SUPABASE_URL });

    expect(code).toBe(1);
    expect(out).toContain('[NG] NEXT_PUBLIC_SUPABASE_ANON_KEY');
    expect(out).toContain('[NG] SUPABASE_SERVICE_ROLE_KEY');
    expect(out).toContain('結果: NG');
    expect(out).not.toContain('[NG] NEXT_PUBLIC_SUPABASE_URL');
  });

  it('値が空の行 (`NAME=`) は未設定として扱う', async () => {
    const { code, out } = await run([], { ...REQUIRED_ENV }, { '/virtual/.env.local': 'SUPABASE_SERVICE_ROLE_KEY=\n' });

    // 実行中の環境変数が優先されるので、ここでは環境変数の値でそろう
    expect(code).toBe(0);
    expect(out).toContain('読み込んだファイル: .env.local');

    const missing = await run([], {}, { '/virtual/.env.local': 'SUPABASE_SERVICE_ROLE_KEY=\n' });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('[NG] SUPABASE_SERVICE_ROLE_KEY');
  });

  it('.env.local の値でも必須がそろう (ファイル名は表示するが、値は表示しない)', async () => {
    const file = Object.entries(REQUIRED_ENV)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const { code, out } = await run([], {}, { '/virtual/.env.local': `${file}\nRESEND_API_KEY=${SECRET_RESEND}\n` });

    expect(code).toBe(0);
    expect(out).toContain('読み込んだファイル: .env.local');
    expect(out).toContain('[OK] RESEND_API_KEY');
  });

  it('環境変数の値を出力に出さない (ファイルの値・環境変数の値のどちらも)', async () => {
    const { out, err } = await run(
      ['--strict'],
      { ...REQUIRED_ENV, NEXT_PUBLIC_APP_URL: 'not a url but looks secret-ish' },
      { '/virtual/.env.local': `RESEND_API_KEY=${SECRET_RESEND}\nUPSTASH_REDIS_REST_TOKEN=token-secret-do-not-print\n` },
    );

    const output = `${out}\n${err}`;
    for (const secret of [SECRET_SERVICE, SECRET_ANON, SECRET_RESEND, 'token-secret-do-not-print', 'looks secret-ish']) {
      expect(output).not.toContain(secret);
    }
  });

  it('--strict でなければ、任意の変数の形式の誤り・組の片方だけの設定は終了コード 0 のまま (警告として表示する)', async () => {
    const env = {
      ...REQUIRED_ENV,
      NEXT_PUBLIC_APP_URL: 'not a url',
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
    };

    const { code, out } = await run([], env);

    expect(code).toBe(0);
    expect(out).toMatch(/\[!!\] NEXT_PUBLIC_APP_URL - 値の形式が正しくありません/);
    expect(out).toMatch(/\[!!\] UPSTASH_REDIS_REST_TOKEN - .*両方設定するか両方未設定/);
  });

  it('--strict なら、任意の変数の形式の誤り・組の片方だけの設定を失敗にする', async () => {
    const env = { ...REQUIRED_ENV, NEXT_PUBLIC_APP_URL: 'not a url' };

    const strict = await run(['--strict'], env);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain('結果: NG (--strict)');

    const strictPair = await run(['--strict'], { ...REQUIRED_ENV, UPSTASH_REDIS_REST_TOKEN: 'x' });
    expect(strictPair.code).toBe(1);
  });

  it('--strict でも、任意の変数が未設定なだけでは失敗にしない', async () => {
    const { code, out } = await run(['--strict'], { ...REQUIRED_ENV });

    expect(code).toBe(0);
    expect(out).toContain('結果: OK');
  });

  it('必須の URL の形式が不正なら失敗にする', async () => {
    const { code, out } = await run([], { ...REQUIRED_ENV, NEXT_PUBLIC_SUPABASE_URL: 'abcdefgh.supabase.co' });

    expect(code).toBe(1);
    expect(out).toMatch(/\[NG\] NEXT_PUBLIC_SUPABASE_URL - 値の形式が正しくありません/);
  });

  it('--help は使い方を出して 0、不明な引数・存在しない --file・読み込めない env.ts は 2', async () => {
    const help = await run(['--help'], {});
    expect(help.code).toBe(0);
    expect(help.out).toBe(USAGE);
    expect(USAGE).toContain('--file=');
    expect(USAGE).not.toContain('--env-file=');

    const unknown = await run(['--bogus'], {});
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('不明な引数です: --bogus');

    const missingFile = await run(['--file=nope.env'], {});
    expect(missingFile.code).toBe(2);
    expect(missingFile.err).toContain('nope.env');

    const brokenModule = await run([], REQUIRED_ENV, {}, {
      loadEnv: async () => {
        throw new Error('src/lib/env.ts を読み込めませんでした');
      },
    });
    expect(brokenModule.code).toBe(2);
    expect(brokenModule.err).toContain('読み込めませんでした');
  });
});

describe('formatReport', () => {
  it('必須の行には [OK] / [NG]、任意の行には [OK] / [--] / [!!] を付け、末尾に件数の要約を出す', async () => {
    const envModule = await loadEnvModule();
    const report = envModule.validateEnv({
      NEXT_PUBLIC_SUPABASE_URL: REQUIRED_ENV.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_APP_URL: 'nope',
      RESEND_API_KEY: SECRET_RESEND,
    });

    const text = formatReport(report, envModule.ENV_VARS).join('\n');

    expect(text).toContain('[OK] NEXT_PUBLIC_SUPABASE_URL');
    expect(text).toContain('[NG] SUPABASE_SERVICE_ROLE_KEY');
    expect(text).toContain('[!!] NEXT_PUBLIC_APP_URL');
    expect(text).toContain('[--] STRIPE_SECRET_KEY');
    expect(text).toContain('[OK] RESEND_API_KEY');
    expect(text).toMatch(/必須の不足・不正 2 件 \/ 任意の未設定 \d+ 件 \/ 任意の警告 1 件/);
    expect(text).not.toContain(SECRET_RESEND);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 実際の CLI (node scripts/check-env.mjs)
// ─────────────────────────────────────────────────────────────────────────────

// scripts/check-env.mjs は TypeScript の src/lib/env.ts を Node.js の型の除去 (type stripping) で直接読み込む。
// 使えない Node.js (22.6 未満など) では、この節だけ飛ばす (loadEnvModule が案内を出して終了コード 2 になる)
const canStripTypes = Boolean((process.features as { typescript?: unknown }).typescript);

describe('実際の CLI: node scripts/check-env.mjs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-env-'));
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const writeEnv = (name: string, content: string) => {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, content);
    return file;
  };

  /** 親プロセスの環境変数 (CI や開発機の NEXT_PUBLIC_* など) を引き継がず、PATH だけで実行する */
  const runCli = (args: string[]) =>
    spawnSync(
      process.execPath,
      ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(ROOT, 'scripts/check-env.mjs'), ...args],
      { cwd: tmpDir, env: { PATH: process.env.PATH ?? '' }, encoding: 'utf-8', timeout: 60_000 },
    );

  it.skipIf(!canStripTypes)('必須がそろったファイルなら終了コード 0。値は出力に出ない', () => {
    const file = writeEnv(
      'ok.env',
      [
        `NEXT_PUBLIC_SUPABASE_URL=${REQUIRED_ENV.NEXT_PUBLIC_SUPABASE_URL}`,
        `NEXT_PUBLIC_SUPABASE_ANON_KEY=${SECRET_ANON}`,
        `SUPABASE_SERVICE_ROLE_KEY=${SECRET_SERVICE}`,
        `RESEND_API_KEY=${SECRET_RESEND}`,
      ].join('\n'),
    );

    const result = runCli([`--file=${file}`]);

    // Node.js の版によっては型の除去に関する警告が stderr に出る。ここで見たいのはエラーが無いこと
    expect(result.stderr).not.toMatch(/error/i);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('結果: OK');
    expect(result.stdout).toContain('[OK] RESEND_API_KEY');
    for (const secret of [SECRET_SERVICE, SECRET_ANON, SECRET_RESEND]) {
      expect(result.stdout).not.toContain(secret);
    }
  });

  it.skipIf(!canStripTypes)('必須が欠けたファイルなら終了コード 1', () => {
    const file = writeEnv('ng.env', `NEXT_PUBLIC_SUPABASE_URL=${REQUIRED_ENV.NEXT_PUBLIC_SUPABASE_URL}\n`);

    const result = runCli([`--file=${file}`]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[NG] SUPABASE_SERVICE_ROLE_KEY');
    expect(result.stdout).toContain('結果: NG');
  });

  it.skipIf(!canStripTypes)('存在しない --file は終了コード 2 (Node.js の --env-file のように exit 9 で止まらない)', () => {
    const result = runCli([`--file=${path.join(tmpDir, 'does-not-exist.env')}`]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--file のファイルが見つかりません');
  });
});
