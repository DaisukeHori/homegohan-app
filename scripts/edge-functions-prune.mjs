#!/usr/bin/env node
/**
 * scripts/edge-functions-prune.mjs — 本番の Supabase にあって、リポジトリ (supabase/functions/) に無い Edge Function を消す
 * (.github/workflows/deploy-supabase-functions.yml の「Deploy all functions」のあとに --apply で呼ぶ。
 *  テストは tests/edge-functions-prune.test.ts。#1452)
 *
 *   node scripts/edge-functions-prune.mjs --project-ref <ref>            # 既定は dry-run (消さずに、消す予定の関数を出すだけ)
 *   node scripts/edge-functions-prune.mjs --project-ref <ref> --apply    # 実際に消す
 *   node scripts/edge-functions-prune.mjs --project-ref <ref> --apply --require-latest main
 *       # origin の main の最新とこのチェックアウトの supabase/functions/ が違えば、何も消さずに終わる (デプロイのワークフローはこれ)
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
 * 古いチェックアウトで消さない (--require-latest <branch>):
 *   削除はチェックアウトした版の関数の一覧と、その時点の本番の一覧の差で決まる。古い版のまま走ると (古い実行の再実行・
 *   並んで走った実行など)、あとの版で足した関数を本番から消してしまう。そこで削除の前に origin の <branch> の最新を取り、
 *   supabase/functions/ がチェックアウトと違えば何も消さずに終了コード 0 で終わる (関数を変えた新しい版は、その版の
 *   デプロイのワークフローが走って消す)。最新を取れない・比べられないときは、1 本も消さず終了コード 1 で終わる。
 *
 * リポジトリの関数の判定 (listRepoFunctions):
 *   supabase/functions/ の直下で、名前が _ や . で始まらず、index.ts を持つディレクトリを関数とみなす。
 *   supabase/config.toml の [functions.<name>] の entrypoint で index.ts 以外の入口 (例: main.ts) を指定した関数は、
 *   この判定では関数に数えられず、デプロイの直後にこの手順で本番から消される。そうした関数を足すときは、先に
 *   この判定 (FUNCTION_ENTRYPOINT) を config.toml の entrypoint も読む形に広げる。いまは config.toml に entrypoint を
 *   書くと tests/edge-function-verify-jwt.test.ts が赤になり、config.toml にある関数が index.ts を持たないと
 *   tests/edge-functions-prune.test.ts が赤になるので、気づかずに足すことはない。
 *
 * ログには、関数の名前と件数、それと失敗の手がかり (終了コード・HTTP の状態の数字・決まった文言の分類) だけを出す。
 * supabase CLI の出力 (stdout / stderr) の文やアクセストークンは出さない (stderr は分類にだけ使い、文はログに流さない)。
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
 * 1 回のデプロイで消してよい関数の数の上限 (既定)。割合ではなく本数で決める (#1455)。
 * 役目: 読み違い (一覧の形の変化・チェックアウトの欠け・関数の判定の漏れ) で本番の関数をまとめて消すのを止める。
 * ふだんの削除は、1 つの PR で関数を 1〜3 本 (旧い版の 3 本組: 週・1 食・差し替え) 廃止するくらいなので、それを通して
 * 少し余裕を持たせた 5 本にする。割合 (本番やリポジトリの関数の数に対する比) にしないのは、関数の判定を読み違えたときは
 * 比べる側の数そのものが狂い、止まるべきところで止まらなくなるため。
 * #1452 の初回の 13 本のような大きな片付けは、ワークフローの env で EDGE_FUNCTIONS_PRUNE_MAX_DELETIONS を
 * 一時的に上げて通す (理由を PR に書き、終わったら戻す)。
 */
export const DEFAULT_MAX_DELETIONS = 5;

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

/** --require-latest に渡すブランチの名前として受け付ける形 (git の引数に変なものを渡さない) */
export const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** `git diff --quiet` の終了コード: 0 = 違いが無い、1 = 違いがある (それ以外は git の失敗) */
export const GIT_DIFF_NO_CHANGES = 0;
export const GIT_DIFF_HAS_CHANGES = 1;

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
  const options = { apply: false, projectRef: undefined, functionsDir: undefined, requireLatest: undefined };
  // 値を取る引数の値が無い (最後の引数だった) ときは止める (値の無い --require-latest で確かめが黙って外れないように)
  const valueOf = (name, index) => {
    const value = argv[index];
    if (value === undefined) throw new PruneError(`${name} の値がありません`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--project-ref') options.projectRef = valueOf(arg, ++i);
    else if (arg.startsWith('--project-ref=')) options.projectRef = arg.slice('--project-ref='.length);
    else if (arg === '--functions-dir') options.functionsDir = valueOf(arg, ++i);
    else if (arg.startsWith('--functions-dir=')) options.functionsDir = arg.slice('--functions-dir='.length);
    else if (arg === '--require-latest') options.requireLatest = valueOf(arg, ++i);
    else if (arg.startsWith('--require-latest=')) options.requireLatest = arg.slice('--require-latest='.length);
    else throw new PruneError(`知らない引数があります: ${arg}`);
  }
  if (!options.projectRef || !PROJECT_REF_PATTERN.test(options.projectRef)) {
    throw new PruneError('--project-ref <小文字の英数字> を指定してください');
  }
  if (options.functionsDir === '') throw new PruneError('--functions-dir の値が空です');
  if (options.requireLatest !== undefined && !BRANCH_PATTERN.test(options.requireLatest)) {
    throw new PruneError('--require-latest <ブランチの名前 (英数字・_・-)> を指定してください');
  }
  return options;
}

/**
 * supabase CLI の stderr から読む HTTP の状態の数字 (CLI 2.62.10 の文言
 * "unexpected delete function status %d: <応答の本文>" / "unexpected list functions status %d: <応答の本文>")。
 * ログに出すのは数字だけで、うしろの応答の本文は出さない。
 */
export const CLI_HTTP_STATUS_PATTERN = /unexpected (?:delete function|list functions) status (\d{3})\b/;

/** HTTP の状態として受け付ける範囲 (この外の数字は読み違いとみなして出さない) */
export const HTTP_STATUS_MIN = 100;
export const HTTP_STATUS_MAX = 599;

/**
 * supabase CLI の stderr の決まった文言 (CLI 2.62.10) と、ログに出す手がかり。文言に当たったら、手がかりの決まった文だけを出す
 * (stderr の文そのものは出さない)。
 */
export const CLI_STDERR_HINTS = [
  { pattern: /does not exist on the Supabase project/, hint: '本番にその関数がありません (HTTP 404)' },
  { pattern: /Access token not provided/, hint: 'アクセストークンがありません (SUPABASE_ACCESS_TOKEN)' },
  { pattern: /Invalid access token format/, hint: 'アクセストークンの形が違います' },
];

/** CLI を起動したときのエラー (spawnSync の error.code) と、ログに出す手がかり */
export const SPAWN_ERROR_HINTS = {
  ETIMEDOUT: `時間切れ (${CLI_TIMEOUT_ENV} で上限を変えられます)`,
  ENOENT: 'CLI を起動できません (npx が見つかりません)',
  ENOBUFS: 'CLI の出力が受け取れる大きさを超えました',
};

/** ログに出してよいエラーのコード・シグナルの名前の形 (英大文字と数字だけ。ほかの文字を含むものは出さない) */
const SAFE_ERROR_CODE_PATTERN = /^E[A-Z0-9]+$/;
const SAFE_SIGNAL_PATTERN = /^SIG[A-Z0-9]+$/;

/**
 * CLI の失敗の手がかりを作る (#1455)。stderr の文・トークンは返さず、決まった文・HTTP の状態の数字・
 * エラーのコード・シグナルの名前だけを返す。手がかりが無ければ空の配列。
 *
 * @param {{ stderr?: string | null, errorCode?: string | null, signal?: string | null }} input
 * @returns {string[]}
 */
export function describeCliFailure({ stderr, errorCode, signal }) {
  const hints = [];
  if (typeof errorCode === 'string' && SAFE_ERROR_CODE_PATTERN.test(errorCode)) {
    hints.push(Object.hasOwn(SPAWN_ERROR_HINTS, errorCode) ? SPAWN_ERROR_HINTS[errorCode] : `CLI を起動できません (${errorCode})`);
  }
  // 時間切れのときは signal (SIGTERM) も付くが、時間切れの手がかりで足りるので重ねない
  if (errorCode !== 'ETIMEDOUT' && typeof signal === 'string' && SAFE_SIGNAL_PATTERN.test(signal)) {
    hints.push(`シグナル ${signal} で止まりました`);
  }
  const text = typeof stderr === 'string' ? stderr : '';
  const httpMatch = CLI_HTTP_STATUS_PATTERN.exec(text);
  if (httpMatch) {
    const httpStatus = Number(httpMatch[1]);
    if (httpStatus >= HTTP_STATUS_MIN && httpStatus <= HTTP_STATUS_MAX) hints.push(`HTTP の状態 ${httpStatus}`);
  }
  for (const { pattern, hint } of CLI_STDERR_HINTS) {
    if (pattern.test(text)) hints.push(hint);
  }
  return hints;
}

/** 失敗のログの括弧の中: 終了コードと、あれば手がかり */
export function formatCliFailure(result) {
  const hints = Array.isArray(result.hints) && result.hints.length > 0 ? `、手がかり: ${result.hints.join('・')}` : '';
  return `supabase CLI の終了コード: ${result.status ?? '不明'}${hints}`;
}

/**
 * supabase CLI を呼ぶ (対話なし。標準入力は閉じる)。
 * stdout / stderr の文はログに出さない (呼び出し側は status と hints だけを見る。一覧は stdout を JSON として読む)。
 * stderr はここで describeCliFailure にかけて手がかりに変え、文そのものは戻り値に含めない。
 *
 * @param {string[]} args `supabase` のあとに続く引数
 * @param {{ env: Record<string, string | undefined>, timeoutMs: number, spawn?: typeof spawnSync }} options
 * @returns {{ status: number | null, stdout: string, hints: string[] }}
 */
export function runSupabaseCli(args, { env, timeoutMs, spawn = spawnSync }) {
  const result = spawn('npx', ['--yes', SUPABASE_CLI_PACKAGE, ...args], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: CLI_MAX_BUFFER_BYTES,
  });
  const status = result.error ? null : result.status;
  const hints =
    status === 0
      ? []
      : describeCliFailure({ stderr: result.stderr, errorCode: result.error?.code, signal: result.signal });
  return { status, stdout: result.stdout ?? '', hints };
}

/**
 * git を呼ぶ (対話なし。標準入力は閉じる)。stdout / stderr はログに出さない (呼び出し側は status だけを見る)。
 *
 * @param {string[]} args `git` のあとに続く引数
 * @param {{ cwd: string, env: Record<string, string | undefined>, timeoutMs: number }} options
 * @returns {{ status: number | null, stdout: string }}
 */
export function runGit(args, { cwd, env, timeoutMs }) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: CLI_MAX_BUFFER_BYTES,
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
}

/**
 * このチェックアウトの関数のディレクトリが、origin の branch の最新と同じかを確かめる。
 * 同じなら true、違えば false。最新を取れない・比べられないときは PruneError (消さずに止める)。
 *
 * @param {string} branch origin のブランチの名前 (BRANCH_PATTERN に合うもの)
 * @param {string} functionsPath リポジトリの根から見た関数のディレクトリ (/ 区切り)
 * @param {(args: string[]) => { status: number | null, stdout: string }} git
 * @returns {boolean}
 */
export function functionsMatchLatest(branch, functionsPath, git) {
  // 浅いチェックアウト (CI の actions/checkout の既定) では最新の 1 版だけを取る。浅くないリポジトリ (手元) で --depth を
  // 付けると、そのリポジトリが浅くなってしまうので付けない。
  const shallow = git(['rev-parse', '--is-shallow-repository']);
  const shallowAnswer = shallow.stdout.trim();
  if (shallow.status !== 0 || (shallowAnswer !== 'true' && shallowAnswer !== 'false')) {
    throw new PruneError(`チェックアウトが浅いかどうかを確かめられませんでした (git の終了コード: ${shallow.status ?? '不明'})`);
  }
  const depthArgs = shallowAnswer === 'true' ? ['--depth=1'] : [];
  const fetched = git(['fetch', '--no-tags', ...depthArgs, 'origin', `refs/heads/${branch}`]);
  if (fetched.status !== 0) {
    throw new PruneError(`origin の ${branch} の最新を取れませんでした (git の終了コード: ${fetched.status ?? '不明'})`);
  }
  const diff = git(['diff', '--quiet', 'HEAD', 'FETCH_HEAD', '--', functionsPath]);
  if (diff.status === GIT_DIFF_NO_CHANGES) return true;
  if (diff.status === GIT_DIFF_HAS_CHANGES) return false;
  throw new PruneError(`origin の ${branch} の最新と関数を比べられませんでした (git の終了コード: ${diff.status ?? '不明'})`);
}

/** リポジトリの根から見た関数のディレクトリ (/ 区切り)。リポジトリの外なら PruneError */
export function functionsPathFromRoot(root, functionsDir) {
  const relative = path.relative(root, path.resolve(functionsDir));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PruneError('関数のディレクトリがリポジトリの中にありません (--require-latest で比べられません)');
  }
  return relative.split(path.sep).join('/');
}

/** 本番の関数の slug の一覧を取る (取れなければ PruneError) */
export function fetchRemoteSlugs(projectRef, run) {
  const result = run(['functions', 'list', '--project-ref', projectRef, '-o', 'json']);
  if (result.status !== 0) {
    throw new PruneError(`本番の関数の一覧を取れませんでした (${formatCliFailure(result)})`);
  }
  return parseFunctionsListJson(result.stdout);
}

/**
 * 入口。終了コードを返す。
 *
 * @param {string[]} argv
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   run?: (args: string[]) => { status: number | null, stdout: string, hints?: string[] },
 *   git?: (args: string[]) => { status: number | null, stdout: string },
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
    const root = repoRoot();
    const functionsDir = options.functionsDir ?? path.join(root, FUNCTIONS_DIR_RELATIVE);
    if (options.requireLatest !== undefined) {
      const git = deps.git ?? ((args) => runGit(args, { cwd: root, env, timeoutMs }));
      const functionsPath = functionsPathFromRoot(root, functionsDir);
      if (!functionsMatchLatest(options.requireLatest, functionsPath, git)) {
        log(
          `edge-functions-prune: このチェックアウトの ${functionsPath} は origin の ${options.requireLatest} の最新と違います。` +
            '古い版で本番の関数を消さないよう、何も消しません (関数を変えた新しい版のデプロイが消します)',
        );
        return EXIT_OK;
      }
    }
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
      error(`edge-functions-prune: 削除に失敗しました: ${slug} (${formatCliFailure(result)})`);
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
