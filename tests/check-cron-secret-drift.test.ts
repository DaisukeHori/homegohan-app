// @vitest-environment node
/**
 * tests/check-cron-secret-drift.test.ts
 *
 * #1196: `node scripts/check-cron-secret-drift.mjs` (scripts/lib/cron-secret-drift.mjs) の契約テスト。
 *
 *   - ダイジェストの比較: Edge Function secrets の CRON_SECRET (無いときだけ SERVICE_ROLE_SECRET) と Vault の app_cron_secret が
 *     食い違ったら FAIL、入れ替えの途中 (Vault が旧い値) は WARN、Vercel は独立なので参考 (--vercel-must-match のときだけ FAIL)
 *   - 出力の整形: 値も、ダイジェストの全体も出さない。出すのはダイジェストの先頭 8 文字だけ
 *   - 各保管場所の読み取り: 打つコマンドと引数 (値・接続先の URL をコマンドラインに載せない)、
 *     Vercel の一時ファイルは権限 700 のディレクトリに umask 077 で書かせ、終わったら必ず消す
 *   - 終了コード (0 = FAIL なし / 1 = FAIL あり / 2 = 引数の誤り・読めなかった保管場所あり)
 *
 * 保管場所 (stores) とコマンドの実行 (run) は偽物を差し込む。本物の Vercel / Supabase / Vault には接続しない。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ALIAS_NAME,
  CURRENT_NAME,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_DB_URL_ENV,
  DIGEST_PREFIX_LENGTH,
  EMPTY_SHA256,
  HELP,
  PREVIOUS_NAME,
  TIMEOUT_ENV_NAME,
  UsageError,
  VAULT_DIGEST_SQL,
  VAULT_SECRET_NAME,
  commandTimeoutMs,
  createDefaultStores,
  digestsFromEnvText,
  evaluate,
  exitCodeOf,
  formatReport,
  main,
  parseArgs,
  parseSupabaseSecretsJson,
  parseVaultDigestOutput,
  pgEnvFromUrl,
  redact,
  runCommand,
  sha256Hex,
} from '../scripts/lib/cron-secret-drift.mjs';

const ROOT = path.resolve(__dirname, '..');
/** 時間切れを確かめるための短い上限 (子は 60 秒眠るので必ず切れる) */
const SHORT_TIMEOUT_MS = 100;

// 出力に出てはいけない値 (どれも本物ではない)
const SECRET_NEW = 'new-cron-secret-DO-NOT-PRINT-0123456789abcdef';
const SECRET_OLD = 'old-cron-secret-DO-NOT-PRINT-fedcba9876543210';
const SECRET_OTHER = 'other-cron-secret-DO-NOT-PRINT-zzzzzzzzzzzzzz';
const SECRET_VERCEL = 'vercel-cron-secret-DO-NOT-PRINT-yyyyyyyyyyyy';
const DB_PASSWORD = 'db-password-DO-NOT-PRINT';
const DB_URL = `postgresql://postgres.abcdefgh:${DB_PASSWORD}@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`;
const ALL_SECRETS = [SECRET_NEW, SECRET_OLD, SECRET_OTHER, SECRET_VERCEL, DB_PASSWORD, DB_URL];

const D = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const digestEntry = (value: string) => ({ kind: 'digest' as const, digest: D(value) });

type Entry = { kind: 'digest'; digest: string } | { kind: 'unreadable' };
type Store = { state: 'ok'; entries: Record<string, Entry> } | { state: 'error'; message: string } | { state: 'skipped' };
const okStore = (entries: Record<string, Entry>): Store => ({ state: 'ok', entries });
const SKIPPED: Store = { state: 'skipped' };

/** 3 か所とも新しい値でそろい、Vercel は別の値 (普段の正しい状態) */
const healthy = () => ({
  edge: okStore({ [CURRENT_NAME]: digestEntry(SECRET_NEW) }),
  vault: okStore({ [VAULT_SECRET_NAME]: digestEntry(SECRET_NEW) }),
  vercel: okStore({ [CURRENT_NAME]: digestEntry(SECRET_VERCEL) }),
});

type Check = { id: string; level: string; title: string; detail: string };
const levelOf = (checks: Check[], id: string) => checks.find((check) => check.id === id)?.level;

/** 偽の保管場所を差し込んで main() を実行する */
async function runMain(snapshot: { edge: Store; vault: Store; vercel: Store }, argv: string[] = ['--project-ref', 'abcdefgh']) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    env: {},
    log: (line: string) => out.push(line),
    errorLog: (line: string) => err.push(line),
    stores: {
      edge: async () => snapshot.edge,
      vault: async () => snapshot.vault,
      vercel: async () => snapshot.vercel,
    },
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** 出力に、値もダイジェストの全体も入っていない */
function expectNoSecretsIn(text: string) {
  for (const secret of ALL_SECRETS) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain(D(secret));
  }
}

describe('sha256Hex', () => {
  it('UTF-8 の SHA-256 を 16 進で返す (Supabase のダイジェスト・Vault の digest() と同じ形)', () => {
    // FIPS 180-2 のテストベクトル
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(EMPTY_SHA256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('ほめゴハン')).toBe(D('ほめゴハン'));
  });
});

describe('parseArgs', () => {
  it('既定値: project ref は環境変数から、DB の接続先は SUPABASE_DB_URL、Vercel は production', () => {
    const options = parseArgs([], { SUPABASE_PROJECT_REF: 'refFromEnv' });
    expect(options).toMatchObject({
      projectRef: 'refFromEnv',
      dbUrlEnv: DEFAULT_DB_URL_ENV,
      vercelEnvironment: 'production',
      vercelMustMatch: false,
      skipEdge: false,
      skipVault: false,
      skipVercel: false,
      supabaseBin: 'supabase',
      vercelBin: 'vercel',
      psqlBin: 'psql',
    });
  });

  it('--name value と --name=value のどちらでも受け付ける', () => {
    const options = parseArgs(
      ['--project-ref=abc', '--db-url-env', 'MY_DB', '--vercel-environment=preview', '--vercel-project', 'web', '--vercel-scope=team', '--vercel-must-match', '--skip-vercel'],
      {},
    );
    expect(options).toMatchObject({
      projectRef: 'abc',
      dbUrlEnv: 'MY_DB',
      vercelEnvironment: 'preview',
      vercelProject: 'web',
      vercelScope: 'team',
      vercelMustMatch: true,
      skipVercel: true,
    });
  });

  it('--vault-digest は 16 進 64 文字に限り、小文字にそろえる。値そのものを渡しても、エラーの文に出さない', () => {
    expect(parseArgs(['--project-ref', 'a', '--vault-digest', D(SECRET_NEW).toUpperCase()], {}).vaultDigest).toBe(D(SECRET_NEW));
    let message = '';
    try {
      parseArgs(['--project-ref', 'a', '--vault-digest', SECRET_NEW], {});
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      message = (error as Error).message;
    }
    expect(message).toContain('--vault-digest');
    expect(message).not.toContain(SECRET_NEW);
  });

  it.each([
    [['--unknown'], '知らないオプション'],
    [['--project-ref'], '--project-ref には値が必要'],
    [['--project-ref', '--skip-vercel'], '--project-ref には値が必要'],
    [[], 'project ref がありません'],
    [['--project-ref', 'a', '--vault-missing', '--vault-digest', 'f'.repeat(64)], '同時に使えません'],
    [['--project-ref', 'a', '--skip-vault', '--vault-missing'], '同時に使えません'],
    [['--skip-edge', '--skip-vault', '--skip-vercel'], '確かめる保管場所がありません'],
    [['--project-ref', 'a', '--skip-edge=yes'], '値をとりません'],
  ])('誤り: %j → UsageError (%s)', (argv, fragment) => {
    expect(() => parseArgs(argv as string[], {})).toThrow(UsageError);
    expect(() => parseArgs(argv as string[], {})).toThrow(fragment as string);
  });

  it('--skip-edge なら project ref は要らない', () => {
    expect(parseArgs(['--skip-edge'], {}).skipEdge).toBe(true);
  });

  it('--help は他の検査より先に返す', () => {
    expect(parseArgs(['--help'], {}).help).toBe(true);
    expect(parseArgs(['-h'], {}).help).toBe(true);
  });
});

describe('parseSupabaseSecretsJson', () => {
  it('[{ name, value }] から CRON_SECRET・CRON_SECRET_PREVIOUS・SERVICE_ROLE_SECRET のダイジェストだけを取り出す', () => {
    const stdout = JSON.stringify([
      { name: CURRENT_NAME, value: D(SECRET_NEW).toUpperCase() },
      { name: PREVIOUS_NAME, value: D(SECRET_OLD) },
      { name: 'FIRECRAWL_API_KEY', value: D('unrelated') },
      { name: ALIAS_NAME, digest: D(SECRET_OTHER) },
    ]);
    expect(parseSupabaseSecretsJson(stdout)).toEqual({
      [CURRENT_NAME]: digestEntry(SECRET_NEW),
      [PREVIOUS_NAME]: digestEntry(SECRET_OLD),
      [ALIAS_NAME]: digestEntry(SECRET_OTHER),
    });
  });

  it('JSON でない・配列でない・ダイジェストの形でない値は例外。中身はエラーの文に出さない', () => {
    expect(() => parseSupabaseSecretsJson('not json')).toThrow('JSON ではありません');
    expect(() => parseSupabaseSecretsJson('{}')).toThrow('配列ではありません');
    let message = '';
    try {
      parseSupabaseSecretsJson(JSON.stringify([{ name: CURRENT_NAME, value: SECRET_NEW }]));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(CURRENT_NAME);
    expect(message).not.toContain(SECRET_NEW);
  });
});

describe('digestsFromEnvText (vercel env pull のファイル)', () => {
  it('引用符つきの値のダイジェストを計算し、値は返さない。空の値は「取り出せない」', () => {
    const text = [
      '# Created by Vercel CLI',
      `${CURRENT_NAME}="${SECRET_VERCEL}"`,
      `${PREVIOUS_NAME}=""`,
      'VERCEL_OIDC_TOKEN="unrelated"',
      '',
    ].join('\n');
    const entries = digestsFromEnvText(text);
    expect(entries).toEqual({
      [CURRENT_NAME]: digestEntry(SECRET_VERCEL),
      [PREVIOUS_NAME]: { kind: 'unreadable' },
    });
    expect(JSON.stringify(entries)).not.toContain(SECRET_VERCEL);
  });

  it('無い名前は結果に入れない (未設定)', () => {
    expect(digestsFromEnvText('OTHER="x"\n')).toEqual({});
  });
});

describe('parseVaultDigestOutput (psql -A -t の出力)', () => {
  it.each([
    ['', {}],
    [`${D(SECRET_NEW)}\n`, { [VAULT_SECRET_NAME]: digestEntry(SECRET_NEW) }],
    ['\n', { [VAULT_SECRET_NAME]: { kind: 'unreadable' } }],
  ])('%j', (stdout, expected) => {
    expect(parseVaultDigestOutput(stdout)).toEqual(expected);
  });

  it('2 行以上・ダイジェストでない行は例外 (中身はエラーの文に出さない)', () => {
    expect(() => parseVaultDigestOutput(`${D('a')}\n${D('b')}\n`)).toThrow('2 行');
    let message = '';
    try {
      parseVaultDigestOutput(`${SECRET_NEW}\n`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(SECRET_NEW);
  });

  it('Vault の SQL は値ではなくダイジェストだけを返し、app_cron_secret を名前で引く', () => {
    expect(VAULT_DIGEST_SQL).toContain("digest(convert_to(decrypted_secret, 'UTF8'), 'sha256')");
    expect(VAULT_DIGEST_SQL).toContain(`WHERE name = '${VAULT_SECRET_NAME}'`);
    expect(VAULT_DIGEST_SQL).not.toMatch(/SELECT\s+decrypted_secret/i);
  });
});

describe('pgEnvFromUrl', () => {
  it('URL を PG* の環境変数に分ける (sslmode の既定は require)', () => {
    expect(pgEnvFromUrl('postgresql://user%40x:p%40ss@db.example.test:5432/postgres')).toEqual({
      PGHOST: 'db.example.test',
      PGPORT: '5432',
      PGUSER: 'user@x',
      PGPASSWORD: 'p@ss',
      PGDATABASE: 'postgres',
      PGSSLMODE: 'require',
    });
    expect(pgEnvFromUrl('postgres://u:p@h/db?sslmode=verify-full')).toMatchObject({ PGSSLMODE: 'verify-full', PGDATABASE: 'db' });
  });

  it('URL でない・postgres でない接続先は例外 (中身はエラーの文に出さない)', () => {
    expect(() => pgEnvFromUrl(`not a url ${DB_PASSWORD}`)).toThrow('URL の形ではありません');
    expect(() => pgEnvFromUrl(`mysql://u:${DB_PASSWORD}@h/db`)).toThrow('postgres://');
    try {
      pgEnvFromUrl(`not a url ${DB_PASSWORD}`);
    } catch (error) {
      expect((error as Error).message).not.toContain(DB_PASSWORD);
    }
  });
});

describe('evaluate (ダイジェストの比較)', () => {
  it('3 か所とも正しい: FAIL なし、Vercel が別の値なのは参考 (INFO)', () => {
    const checks = evaluate(healthy());
    expect(levelOf(checks, 'edge-current')).toBe('pass');
    expect(levelOf(checks, 'vault-present')).toBe('pass');
    expect(levelOf(checks, 'edge-vault-match')).toBe('pass');
    expect(levelOf(checks, 'vercel-current')).toBe('pass');
    expect(levelOf(checks, 'vercel-vs-supabase')).toBe('info');
    expect(exitCodeOf(checks)).toBe(0);
  });

  it('Edge と Vault が食い違う → FAIL (401 になる組)', () => {
    const snapshot = { ...healthy(), vault: okStore({ [VAULT_SECRET_NAME]: digestEntry(SECRET_OTHER) }) };
    const checks = evaluate(snapshot);
    expect(levelOf(checks, 'edge-vault-match')).toBe('fail');
    expect(checks.find((c: Check) => c.id === 'edge-vault-match')?.detail).toContain('401');
    expect(exitCodeOf(checks)).toBe(1);
  });

  it('入れ替えの途中 (Vault がまだ Edge の CRON_SECRET_PREVIOUS と同じ) → WARN で、FAIL にしない', () => {
    const snapshot = {
      ...healthy(),
      edge: okStore({ [CURRENT_NAME]: digestEntry(SECRET_NEW), [PREVIOUS_NAME]: digestEntry(SECRET_OLD) }),
      vault: okStore({ [VAULT_SECRET_NAME]: digestEntry(SECRET_OLD) }),
    };
    const checks = evaluate(snapshot);
    expect(levelOf(checks, 'edge-vault-match')).toBe('warn');
    expect(levelOf(checks, 'edge-previous')).toBe('info');
    expect(exitCodeOf(checks)).toBe(0);
  });

  it('Vault も新しい値なのに CRON_SECRET_PREVIOUS が残っている → WARN (外し忘れ)', () => {
    const snapshot = {
      ...healthy(),
      edge: okStore({ [CURRENT_NAME]: digestEntry(SECRET_NEW), [PREVIOUS_NAME]: digestEntry(SECRET_OLD) }),
    };
    const checks = evaluate(snapshot);
    expect(levelOf(checks, 'edge-vault-match')).toBe('pass');
    expect(levelOf(checks, 'edge-previous')).toBe('warn');
    expect(checks.find((c: Check) => c.id === 'edge-previous')?.detail).toContain('手順 5');
  });

  it('CRON_SECRET_PREVIOUS が現行と同じ → WARN、空の値 → INFO (無視される)', () => {
    const same = evaluate({ ...healthy(), edge: okStore({ [CURRENT_NAME]: digestEntry(SECRET_NEW), [PREVIOUS_NAME]: digestEntry(SECRET_NEW) }) });
    expect(levelOf(same, 'edge-previous')).toBe('warn');
    const empty = evaluate({ ...healthy(), edge: okStore({ [CURRENT_NAME]: digestEntry(SECRET_NEW), [PREVIOUS_NAME]: { kind: 'digest', digest: EMPTY_SHA256 } }) });
    expect(levelOf(empty, 'edge-previous')).toBe('info');
    // Vault が空の旧い値に一致しても、入れ替えの途中とは見なさない
    const vaultEmpty = evaluate({
      ...healthy(),
      edge: okStore({ [CURRENT_NAME]: digestEntry(SECRET_NEW), [PREVIOUS_NAME]: { kind: 'digest', digest: EMPTY_SHA256 } }),
      vault: okStore({ [VAULT_SECRET_NAME]: { kind: 'digest', digest: EMPTY_SHA256 } }),
    });
    expect(levelOf(vaultEmpty, 'vault-present')).toBe('fail');
  });

  it('CRON_SECRET が無いときだけ SERVICE_ROLE_SECRET を現行の値として比べる (_shared/auth.ts の ?? と同じ)', () => {
    const alias = evaluate({ ...healthy(), edge: okStore({ [ALIAS_NAME]: digestEntry(SECRET_NEW) }) });
    expect(levelOf(alias, 'edge-current')).toBe('pass');
    expect(levelOf(alias, 'edge-vault-match')).toBe('pass');

    // CRON_SECRET が空の値で置いてあると、別名には切り替わらない (?? は空文字を素通しする) → 503
    const emptyCurrent = evaluate({
      ...healthy(),
      edge: okStore({ [CURRENT_NAME]: { kind: 'digest', digest: EMPTY_SHA256 }, [ALIAS_NAME]: digestEntry(SECRET_NEW) }),
    });
    expect(levelOf(emptyCurrent, 'edge-current')).toBe('fail');
    expect(levelOf(emptyCurrent, 'edge-vault-match')).toBeUndefined();

    // 両方あるときは CRON_SECRET を使い、SERVICE_ROLE_SECRET は使われない (INFO)
    const both = evaluate({ ...healthy(), edge: okStore({ [CURRENT_NAME]: digestEntry(SECRET_NEW), [ALIAS_NAME]: digestEntry(SECRET_OTHER) }) });
    expect(levelOf(both, 'edge-vault-match')).toBe('pass');
    expect(levelOf(both, 'edge-alias-unused')).toBe('info');
  });

  it('Edge に現行の値が無い → FAIL (503)、Vault に app_cron_secret が無い・復号できない → FAIL', () => {
    const noEdge = evaluate({ ...healthy(), edge: okStore({}) });
    expect(levelOf(noEdge, 'edge-current')).toBe('fail');
    expect(noEdge.find((c: Check) => c.id === 'edge-current')?.detail).toContain('503');

    expect(levelOf(evaluate({ ...healthy(), vault: okStore({}) }), 'vault-present')).toBe('fail');
    expect(levelOf(evaluate({ ...healthy(), vault: okStore({ [VAULT_SECRET_NAME]: { kind: 'unreadable' } }) }), 'vault-present')).toBe('fail');
  });

  it('Vercel: 未設定 → FAIL、Sensitive で取り出せない → WARN、同じ値 → INFO', () => {
    expect(levelOf(evaluate({ ...healthy(), vercel: okStore({}) }), 'vercel-current')).toBe('fail');
    const sensitive = evaluate({ ...healthy(), vercel: okStore({ [CURRENT_NAME]: { kind: 'unreadable' } }) });
    expect(levelOf(sensitive, 'vercel-current')).toBe('warn');
    expect(levelOf(sensitive, 'vercel-vs-supabase')).toBeUndefined();
    const same = evaluate({ ...healthy(), vercel: okStore({ [CURRENT_NAME]: digestEntry(SECRET_NEW) }) });
    expect(levelOf(same, 'vercel-vs-supabase')).toBe('info');
    expect(exitCodeOf(same)).toBe(0);
  });

  it('--vercel-must-match のときだけ、Vercel が Supabase 側と違えば FAIL', () => {
    expect(exitCodeOf(evaluate(healthy()))).toBe(0);
    const strict = evaluate(healthy(), { vercelMustMatch: true });
    expect(levelOf(strict, 'vercel-vs-supabase')).toBe('fail');
    expect(exitCodeOf(strict)).toBe(1);
    const sensitive = evaluate({ ...healthy(), vercel: okStore({ [CURRENT_NAME]: { kind: 'unreadable' } }) }, { vercelMustMatch: true });
    expect(levelOf(sensitive, 'vercel-vs-supabase')).toBe('warn');
  });

  it('Vercel の CRON_SECRET_PREVIOUS: 現行と同じ → WARN、あるだけ → INFO', () => {
    const same = evaluate({ ...healthy(), vercel: okStore({ [CURRENT_NAME]: digestEntry(SECRET_VERCEL), [PREVIOUS_NAME]: digestEntry(SECRET_VERCEL) }) });
    expect(levelOf(same, 'vercel-previous')).toBe('warn');
    const leftover = evaluate({ ...healthy(), vercel: okStore({ [CURRENT_NAME]: digestEntry(SECRET_VERCEL), [PREVIOUS_NAME]: digestEntry(SECRET_OLD) }) });
    expect(levelOf(leftover, 'vercel-previous')).toBe('info');
  });

  it('読めなかった保管場所 → ERROR で終了コード 2。FAIL もあれば終了コード 1 を優先', () => {
    const unread = evaluate({ ...healthy(), vault: { state: 'error', message: 'psql が失敗' } });
    expect(levelOf(unread, 'vault-read')).toBe('error');
    expect(levelOf(unread, 'edge-vault-match')).toBeUndefined();
    expect(exitCodeOf(unread)).toBe(2);

    const both = evaluate({ ...healthy(), vault: { state: 'error', message: 'x' }, vercel: okStore({}) });
    expect(exitCodeOf(both)).toBe(1);
  });

  it('--skip-* で外した保管場所は SKIP。Edge ⇔ Vault の組を確かめていないことは WARN で知らせる', () => {
    const checks = evaluate({ ...healthy(), vault: SKIPPED });
    expect(levelOf(checks, 'vault-read')).toBe('skip');
    expect(levelOf(checks, 'edge-vault-match')).toBe('warn');
    expect(exitCodeOf(checks)).toBe(0);
    const noVercel = evaluate({ ...healthy(), vercel: SKIPPED });
    expect(levelOf(noVercel, 'vercel-read')).toBe('skip');
    expect(levelOf(noVercel, 'vercel-current')).toBeUndefined();
  });
});

describe('formatReport / main (出力の整形)', () => {
  it('ダイジェストの先頭 8 文字だけを出し、値もダイジェストの全体も出さない', async () => {
    const snapshot = {
      edge: okStore({ [CURRENT_NAME]: digestEntry(SECRET_NEW), [PREVIOUS_NAME]: digestEntry(SECRET_OLD) }),
      vault: okStore({ [VAULT_SECRET_NAME]: digestEntry(SECRET_OTHER) }),
      vercel: okStore({ [CURRENT_NAME]: digestEntry(SECRET_VERCEL) }),
    };
    const { code, out, err } = await runMain(snapshot);
    expect(code).toBe(1);
    expect(DIGEST_PREFIX_LENGTH).toBe(8);
    expect(out).toContain(`${CURRENT_NAME}: 設定あり (${D(SECRET_NEW).slice(0, DIGEST_PREFIX_LENGTH)})`);
    expect(out).toContain(`${VAULT_SECRET_NAME}: 設定あり (${D(SECRET_OTHER).slice(0, DIGEST_PREFIX_LENGTH)})`);
    expect(out).toContain('[FAIL] Edge Function secrets と Vault の app_cron_secret が食い違っています');
    expect(out).toContain('結果: FAIL 1 件');
    // 先頭 9 文字目以降は出ない
    expect(out).not.toContain(D(SECRET_NEW).slice(0, DIGEST_PREFIX_LENGTH + 1));
    expectNoSecretsIn(out);
    expectNoSecretsIn(err);
  });

  it('問題が無ければ終了コード 0 で「値のずれは見つかりませんでした」', async () => {
    const { code, out } = await runMain(healthy());
    expect(code).toBe(0);
    expect(out).toContain('値のずれは見つかりませんでした');
    expectNoSecretsIn(out);
  });

  it('未設定・空・取り出せない・読めなかった・確かめていない、を書き分ける', () => {
    const snapshot = {
      edge: okStore({ [CURRENT_NAME]: { kind: 'digest', digest: EMPTY_SHA256 } }),
      vault: { state: 'error', message: 'x' } as Store,
      vercel: okStore({ [CURRENT_NAME]: { kind: 'unreadable' } }),
    };
    const report = formatReport(evaluate(snapshot), snapshot);
    expect(report).toContain(`Edge Function secrets ${CURRENT_NAME}: 空の値`);
    expect(report).toContain(`Edge Function secrets ${ALIAS_NAME}: 未設定`);
    expect(report).toContain('Vault: 読めなかった');
    expect(report).toContain(`Vercel ${CURRENT_NAME}: 値を取り出せない`);
    const skipped = { ...healthy(), vercel: SKIPPED };
    expect(formatReport(evaluate(skipped), skipped)).toContain('Vercel: 確かめていない');
  });

  it('保管場所の読み取りが例外を投げても、例外の文 (値が入っているかもしれない) は出さずに終了コード 2', async () => {
    const out: string[] = [];
    const code = await main(['--project-ref', 'a'], {
      env: {},
      log: (line: string) => out.push(line),
      errorLog: (line: string) => out.push(line),
      stores: {
        edge: async () => {
          throw new Error(`boom ${SECRET_NEW}`);
        },
        vault: async () => healthy().vault,
        vercel: async () => healthy().vercel,
      },
    });
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('予期しないエラー');
    expectNoSecretsIn(out.join('\n'));
  });

  it('引数の誤りは終了コード 2 で使い方を出し、--help は終了コード 0', async () => {
    const err: string[] = [];
    expect(await main(['--nope'], { env: {}, log: () => {}, errorLog: (line: string) => err.push(line) })).toBe(2);
    expect(err.join('\n')).toContain('使い方');
    const out: string[] = [];
    expect(await main(['--help'], { env: {}, log: (line: string) => out.push(line), errorLog: () => {} })).toBe(0);
    expect(out.join('\n')).toBe(HELP);
  });
});

/** 偽の run。呼ばれたコマンドを記録し、決めた結果を返す */
function fakeRun(respond: (command: string, args: string[], opts: { env: Record<string, string | undefined> }) => Promise<unknown> | unknown) {
  const calls: { command: string; args: string[]; env: Record<string, string | undefined>; timeoutMs: number }[] = [];
  const run = async (command: string, args: string[], opts: { env: Record<string, string | undefined>; timeoutMs: number }) => {
    calls.push({ command, args, env: opts.env, timeoutMs: opts.timeoutMs });
    return respond(command, args, opts);
  };
  return { run, calls };
}

/** 偽のファイル操作 (メモリ上)。mkdtemp・readFile・rm の呼び出しを記録する */
function fakeFs() {
  const files = new Map<string, string>();
  const removed: string[] = [];
  const created: string[] = [];
  return {
    files,
    removed,
    created,
    api: {
      mkdtemp: async (prefix: string) => {
        const dir = `${prefix}XXXXXX`;
        created.push(dir);
        return dir;
      },
      readFile: async (file: string) => {
        if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return files.get(file);
      },
      rm: async (dir: string) => {
        removed.push(dir);
        for (const key of [...files.keys()]) if (key.startsWith(`${dir}/`)) files.delete(key);
      },
    },
  };
}

describe('createDefaultStores (各保管場所の読み取り)', () => {
  const baseOptions = (argv: string[] = []) => parseArgs(['--project-ref', 'abcdefgh', ...argv], {});

  it('Edge: supabase secrets list --project-ref <ref> -o json を打ち、ダイジェストを読む', async () => {
    const { run, calls } = fakeRun(() => ({ code: 0, stdout: JSON.stringify([{ name: CURRENT_NAME, value: D(SECRET_NEW) }]), stderr: '' }));
    const stores = createDefaultStores({ options: baseOptions(), env: {}, run, fsApi: fakeFs().api, tmpdir: '/virtual-tmp' });
    expect(await stores.edge()).toEqual({ state: 'ok', entries: { [CURRENT_NAME]: digestEntry(SECRET_NEW) } });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('supabase');
    expect(calls[0].args).toEqual(['secrets', 'list', '--project-ref', 'abcdefgh', '-o', 'json']);
    expect(calls[0].timeoutMs).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
  });

  it('Edge: コマンドが無い・失敗した・時間切れ → 読めなかった (理由つき)', async () => {
    const cases: [unknown, string][] = [
      [{ code: null, stdout: '', stderr: '', error: 'ENOENT' }, 'コマンドが見つかりません'],
      [{ code: 1, stdout: '', stderr: 'line1\nUnauthorized: invalid access token\n', error: undefined }, '終了コード 1 で失敗しました: line1 / Unauthorized'],
      [{ code: null, stdout: '', stderr: '', error: 'TIMEOUT' }, TIMEOUT_ENV_NAME],
      [{ code: 0, stdout: 'garbage', stderr: '' }, 'JSON ではありません'],
    ];
    for (const [result, fragment] of cases) {
      const { run } = fakeRun(() => result);
      const store = await createDefaultStores({ options: baseOptions(), env: {}, run, fsApi: fakeFs().api }).edge();
      expect(store.state).toBe('error');
      expect((store as { message: string }).message).toContain(fragment);
    }
  });

  it('Vault (psql): 接続先の URL もパスワードもコマンドラインに載せず、PG* の環境変数で渡す。URL の環境変数は子に渡さない', async () => {
    const { run, calls } = fakeRun(() => ({ code: 0, stdout: `${D(SECRET_NEW)}\n`, stderr: '' }));
    const env = { [DEFAULT_DB_URL_ENV]: DB_URL, PATH: '/usr/bin' };
    const store = await createDefaultStores({ options: baseOptions(), env, run, fsApi: fakeFs().api }).vault();
    expect(store).toEqual({ state: 'ok', entries: { [VAULT_SECRET_NAME]: digestEntry(SECRET_NEW) } });
    expect(calls[0].command).toBe('psql');
    expect(calls[0].args).toEqual(['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', VAULT_DIGEST_SQL]);
    expect(calls[0].args.join(' ')).not.toContain(DB_PASSWORD);
    expect(calls[0].env.PGPASSWORD).toBe(DB_PASSWORD);
    expect(calls[0].env.PGHOST).toBe('aws-0-ap-northeast-1.pooler.supabase.com');
    expect(calls[0].env.PGPORT).toBe('6543');
    expect(calls[0].env[DEFAULT_DB_URL_ENV]).toBeUndefined();
    expect(calls[0].env.PATH).toBe('/usr/bin');
  });

  it('Vault (psql): 失敗したときの標準エラー出力は、パスワードと URL を伏せてから出す', async () => {
    const { run } = fakeRun(() => ({ code: 2, stdout: '', stderr: `FATAL: password "${DB_PASSWORD}" rejected for ${DB_URL}\n` }));
    const store = await createDefaultStores({ options: baseOptions(), env: { [DEFAULT_DB_URL_ENV]: DB_URL }, run, fsApi: fakeFs().api }).vault();
    expect(store.state).toBe('error');
    const message = (store as { message: string }).message;
    expect(message).toContain('***');
    expectNoSecretsIn(message);
  });

  it('Vault: 接続先が無ければ psql を打たずに案内する。--vault-digest / --vault-missing なら psql を使わない', async () => {
    const { run, calls } = fakeRun(() => {
      throw new Error('呼ばれてはいけない');
    });
    const noUrl = await createDefaultStores({ options: baseOptions(), env: {}, run, fsApi: fakeFs().api }).vault();
    expect(noUrl.state).toBe('error');
    expect((noUrl as { message: string }).message).toContain('--vault-digest');

    const given = await createDefaultStores({ options: baseOptions(['--vault-digest', D(SECRET_NEW)]), env: {}, run, fsApi: fakeFs().api }).vault();
    expect(given).toEqual({ state: 'ok', entries: { [VAULT_SECRET_NAME]: digestEntry(SECRET_NEW) } });

    const missing = await createDefaultStores({ options: baseOptions(['--vault-missing']), env: {}, run, fsApi: fakeFs().api }).vault();
    expect(missing).toEqual({ state: 'ok', entries: {} });
    expect(calls).toHaveLength(0);
  });

  it('Vercel: 権限 700 の一時ディレクトリに umask 077 で書かせ、ダイジェストを計算したらディレクトリごと消す', async () => {
    const fsFake = fakeFs();
    const { run, calls } = fakeRun((_command, args) => {
      // args = ['-c', script, 'sh', vercelBin, 'env', 'pull', <file>, ...]
      fsFake.files.set(args[6], `${CURRENT_NAME}="${SECRET_VERCEL}"\n`);
      return { code: 0, stdout: '', stderr: '' };
    });
    const options = baseOptions(['--vercel-project', 'web', '--vercel-scope', 'team', '--vercel-environment', 'preview']);
    const store = await createDefaultStores({ options, env: {}, run, fsApi: fsFake.api, tmpdir: '/virtual-tmp' }).vercel();
    expect(store).toEqual({ state: 'ok', entries: { [CURRENT_NAME]: digestEntry(SECRET_VERCEL) } });

    expect(fsFake.created).toEqual(['/virtual-tmp/cron-secret-drift-XXXXXX']);
    expect(calls[0].command).toBe('/bin/sh');
    expect(calls[0].args.slice(0, 4)).toEqual(['-c', 'umask 077 && exec "$@"', 'sh', 'vercel']);
    expect(calls[0].args.slice(4)).toEqual([
      'env',
      'pull',
      '/virtual-tmp/cron-secret-drift-XXXXXX/vercel.env',
      '--environment=preview',
      '--yes',
      '--project=web',
      '--scope=team',
    ]);
    expect(fsFake.removed).toEqual(['/virtual-tmp/cron-secret-drift-XXXXXX']);
    expect(fsFake.files.size).toBe(0);
    expect(JSON.stringify(store)).not.toContain(SECRET_VERCEL);
  });

  it('Vercel: 失敗しても一時ディレクトリは必ず消す', async () => {
    const fsFake = fakeFs();
    const { run } = fakeRun((_command, args) => {
      fsFake.files.set(args[6], `${CURRENT_NAME}="${SECRET_VERCEL}"\n`);
      return { code: 1, stdout: '', stderr: 'Error: Not linked\n' };
    });
    const store = await createDefaultStores({ options: baseOptions(), env: {}, run, fsApi: fsFake.api, tmpdir: '/virtual-tmp' }).vercel();
    expect(store.state).toBe('error');
    expect((store as { message: string }).message).toContain('Not linked');
    expect(fsFake.removed).toHaveLength(1);
    expect(fsFake.files.size).toBe(0);

    const throwing = fakeFs();
    const { run: throwingRun } = fakeRun(() => {
      throw new Error('spawn exploded');
    });
    await expect(createDefaultStores({ options: baseOptions(), env: {}, run: throwingRun, fsApi: throwing.api }).vercel()).rejects.toThrow();
    expect(throwing.removed).toHaveLength(1);
  });

  it('--skip-* の保管場所はコマンドを打たずに SKIP を返す', async () => {
    const { run, calls } = fakeRun(() => ({ code: 0, stdout: '[]', stderr: '' }));
    const stores = createDefaultStores({ options: parseArgs(['--skip-edge', '--skip-vault'], {}), env: {}, run, fsApi: fakeFs().api });
    expect(await stores.edge()).toEqual({ state: 'skipped' });
    expect(await stores.vault()).toEqual({ state: 'skipped' });
    expect(calls).toHaveLength(0);
  });

  it(`待つ上限は環境変数 ${TIMEOUT_ENV_NAME} で上書きでき、正の整数でなければ既定値`, () => {
    expect(commandTimeoutMs({})).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    expect(commandTimeoutMs({ [TIMEOUT_ENV_NAME]: '5000' })).toBe(5000);
    expect(commandTimeoutMs({ [TIMEOUT_ENV_NAME]: '-1' })).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    expect(commandTimeoutMs({ [TIMEOUT_ENV_NAME]: 'abc' })).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
  });

  it('redact は秘密の文字列をすべて伏せる', () => {
    expect(redact(`a ${DB_PASSWORD} b ${DB_PASSWORD}`, [DB_PASSWORD, undefined])).toBe('a *** b ***');
  });
});

describe('runCommand と、本物の /bin/sh を通した Vercel の読み取り', () => {
  const tmpRoots: string[] = [];
  afterAll(() => {
    for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('標準出力・標準エラー出力・終了コードを返し、コマンドが無ければ ENOENT、時間切れなら TIMEOUT', async () => {
    const done = await runCommand(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], { env: process.env, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS });
    expect(done).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
    const missing = await runCommand('/nonexistent/command-for-test', [], { env: process.env, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS });
    expect(missing.error).toBe('ENOENT');
    const slow = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env: process.env, timeoutMs: SHORT_TIMEOUT_MS });
    expect(slow.error).toBe('TIMEOUT');
  });

  it('偽の vercel が umask 077 の下で動き、書いたファイルは読み終えたら消えている', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-drift-test-'));
    tmpRoots.push(root);
    const umaskOut = path.join(root, 'umask-seen');
    const pulledCopy = path.join(root, 'pulled-path');
    const fakeVercel = path.join(root, 'fake-vercel.sh');
    // args: env pull <file> --environment=production --yes
    fs.writeFileSync(
      fakeVercel,
      [
        '#!/bin/sh',
        `umask > "${umaskOut}"`,
        `printf '%s' "$3" > "${pulledCopy}"`,
        `printf '${CURRENT_NAME}="%s"\\n' "${SECRET_VERCEL}" > "$3"`,
        `ls -ld "$(dirname "$3")" | cut -c1-10 >> "${umaskOut}"`,
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    const options = parseArgs(['--skip-edge', '--skip-vault', '--vercel-bin', fakeVercel], {});
    const tmpdir = path.join(root, 'tmp');
    fs.mkdirSync(tmpdir);
    const store = await createDefaultStores({ options, env: { PATH: process.env.PATH }, tmpdir }).vercel();
    expect(store).toEqual({ state: 'ok', entries: { [CURRENT_NAME]: digestEntry(SECRET_VERCEL) } });
    const [umask, dirMode] = fs.readFileSync(umaskOut, 'utf8').trim().split('\n');
    expect(umask).toBe('0077');
    expect(dirMode).toBe('drwx------');
    const pulledPath = fs.readFileSync(pulledCopy, 'utf8');
    expect(pulledPath.startsWith(path.join(tmpdir, 'cron-secret-drift-'))).toBe(true);
    expect(fs.existsSync(pulledPath)).toBe(false);
    expect(fs.existsSync(path.dirname(pulledPath))).toBe(false);
  });
});

describe('ENV_SETUP.md の案内 (#1196)', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'ENV_SETUP.md'), 'utf8');

  it('Cron の共有シークレットの節が、このスクリプトの使い方を案内している', () => {
    const start = doc.indexOf('## Cron の共有シークレットの保管場所とローテーション');
    expect(start).toBeGreaterThanOrEqual(0);
    const section = doc.slice(start, doc.indexOf('\n## ', start + 1));
    expect(section).toContain('node scripts/check-cron-secret-drift.mjs');
    expect(section).toContain('--vault-digest');
    expect(section).toContain(DEFAULT_DB_URL_ENV);
    // 手順書の SQL (SQL Editor で実行して --vault-digest に渡す) は、スクリプトが psql で流す SQL と同じ計算
    expect(section).toContain("encode(extensions.digest(convert_to(decrypted_secret, 'UTF8'), 'sha256'), 'hex')");
    expect(VAULT_DIGEST_SQL).toContain("encode(extensions.digest(convert_to(decrypted_secret, 'UTF8'), 'sha256'), 'hex')");
    // 「まだ仕組みが無い」という古い案内は残さない
    expect(section).not.toContain('値のずれを自動で見つける仕組みは、まだありません');
  });

  it('入口のスクリプトがあり、本体の main() を呼ぶ', () => {
    const entry = fs.readFileSync(path.join(ROOT, 'scripts/check-cron-secret-drift.mjs'), 'utf8');
    expect(entry).toContain("from './lib/cron-secret-drift.mjs'");
    expect(entry).toContain('main()');
  });
});
