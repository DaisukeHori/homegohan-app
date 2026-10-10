#!/usr/bin/env node
/**
 * scripts/edge-functions-prune.mjs — 本番の Supabase にあって、リポジトリ (supabase/functions/) に無い Edge Function を消す
 * (.github/workflows/deploy-supabase-functions.yml の「Deploy all functions」のあとに --apply で呼ぶ。
 *  テストは tests/edge-functions-prune.test.ts。#1452)
 *
 *   node scripts/edge-functions-prune.mjs --project-ref <ref>            # 既定は dry-run (消さずに、消す予定の関数を出すだけ)
 *   node scripts/edge-functions-prune.mjs --project-ref <ref> --apply    # 実際に消す
 *
 * 背景: リポジトリから関数のディレクトリを消しても、`supabase functions deploy` は本番の関数を消さない。
 * そのため、ソースの無い旧い関数 (認証なしで呼べるものを含む) が本番に残り続けていた (#1452)。
 * この手順をデプロイのあとに走らせ、「リポジトリから関数を消すと、次のデプロイで本番からも消える」形にする。
 *
 * 安全装置 (どれかに当たったら 1 本も消さず、終了コード 1 で終わる):
 *   - リポジトリの関数が 0 本 (読む場所の間違い・チェックアウトの失敗で、本番の全関数を消さないため)
 *   - 本番の関数の一覧が取れない・JSON として読めない・形が想定と違う
 *   - 本番の関数の名前 (slug) に想定外の文字がある (一覧の読み違いを疑う)
 *   - 消す関数の数が上限を超える (上限は MAX_DELETIONS_ENV で上書きできる)
 * 消すのに 1 本でも失敗したら、残りも試したうえで終了コード 1 で終わる。
 *
 * ログには、関数の名前と件数だけを出す。supabase CLI の出力 (stdout / stderr) やアクセストークンは出さない。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 使う supabase CLI (デプロイのワークフローと同じ版に固定する) */
export const SUPABASE_CLI_PACKAGE = 'supabase@2.62.10';

/** リポジトリの関数を置くディレクトリ (リポジトリの根からの相対パス) */
export const FUNCTIONS_DIR_RELATIVE = path.join('supabase', 'functions');

/** 関数のディレクトリに必ずある入口のファイル (これが無いディレクトリは関数ではない。例: _shared) */
export const FUNCTION_ENTRYPOINT = 'index.ts';

/**
 * 関数ではないディレクトリの名前の先頭の文字。_shared のような共有部品や、.git などの隠しディレクトリ。
 * supabase CLI も、先頭が _ のディレクトリは関数としてデプロイしない。
 */
export const NON_FUNCTION_PREFIXES = ['_', '.'];

/**
 * 本番の関数の名前 (slug) として受け付ける形。Supabase の slug は英字で始まり、英数字・_・- だけから成る。
 * これに合わない名前が一覧にあれば、一覧の読み違い (CLI の出力の形が変わった等) を疑って止める。
 */
export const SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** 消す関数の数の上限を上書きする環境変数 */
export const MAX_DELETIONS_ENV = 'EDGE_FUNCTIONS_PRUNE_MAX_DELETIONS';

/**
 * 1 回のデプロイで消してよい関数の数の上限 (既定)。
 * 根拠: #1452 で本番に残っていた旧い関数は 13 本で、初回はこれを 1 回で消す。リポジトリの関数は 23 本 (2026-10-10 時点) あり、
 * 上限をリポジトリ全体より小さくしておけば、読み違いで本番の関数をまとめて消すことを防げる。
 * 13 本に少し余裕を持たせた 20 本にする。これを超える削除が本当に必要なら、ワークフローの env で
 * EDGE_FUNCTIONS_PRUNE_MAX_DELETIONS を一時的に上げる (理由を PR に書く)。
 */
export const DEFAULT_MAX_DELETIONS = 20;

/** supabase CLI の 1 回の呼び出しの時間の上限を上書きする環境変数 */
export const CLI_TIMEOUT_ENV = 'EDGE_FUNCTIONS_PRUNE_CLI_TIMEOUT_MS';

/**
 * supabase CLI の 1 回の呼び出し (一覧 / 1 本の削除) の時間の上限 (既定、ミリ秒)。
 * 根拠: npx が CLI を取ってくる時間 (初回は数十秒) と API の応答を合わせても、ふつうは 1 分かからない。
 * 倍の余裕を取って 2 分にする。止まったままのときに、ワークフローの時間を使い切らずに赤で終わらせるため。
 */
export const DEFAULT_CLI_TIMEOUT_MS = 120_000;

/** CLI の出力を受け取るバッファの大きさ (関数の一覧の JSON が収まれば足りる。1 本あたり 1KB 未満 × 数十本に対し十分な 16MB) */
export const CLI_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** 本番の Supabase のプロジェクトの ref として受け付ける形 (小文字の英数字。コマンドの引数に変なものを渡さない) */
export const PROJECT_REF_PATTERN = /^[a-z0-9]+$/;

/** 終了コード */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** 安全装置に当たった・入力が想定と違うときの例外 (message は関数名と件数だけを含む) */
export class PruneError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PruneError';
  }
}

/**
 * リポジトリの関数の一覧を作る。functionsDir 直下のディレクトリのうち、名前が _ や . で始まらず、
 * index.ts を持つものが関数 (_shared・README.md・deno.json は関数ではない)。並びは名前の昇順。
 *
 * @param {string} functionsDir
 * @param {{ readdir: (dir: string) => string[], isDirectory: (p: string) => boolean, exists: (p: string) => boolean }} [io]
 * @returns {string[]}
 */
export function listRepoFunctions(functionsDir, io = defaultIo) {
  if (!io.exists(functionsDir) || !io.isDirectory(functionsDir)) return [];
  return io
    .readdir(functionsDir)
    .filter((name) => !NON_FUNCTION_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .filter((name) => io.isDirectory(path.join(functionsDir, name)))
    .filter((name) => io.exists(path.join(functionsDir, name, FUNCTION_ENTRYPOINT)))
    .sort(compareNames);
}

const defaultIo = {
  readdir: (dir) => readdirSync(dir),
  isDirectory: (p) => statSync(p).isDirectory(),
  exists: (p) => existsSync(p),
};

/** 並びを環境 (ロケール) に左右されないようにするための比較 */
function compareNames(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 消す関数を計算する: 本番にあってリポジトリに無い slug。重複は 1 つにまとめ、並びは名前の昇順。
 *
 * @param {readonly string[]} remoteSlugs 本番の関数の slug
 * @param {readonly string[]} repoFunctions リポジトリの関数の名前
 * @returns {string[]}
 */
export function computeFunctionsToDelete(remoteSlugs, repoFunctions) {
  const inRepo = new Set(repoFunctions);
  return [...new Set(remoteSlugs)].filter((slug) => !inRepo.has(slug)).sort(compareNames);
}

/**
 * `supabase functions list -o json` の出力から、本番の関数の slug を取り出す。
 * 出力は関数の配列 ([{ slug, name, status, ... }]) を想定する。{ functions: [...] } の形も受け付ける。
 * 先頭に JSON 以外の行 (CLI のお知らせ等) があれば、行頭の [ または { から読む。
 * 読めない・形が違う・slug が想定外の文字を含むときは PruneError を投げる。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseFunctionsListJson(text) {
  const parsed = parseJsonLenient(String(text ?? ''));
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray(parsed.functions)
      ? parsed.functions
      : null;
  if (!list) throw new PruneError('本番の関数の一覧が想定した形 (関数の配列) ではありません');
  return list.map((item, index) => {
    const slug = item && typeof item === 'object' ? item.slug : undefined;
    if (typeof slug !== 'string') {
      throw new PruneError(`本番の関数の一覧の ${index + 1} 件目に slug がありません`);
    }
    return slug;
  });
}

function parseJsonLenient(text) {
  const trimmed = text.trim();
  if (trimmed === '') throw new PruneError('本番の関数の一覧が空の出力でした (JSON ではありません)');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/^[[{]/m);
    if (start > 0) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        // 下で投げる
      }
    }
    throw new PruneError('本番の関数の一覧を JSON として読めませんでした');
  }
}

/** slug の形を確かめる。想定外の文字を含むものがあれば PruneError (名前は出さず件数だけ出す。想定外の文字をログに流さない) */
export function assertValidSlugs(slugs) {
  const invalid = slugs.filter((slug) => !SLUG_PATTERN.test(slug));
  if (invalid.length > 0) {
    throw new PruneError(`本番の関数の名前に想定外の文字を含むものが ${invalid.length} 件あります`);
  }
}

/**
 * 消す関数の数の上限を決める。環境変数 MAX_DELETIONS_ENV があれば、それ (0 以上の整数) を使う。
 * 整数として読めない値なら PruneError (読み違いで上限が外れないように、既定値に黙って戻さない)。
 *
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function resolveMaxDeletions(env) {
  return resolveNonNegativeIntEnv(env, MAX_DELETIONS_ENV, DEFAULT_MAX_DELETIONS);
}

/** CLI の 1 回の呼び出しの時間の上限 (ミリ秒) を決める */
export function resolveCliTimeoutMs(env) {
  const value = resolveNonNegativeIntEnv(env, CLI_TIMEOUT_ENV, DEFAULT_CLI_TIMEOUT_MS);
  if (value === 0) throw new PruneError(`${CLI_TIMEOUT_ENV} は 1 以上の整数にしてください`);
  return value;
}

function resolveNonNegativeIntEnv(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new PruneError(`${name} は 0 以上の整数にしてください`);
  return Number(raw);
}

/**
 * 消す関数を決める (安全装置を含む)。安全装置に当たったら PruneError。
 *
 * @param {{ remoteSlugs: readonly string[], repoFunctions: readonly string[], maxDeletions: number }} input
 * @returns {string[]}
 */
export function planPrune({ remoteSlugs, repoFunctions, maxDeletions }) {
  if (repoFunctions.length === 0) {
    throw new PruneError('リポジトリの関数が 0 本です。読む場所の間違いを疑い、本番の関数は消しません');
  }
  assertValidSlugs(remoteSlugs);
  const toDelete = computeFunctionsToDelete(remoteSlugs, repoFunctions);
  if (toDelete.length > maxDeletions) {
    throw new PruneError(
      `消す関数が ${toDelete.length} 本あり、上限 ${maxDeletions} 本を超えています (${MAX_DELETIONS_ENV} で変えられます)。1 本も消しません`,
    );
  }
  return toDelete;
}

/** コマンドラインの引数を読む */
export function parseArgs(argv) {
  const options = { apply: false, projectRef: undefined, functionsDir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--project-ref') options.projectRef = argv[++i];
    else if (arg.startsWith('--project-ref=')) options.projectRef = arg.slice('--project-ref='.length);
    else if (arg === '--functions-dir') options.functionsDir = argv[++i];
    else if (arg.startsWith('--functions-dir=')) options.functionsDir = arg.slice('--functions-dir='.length);
    else throw new PruneError(`知らない引数があります: ${arg}`);
  }
  if (!options.projectRef || !PROJECT_REF_PATTERN.test(options.projectRef)) {
    throw new PruneError('--project-ref <小文字の英数字> を指定してください');
  }
  return options;
}

/**
 * supabase CLI を呼ぶ (対話なし。標準入力は閉じる)。
 * 戻り値の stdout / stderr はログに出さない (呼び出し側は status だけを見る。一覧は stdout を JSON として読む)。
 *
 * @param {string[]} args `supabase` のあとに続く引数
 * @param {{ env: Record<string, string | undefined>, timeoutMs: number }} options
 * @returns {{ status: number | null, stdout: string }}
 */
export function runSupabaseCli(args, { env, timeoutMs }) {
  const result = spawnSync('npx', ['--yes', SUPABASE_CLI_PACKAGE, ...args], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: CLI_MAX_BUFFER_BYTES,
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
}

/** 本番の関数の slug の一覧を取る (取れなければ PruneError) */
export function fetchRemoteSlugs(projectRef, run) {
  const result = run(['functions', 'list', '--project-ref', projectRef, '-o', 'json']);
  if (result.status !== 0) {
    throw new PruneError(`本番の関数の一覧を取れませんでした (supabase CLI の終了コード: ${result.status ?? '不明'})`);
  }
  return parseFunctionsListJson(result.stdout);
}

/**
 * 入口。終了コードを返す。
 *
 * @param {string[]} argv
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   run?: (args: string[]) => { status: number | null, stdout: string },
 *   listRepo?: (functionsDir: string) => string[],
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 * }} [deps]
 * @returns {number}
 */
export function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    error(`edge-functions-prune: ${e instanceof PruneError ? e.message : '引数を読めませんでした'}`);
    return EXIT_USAGE;
  }

  const mode = options.apply ? '削除' : 'dry-run (消さない)';
  let toDelete;
  let run;
  try {
    const maxDeletions = resolveMaxDeletions(env);
    const timeoutMs = resolveCliTimeoutMs(env);
    run = deps.run ?? ((args) => runSupabaseCli(args, { env, timeoutMs }));
    const functionsDir = options.functionsDir ?? path.join(repoRoot(), FUNCTIONS_DIR_RELATIVE);
    const repoFunctions = (deps.listRepo ?? listRepoFunctions)(functionsDir);
    const remoteSlugs = fetchRemoteSlugs(options.projectRef, run);
    toDelete = planPrune({ remoteSlugs, repoFunctions, maxDeletions });
    log(
      `edge-functions-prune: ${mode}。リポジトリの関数 ${repoFunctions.length} 本、本番の関数 ${new Set(remoteSlugs).size} 本、上限 ${maxDeletions} 本`,
    );
  } catch (e) {
    error(`edge-functions-prune: 止めました (1 本も消していません): ${e instanceof PruneError ? e.message : '予期しないエラー'}`);
    return EXIT_FAILURE;
  }

  if (toDelete.length === 0) {
    log('edge-functions-prune: 本番にあってリポジトリに無い関数はありません (0 本)');
    return EXIT_OK;
  }

  if (!options.apply) {
    for (const slug of toDelete) log(`edge-functions-prune: 削除予定: ${slug}`);
    log(`edge-functions-prune: 削除予定 ${toDelete.length} 本 (dry-run のため消していません。消すには --apply)`);
    return EXIT_OK;
  }

  const failed = [];
  for (const slug of toDelete) {
    const result = run(['functions', 'delete', slug, '--project-ref', options.projectRef, '--yes']);
    if (result.status === 0) {
      log(`edge-functions-prune: 削除しました: ${slug}`);
    } else {
      failed.push(slug);
      error(`edge-functions-prune: 削除に失敗しました: ${slug} (supabase CLI の終了コード: ${result.status ?? '不明'})`);
    }
  }
  log(`edge-functions-prune: 削除 ${toDelete.length - failed.length} 本 / 失敗 ${failed.length} 本`);
  return failed.length === 0 ? EXIT_OK : EXIT_FAILURE;
}

/** このスクリプトのあるリポジトリの根 (scripts/ の 1 つ上) */
function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
