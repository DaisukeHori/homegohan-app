/**
 * Cron の共有シークレットのずれの検査 (#1196)。入口は scripts/check-cron-secret-drift.mjs。
 *
 * cron の共有シークレットは、次の 3 か所に別々に置かれていて、自動では同期されない
 * (ENV_SETUP.md の「Cron の共有シークレットの保管場所とローテーション」)。
 *   - Supabase の Edge Function secrets: CRON_SECRET (無いときだけ別名 SERVICE_ROLE_SECRET) と、入れ替えの間だけの CRON_SECRET_PREVIOUS
 *   - Supabase Vault: app_cron_secret (pg_cron が Edge Function を呼ぶときの Bearer)
 *   - Vercel の環境変数: CRON_SECRET (と CRON_SECRET_PREVIOUS)
 * このうち、値を合わせないと動かないのは「Edge Function secrets の CRON_SECRET」と「Vault の app_cron_secret」の 2 つ。
 * Vercel の CRON_SECRET は送る側も受ける側も Vercel の中で完結するので、他と別の値でよい (一致・不一致は参考として出す)。
 *
 * 値そのものは比べない・出さない。各保管場所から SHA-256 のダイジェストだけを得て比べる。
 *   - Edge Function secrets: `supabase secrets list -o json` が返すダイジェスト (Supabase の API は値を返さず、SHA-256 のダイジェストだけを返す)
 *   - Vault: SQL で digest(decrypted_secret, 'sha256') を計算させる (値は DB の外に出ない)。
 *            psql で接続するか、SQL Editor で実行した結果のダイジェストを --vault-digest で渡す
 *   - Vercel: `vercel env pull` を、権限 700 の一時ディレクトリに umask 077 で書かせ、ダイジェストを計算したらすぐ消す
 * 出力は一致・不一致と、ダイジェストの先頭 DIGEST_PREFIX_LENGTH 文字だけ。どの保管場所も読むだけで、書き換えない。
 *
 * 本番の資格情報 (Supabase のアクセストークン・DB の接続先・Vercel のログイン) が要るので、実行するのはオーナー。
 *
 * 判定の意味:
 *   PASS  期待どおり
 *   WARN  今すぐ止まるわけではないが、確かめるか片づけたほうがよい (入れ替えの途中・旧い値の残り、など)
 *   FAIL  cron の呼び出しが 401 / 503 になる (値のずれ・未設定)
 *   INFO  参考情報
 *   SKIP  確かめていない (--skip-* で外した保管場所)
 * 終了コード: 0 = FAIL なし / 1 = FAIL あり / 2 = 引数の誤り、または読めなかった保管場所がある (判定できない)
 *
 * 単体テストから使えるよう、本体 (このファイル) と入口を分けてある。外部のコマンドの実行 (run) と
 * ファイルの操作 (fsApi)、保管場所の読み取り (stores) は差し替えられるので、テストは本物の Vercel / Supabase に接続しない。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

/** Edge Function secrets と Vercel の環境変数の名前 */
export const CURRENT_NAME = 'CRON_SECRET';
export const PREVIOUS_NAME = 'CRON_SECRET_PREVIOUS';
/** Edge Function secrets の別名。CRON_SECRET が無いときだけ使われる (_shared/auth.ts の `CRON_SECRET ?? SERVICE_ROLE_SECRET`) */
export const ALIAS_NAME = 'SERVICE_ROLE_SECRET';
/** Vault の名前 (pg_cron の関数が vault.decrypted_secrets から読む) */
export const VAULT_SECRET_NAME = 'app_cron_secret';

/** 出力するダイジェストの先頭の文字数。照合の目印には足り、値の推測の手がかりにはならない長さ (#1196 の方針) */
export const DIGEST_PREFIX_LENGTH = 8;
/** SHA-256 の 16 進表記の長さ (32 バイト = 64 文字) */
export const SHA256_HEX_LENGTH = 64;
/** 外部のコマンド 1 つを待つ上限の既定値。vercel env pull はログインの確認を含めて数十秒かかることがあるため 2 分 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
/** ミリ秒を秒に直す (案内の文の表示用) */
const MS_PER_SECOND = 1000;
/** 上の上限を上書きする環境変数 */
export const TIMEOUT_ENV_NAME = 'CRON_SECRET_DRIFT_TIMEOUT_MS';
/** コマンドが失敗したときに出す、標準エラー出力の末尾の行数 (原因の手がかりに足りる分だけ) */
export const STDERR_TAIL_LINES = 5;
/** Vault の接続先 (postgres:// の URL) を読む環境変数の既定の名前 */
export const DEFAULT_DB_URL_ENV = 'SUPABASE_DB_URL';
/** Vercel の環境 (production / preview / development) の既定値 */
export const DEFAULT_VERCEL_ENVIRONMENT = 'production';
/**
 * vercel env pull が Sensitive の変数の値の代わりに書く文字列。vercel CLI の SENSITIVE_PLACEHOLDER と同じ
 * (58.10.0 の envPullCommandLogic: Vercel の API が空で返した type === 'sensitive' のキーを、この文字列で書き出す)。
 * 古い vercel CLI や、CLI が Sensitive のキーを引けなかったときは空で書かれる。どちらも値を取り出せない印として扱う。
 */
export const VERCEL_SENSITIVE_PLACEHOLDER = '[SENSITIVE]';
/** Supabase の project ref を読む環境変数 (--project-ref が無いとき) */
export const PROJECT_REF_ENV_NAME = 'SUPABASE_PROJECT_REF';
/** 接続先の URL に sslmode が無いときに使う値 (Supabase の DB は TLS を要求する) */
export const DEFAULT_PG_SSLMODE = 'require';

const HEX_DIGEST_PATTERN = new RegExp(`^[0-9a-f]{${SHA256_HEX_LENGTH}}$`);

/** 文字列 (UTF-8) の SHA-256 を 16 進で返す。Supabase のダイジェスト・Vault の digest() と同じ形 */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 空文字の SHA-256。Edge Function secrets に空の値が入っているかは、このダイジェストで分かる */
export const EMPTY_SHA256 = sha256Hex('');

/**
 * Vault のダイジェストを計算する SQL。SQL Editor で実行して --vault-digest に渡すこともできる。
 * 値そのものは返さない。行が無ければ Vault に app_cron_secret が無い。空の文字列の行は、復号できなかった印。
 */
export const VAULT_DIGEST_SQL = `SELECT coalesce(encode(extensions.digest(convert_to(decrypted_secret, 'UTF8'), 'sha256'), 'hex'), '') AS digest FROM vault.decrypted_secrets WHERE name = '${VAULT_SECRET_NAME}';`;

export class UsageError extends Error {}

export const HELP = `使い方: node scripts/check-cron-secret-drift.mjs [オプション]

Cron の共有シークレット (CRON_SECRET) が、Supabase の Edge Function secrets・Supabase Vault (${VAULT_SECRET_NAME})・
Vercel の環境変数で食い違っていないかを確かめます。値は表示せず、SHA-256 のダイジェストの先頭 ${DIGEST_PREFIX_LENGTH} 文字だけを出します。
どの保管場所も読むだけで、書き換えません。

  --project-ref <ref>       Supabase の project ref (既定: 環境変数 ${PROJECT_REF_ENV_NAME})。supabase secrets list に渡す
  --db-url-env <名前>       Vault を読むための DB の接続先 (postgres://...) を入れた環境変数の名前 (既定: ${DEFAULT_DB_URL_ENV})。
                            値はコマンドラインに書かず、環境変数で渡します。psql で接続します
  --vault-digest <16進>     psql を使わず、SQL Editor で次の SQL を実行して得たダイジェスト (64 文字) を渡す:
                            ${VAULT_DIGEST_SQL}
                            (行が出なかったら --vault-missing を付ける)
  --vault-missing           SQL Editor で上の SQL を実行して、行が出なかった (Vault に ${VAULT_SECRET_NAME} が無い)
  --vercel-environment <環境>  Vercel の環境 (既定: ${DEFAULT_VERCEL_ENVIRONMENT})
  --vercel-project <名前>   Vercel のプロジェクト (既定: このディレクトリにリンクしたもの)
  --vercel-scope <チーム>   Vercel のチーム
  --vercel-must-match       Vercel の CRON_SECRET が Supabase 側と違ったら FAIL にする (既定は参考として出すだけ。別の値でよいため)
  --skip-edge / --skip-vault / --skip-vercel   その保管場所を確かめない
  --supabase-bin <コマンド> / --vercel-bin <コマンド> / --psql-bin <コマンド>   使うコマンド (既定: supabase / vercel / psql)
  --help                    このメッセージ

要るもの: supabase CLI (ログイン済み、または SUPABASE_ACCESS_TOKEN)・vercel CLI (ログイン済み)・psql (--vault-digest を使わないとき)。
Vercel の Sensitive の変数は、vercel env pull で値の代わりに ${VERCEL_SENSITIVE_PLACEHOLDER} (古い vercel CLI では空) で書かれるので、
ある・無いだけを確かめ、値は照合しません (WARN)。
コマンド 1 つを待つ上限は ${DEFAULT_COMMAND_TIMEOUT_MS / MS_PER_SECOND} 秒です (環境変数 ${TIMEOUT_ENV_NAME} にミリ秒で書くと変えられます)。
終了コード: 0 = 問題なし (警告は除く) / 1 = 値のずれ・未設定あり / 2 = 引数の誤り、または読めなかった保管場所がある`;

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 */
export function parseArgs(argv, env = process.env) {
  const options = {
    projectRef: env[PROJECT_REF_ENV_NAME]?.trim() || undefined,
    dbUrlEnv: DEFAULT_DB_URL_ENV,
    vaultDigest: undefined,
    vaultMissing: false,
    vercelEnvironment: DEFAULT_VERCEL_ENVIRONMENT,
    vercelProject: undefined,
    vercelScope: undefined,
    vercelMustMatch: false,
    skipEdge: false,
    skipVault: false,
    skipVercel: false,
    supabaseBin: 'supabase',
    vercelBin: 'vercel',
    psqlBin: 'psql',
    help: false,
  };
  const valueFlags = {
    '--project-ref': 'projectRef',
    '--db-url-env': 'dbUrlEnv',
    '--vault-digest': 'vaultDigest',
    '--vercel-environment': 'vercelEnvironment',
    '--vercel-project': 'vercelProject',
    '--vercel-scope': 'vercelScope',
    '--supabase-bin': 'supabaseBin',
    '--vercel-bin': 'vercelBin',
    '--psql-bin': 'psqlBin',
  };
  const booleanFlags = {
    '--vault-missing': 'vaultMissing',
    '--vercel-must-match': 'vercelMustMatch',
    '--skip-edge': 'skipEdge',
    '--skip-vault': 'skipVault',
    '--skip-vercel': 'skipVercel',
    '--help': 'help',
    '-h': 'help',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (Object.hasOwn(valueFlags, flag)) {
      let value = inline;
      if (value === undefined) {
        value = argv[i + 1];
        i += 1;
      }
      if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`${flag} には値が必要です`);
      options[valueFlags[flag]] = value;
    } else if (Object.hasOwn(booleanFlags, flag)) {
      if (inline !== undefined) throw new UsageError(`${flag} は値をとりません`);
      options[booleanFlags[flag]] = true;
    } else {
      throw new UsageError(`知らないオプションです: ${flag}`);
    }
  }
  if (options.help) return options;

  if (options.vaultDigest !== undefined) {
    const normalized = options.vaultDigest.trim().toLowerCase();
    // 値そのものを渡してしまった場合に、エラーの文に値を出さない
    if (!HEX_DIGEST_PATTERN.test(normalized)) throw new UsageError(`--vault-digest には SHA-256 のダイジェスト (16 進 ${SHA256_HEX_LENGTH} 文字) を渡してください (渡された値は表示しません)`);
    options.vaultDigest = normalized;
  }
  if (options.vaultDigest !== undefined && options.vaultMissing) throw new UsageError('--vault-digest と --vault-missing は同時に使えません');
  if (options.skipVault && (options.vaultDigest !== undefined || options.vaultMissing)) {
    throw new UsageError('--skip-vault と --vault-digest / --vault-missing は同時に使えません');
  }
  if (!options.skipEdge && !options.projectRef) {
    throw new UsageError(`Supabase の project ref がありません。--project-ref か環境変数 ${PROJECT_REF_ENV_NAME} で渡すか、--skip-edge を付けてください`);
  }
  if (options.skipEdge && options.skipVault && options.skipVercel) throw new UsageError('確かめる保管場所がありません (--skip-* をすべて付けています)');
  return options;
}

/** ダイジェストの先頭だけ (出力用) */
export function digestPrefix(digest) {
  return digest.slice(0, DIGEST_PREFIX_LENGTH);
}

/**
 * 保管場所の 1 つの名前の状態。
 *   undefined                       設定されていない
 *   { kind: 'digest', digest }      設定あり (空の値は digest === EMPTY_SHA256)
 *   { kind: 'unreadable' }          あるが、値を取り出せない (Vercel の Sensitive の変数など)
 */

/** 保管場所の読み取りの結果 */
const ok = (entries) => ({ state: 'ok', entries });
const failed = (message) => ({ state: 'error', message });
const SKIPPED = Object.freeze({ state: 'skipped' });

/**
 * `supabase secrets list -o json` の出力から、名前ごとのダイジェストを取り出す。
 * 形は [{ name, value }] (value は SHA-256 のダイジェスト)。digest というキーで来ても読む。
 * 想定と違う形なら例外 (値を出力しないよう、中身はエラーの文に入れない)。
 */
export function parseSupabaseSecretsJson(stdout, names = [CURRENT_NAME, PREVIOUS_NAME, ALIAS_NAME]) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('supabase secrets list の出力が JSON ではありません');
  }
  if (!Array.isArray(parsed)) throw new Error('supabase secrets list の出力が配列ではありません');
  const entries = {};
  for (const item of parsed) {
    if (!item || typeof item.name !== 'string') throw new Error('supabase secrets list の出力に name の無い行があります');
    if (!names.includes(item.name)) continue;
    const raw = typeof item.value === 'string' ? item.value : item.digest;
    const digest = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!HEX_DIGEST_PATTERN.test(digest)) {
      throw new Error(`supabase secrets list の ${item.name} がダイジェスト (16 進 ${SHA256_HEX_LENGTH} 文字) の形ではありません (内容は表示しません)`);
    }
    entries[item.name] = { kind: 'digest', digest };
  }
  return entries;
}

/**
 * vercel env pull が書いたファイルの中身から、名前ごとのダイジェストを計算する。値は返さない。
 * VERCEL_SENSITIVE_PLACEHOLDER と空の値は「取り出せない」として扱う。Sensitive の変数は、vercel env pull では
 * 値の代わりに VERCEL_SENSITIVE_PLACEHOLDER (古い vercel CLI や、CLI が Sensitive のキーを引けなかったときは空) で書かれるため。
 * これをダイジェストにすると、別の値どうしが同じダイジェストになり、照合の結果が嘘になる。
 */
export function digestsFromEnvText(text, names = [CURRENT_NAME, PREVIOUS_NAME]) {
  const parsed = parseEnv(text);
  const entries = {};
  for (const name of names) {
    if (!Object.hasOwn(parsed, name)) continue;
    const value = parsed[name];
    entries[name] = value === '' || value === VERCEL_SENSITIVE_PLACEHOLDER ? { kind: 'unreadable' } : { kind: 'digest', digest: sha256Hex(value) };
  }
  return entries;
}

/**
 * psql の出力 (-A -t。1 行 1 ダイジェスト) から Vault の状態を作る。
 *   行なし → 未設定 / 64 文字の 16 進 → ダイジェスト / 空行 → 復号できない / 2 行以上・ほかの形 → 例外
 */
export function parseVaultDigestOutput(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line, index, all) => !(line === '' && index === all.length - 1));
  if (lines.length === 0) return {};
  if (lines.length > 1) throw new Error(`Vault に ${VAULT_SECRET_NAME} が ${lines.length} 行あります`);
  const digest = lines[0].trim().toLowerCase();
  if (digest === '') return { [VAULT_SECRET_NAME]: { kind: 'unreadable' } };
  if (!HEX_DIGEST_PATTERN.test(digest)) throw new Error('Vault のダイジェストの形が想定と違います (内容は表示しません)');
  return { [VAULT_SECRET_NAME]: { kind: 'digest', digest } };
}

/** 文の中の秘密の文字列を伏せる (コマンドの標準エラー出力を見せるときの用心) */
export function redact(text, secrets) {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join('***');
  }
  return result;
}

function stderrTail(stderr, secrets = []) {
  const lines = redact(stderr ?? '', secrets)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
  return lines.slice(-STDERR_TAIL_LINES).join(' / ');
}

function commandFailure(label, result, secrets = []) {
  if (result.error === 'ENOENT') return `${label} のコマンドが見つかりません。インストールするか、--*-bin で指定してください`;
  if (result.error === 'TIMEOUT') return `${label} が時間内に終わりませんでした (環境変数 ${TIMEOUT_ENV_NAME} で上限を変えられます)`;
  if (result.error) return `${label} を実行できませんでした (${result.error})`;
  const tail = stderrTail(result.stderr, secrets);
  return `${label} が終了コード ${result.code} で失敗しました${tail ? `: ${tail}` : ''}`;
}

/** DB の接続先の URL を、psql の環境変数 (PG*) に分ける。URL をコマンドラインに載せないため */
export function pgEnvFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DB の接続先が URL の形ではありません (内容は表示しません)');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DB の接続先は postgres:// か postgresql:// で始まる URL にしてください');
  }
  const pgEnv = {
    PGHOST: parsed.hostname,
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'postgres',
    PGSSLMODE: parsed.searchParams.get('sslmode') || DEFAULT_PG_SSLMODE,
  };
  if (parsed.port) pgEnv.PGPORT = parsed.port;
  return pgEnv;
}

/** 環境変数で上書きできる、コマンドを待つ上限 (ミリ秒) */
export function commandTimeoutMs(env) {
  const raw = env[TIMEOUT_ENV_NAME];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_COMMAND_TIMEOUT_MS;
}

/**
 * 外部のコマンドを実行する (既定の run)。シェルは通さない。標準出力・標準エラー出力は呼び出し側に返すだけで、端末には出さない。
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, error?: string }>}
 */
export function runCommand(command, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error: error?.code ?? 'spawn failed' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ code: null, stdout, stderr, error: 'TIMEOUT' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish({ code: null, stdout, stderr, error: error?.code ?? 'spawn failed' }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

/**
 * 本物の保管場所を読む関数の組を作る。run / fsApi / tmpdir を差し替えればテストからも使える。
 * @param {{ options: ReturnType<typeof parseArgs>, env: Record<string, string | undefined>, run?: typeof runCommand, fsApi?: Pick<typeof fsPromises, 'mkdtemp' | 'readFile' | 'rm'>, tmpdir?: string }} deps
 */
export function createDefaultStores({ options, env, run = runCommand, fsApi = fsPromises, tmpdir = os.tmpdir() }) {
  const timeoutMs = commandTimeoutMs(env);

  async function readEdge() {
    const result = await run(options.supabaseBin, ['secrets', 'list', '--project-ref', options.projectRef, '-o', 'json'], { env, timeoutMs });
    if (result.error || result.code !== 0) return failed(commandFailure('supabase secrets list', result));
    try {
      return ok(parseSupabaseSecretsJson(result.stdout));
    } catch (error) {
      return failed(error.message);
    }
  }

  async function readVault() {
    if (options.vaultMissing) return ok({});
    if (options.vaultDigest !== undefined) return ok({ [VAULT_SECRET_NAME]: { kind: 'digest', digest: options.vaultDigest } });
    const url = env[options.dbUrlEnv];
    if (!url) {
      return failed(`環境変数 ${options.dbUrlEnv} に DB の接続先がありません。設定するか、SQL Editor で得たダイジェストを --vault-digest で渡してください`);
    }
    let pgEnv;
    try {
      pgEnv = pgEnvFromUrl(url);
    } catch (error) {
      return failed(error.message);
    }
    const childEnv = { ...env, ...pgEnv };
    delete childEnv[options.dbUrlEnv];
    const result = await run(options.psqlBin, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', VAULT_DIGEST_SQL], { env: childEnv, timeoutMs });
    if (result.error || result.code !== 0) return failed(commandFailure('psql', result, [url, pgEnv.PGPASSWORD]));
    try {
      return ok(parseVaultDigestOutput(result.stdout));
    } catch (error) {
      return failed(error.message);
    }
  }

  async function readVercel() {
    // 権限 700 の一時ディレクトリ。中のファイルは umask 077 で書かせ、ダイジェストを計算したらディレクトリごと消す
    const dir = await fsApi.mkdtemp(path.join(tmpdir, 'cron-secret-drift-'));
    const file = path.join(dir, 'vercel.env');
    try {
      const args = ['env', 'pull', file, `--environment=${options.vercelEnvironment}`, '--yes'];
      if (options.vercelProject) args.push(`--project=${options.vercelProject}`);
      if (options.vercelScope) args.push(`--scope=${options.vercelScope}`);
      const result = await run('/bin/sh', ['-c', 'umask 077 && exec "$@"', 'sh', options.vercelBin, ...args], { env, timeoutMs });
      if (result.error || result.code !== 0) return failed(commandFailure('vercel env pull', result));
      let text;
      try {
        text = await fsApi.readFile(file, 'utf8');
      } catch {
        return failed('vercel env pull の書いたファイルを読めませんでした');
      }
      return ok(digestsFromEnvText(text));
    } finally {
      await fsApi.rm(dir, { recursive: true, force: true });
    }
  }

  return {
    edge: options.skipEdge ? async () => SKIPPED : readEdge,
    vault: options.skipVault ? async () => SKIPPED : readVault,
    vercel: options.skipVercel ? async () => SKIPPED : readVercel,
  };
}

/** 空でないダイジェストか */
const usable = (entry) => entry?.kind === 'digest' && entry.digest !== EMPTY_SHA256;

/** 名前の状態を 1 語で */
export function describeEntry(entry) {
  if (!entry) return '未設定';
  if (entry.kind === 'unreadable') return '値を取り出せない';
  if (entry.digest === EMPTY_SHA256) return '空の値';
  return `設定あり (${digestPrefix(entry.digest)})`;
}

/**
 * Edge Function が実際に照合に使う現行の値 (_shared/auth.ts の `CRON_SECRET ?? SERVICE_ROLE_SECRET`)。
 * CRON_SECRET が空の値で置いてあれば、別名には切り替わらない (?? は空文字を素通しする)。
 */
export function effectiveEdgeCurrent(entries) {
  if (entries[CURRENT_NAME]) return { name: CURRENT_NAME, entry: entries[CURRENT_NAME] };
  if (entries[ALIAS_NAME]) return { name: ALIAS_NAME, entry: entries[ALIAS_NAME] };
  return { name: CURRENT_NAME, entry: undefined };
}

/**
 * 3 か所の読み取りの結果から、判定の一覧を作る。
 * @param {{ edge: object, vault: object, vercel: object }} snapshot
 * @param {{ vercelMustMatch?: boolean }} [options]
 * @returns {{ id: string, level: 'pass' | 'warn' | 'fail' | 'info' | 'skip' | 'error', title: string, detail: string }[]}
 */
export function evaluate(snapshot, { vercelMustMatch = false } = {}) {
  const checks = [];
  const add = (id, level, title, detail) => checks.push({ id, level, title, detail });
  const { edge, vault, vercel } = snapshot;

  for (const [id, label, store] of [
    ['edge-read', 'Edge Function secrets', edge],
    ['vault-read', 'Vault', vault],
    ['vercel-read', 'Vercel の環境変数', vercel],
  ]) {
    if (store.state === 'error') add(id, 'error', `${label} を読めませんでした`, store.message);
    if (store.state === 'skipped') add(id, 'skip', `${label} は確かめていません`, '--skip-* を外すと確かめます');
  }

  // ── Edge Function secrets (受ける側) ──
  let edgeCurrent;
  let edgePrevious;
  if (edge.state === 'ok') {
    const effective = effectiveEdgeCurrent(edge.entries);
    edgePrevious = edge.entries[PREVIOUS_NAME];
    if (usable(effective.entry)) {
      edgeCurrent = effective.entry.digest;
      add(
        'edge-current',
        'pass',
        `Edge Function secrets の現行の値 (${effective.name}) が設定されています`,
        effective.name === ALIAS_NAME ? `${CURRENT_NAME} が無いので、別名の ${ALIAS_NAME} が使われています。${CURRENT_NAME} に移すと分かりやすくなります` : '',
      );
    } else {
      add(
        'edge-current',
        'fail',
        `Edge Function secrets に現行の値がありません (${CURRENT_NAME}: ${describeEntry(edge.entries[CURRENT_NAME])} / ${ALIAS_NAME}: ${describeEntry(edge.entries[ALIAS_NAME])})`,
        'Edge Function は HTTP 503 ({"error":"Service not configured"}) を返し、pg_cron からの呼び出しがすべて止まります',
      );
    }
    if (edge.entries[CURRENT_NAME] && edge.entries[ALIAS_NAME] && usable(edge.entries[ALIAS_NAME])) {
      add('edge-alias-unused', 'info', `${ALIAS_NAME} は使われていません`, `${CURRENT_NAME} があるときは ${ALIAS_NAME} を見ません。混乱を避けるなら削除してください`);
    }
  }

  // ── Vault (送る側) ──
  let vaultDigest;
  if (vault.state === 'ok') {
    const entry = vault.entries[VAULT_SECRET_NAME];
    if (usable(entry)) {
      vaultDigest = entry.digest;
      add('vault-present', 'pass', `Vault に ${VAULT_SECRET_NAME} があります`, '');
    } else {
      add(
        'vault-present',
        'fail',
        `Vault の ${VAULT_SECRET_NAME}: ${describeEntry(entry)}`,
        'pg_cron の関数 (invoke_catalog_import など) が例外で止まります。ENV_SETUP.md の「Catalog cron secret (Supabase Vault)」の手順で作ってください',
      );
    }
  }

  // ── Edge ⇔ Vault (値を合わせないと動かない組) ──
  if (edgeCurrent && vaultDigest) {
    if (edgeCurrent === vaultDigest) {
      add('edge-vault-match', 'pass', `Edge Function secrets と Vault の ${VAULT_SECRET_NAME} は一致しています`, '');
    } else if (usable(edgePrevious) && edgePrevious.digest === vaultDigest) {
      add(
        'edge-vault-match',
        'warn',
        `Vault の ${VAULT_SECRET_NAME} は、Edge Function secrets の旧い値 (${PREVIOUS_NAME}) と一致しています`,
        '入れ替えの途中です (手順 2 と 3 の間)。今は通りますが、Vault を新しい値に更新してください (ENV_SETUP.md の「ローテーション手順」の 3)',
      );
    } else {
      add(
        'edge-vault-match',
        'fail',
        `Edge Function secrets と Vault の ${VAULT_SECRET_NAME} が食い違っています`,
        'pg_cron からの呼び出しが HTTP 401 ({"error":"Unauthorized"}) になります。どちらが正しい値かを控え (パスワードマネージャ) で確かめ、もう一方を合わせてください',
      );
    }
  } else if (edge.state !== 'error' && vault.state !== 'error' && (edge.state === 'skipped' || vault.state === 'skipped')) {
    add('edge-vault-match', 'warn', `Edge Function secrets と Vault の ${VAULT_SECRET_NAME} の一致は確かめていません`, '値を合わせないと動かない組です。両方を確かめてください');
  }

  // ── Edge Function secrets の CRON_SECRET_PREVIOUS ──
  if (edge.state === 'ok' && edgePrevious) {
    if (!usable(edgePrevious)) {
      add('edge-previous', 'info', `Edge Function secrets の ${PREVIOUS_NAME}: ${describeEntry(edgePrevious)}`, '空の値は無視されます。入れ替えをしていないなら削除してかまいません');
    } else if (edgeCurrent && edgePrevious.digest === edgeCurrent) {
      add('edge-previous', 'warn', `Edge Function secrets の ${PREVIOUS_NAME} が現行の値と同じです`, '入れ替えの意味がありません。旧い値を入れるか、削除してください');
    } else if (vaultDigest && edgeCurrent === vaultDigest) {
      add(
        'edge-previous',
        'warn',
        `Edge Function secrets に ${PREVIOUS_NAME} が残っています`,
        'Vault はもう新しい値です。外すまでは旧い値でも通るので、旧い値で認証された記録がログに無いことを確かめて削除してください (手順 5)',
      );
    } else {
      add('edge-previous', 'info', `Edge Function secrets に ${PREVIOUS_NAME} があります (入れ替えの途中)`, '入れ替えが終わったら削除してください');
    }
  }

  // ── Vercel (独立。参考として出す) ──
  if (vercel.state === 'ok') {
    const current = vercel.entries[CURRENT_NAME];
    const previous = vercel.entries[PREVIOUS_NAME];
    let vercelCurrent;
    if (usable(current)) {
      vercelCurrent = current.digest;
      add('vercel-current', 'pass', `Vercel の ${CURRENT_NAME} が設定されています`, '');
    } else if (current?.kind === 'unreadable') {
      add(
        'vercel-current',
        'warn',
        `Vercel の ${CURRENT_NAME} は値を取り出せません`,
        `Sensitive の変数は vercel env pull で値の代わりに ${VERCEL_SENSITIVE_PLACEHOLDER} (古い vercel CLI では空) で書かれ、空の値と同じく値を取り出せません。ある・無いだけは分かりますが、値の照合はできません。空の値なら cron の API は HTTP 503 を返すので、Vercel の Cron Jobs の画面で HTTP ステータスを確かめてください`,
      );
    } else {
      add('vercel-current', 'fail', `Vercel の ${CURRENT_NAME}: ${describeEntry(current)}`, 'cron の API (/api/cron/*) が HTTP 503 を返し、Vercel Cron が動きません');
    }

    const supabaseDigest = edgeCurrent ?? vaultDigest;
    if (vercelCurrent && supabaseDigest) {
      if (vercelCurrent === supabaseDigest) {
        add('vercel-vs-supabase', 'info', `Vercel の ${CURRENT_NAME} は Supabase 側と同じ値です`, '別の値にしておくと、片方が漏れてももう片方は守られます (合わせる必要はありません)');
      } else if (vercelMustMatch) {
        add('vercel-vs-supabase', 'fail', `Vercel の ${CURRENT_NAME} が Supabase 側と食い違っています (--vercel-must-match)`, '同じ値で運用しているなら、どちらかを合わせてください');
      } else {
        add('vercel-vs-supabase', 'info', `Vercel の ${CURRENT_NAME} は Supabase 側と別の値です`, 'Vercel の CRON_SECRET は独立しているので、別の値でかまいません');
      }
    } else if (vercelMustMatch && supabaseDigest && current?.kind === 'unreadable') {
      add('vercel-vs-supabase', 'warn', `Vercel の ${CURRENT_NAME} と Supabase 側の一致は確かめられません (--vercel-must-match)`, 'Sensitive の変数は値を取り出せません');
    }

    if (previous) {
      if (previous.kind === 'unreadable') {
        add('vercel-previous', 'info', `Vercel に ${PREVIOUS_NAME} があります (値は取り出せません)`, '入れ替えが終わったら削除してください');
      } else if (!usable(previous)) {
        add('vercel-previous', 'info', `Vercel の ${PREVIOUS_NAME}: ${describeEntry(previous)}`, '空の値は無視されます');
      } else if (vercelCurrent && previous.digest === vercelCurrent) {
        add('vercel-previous', 'warn', `Vercel の ${PREVIOUS_NAME} が現行の値と同じです`, '入れ替えの意味がありません。旧い値を入れるか、削除してください');
      } else {
        add('vercel-previous', 'info', `Vercel に ${PREVIOUS_NAME} があります (入れ替えの途中)`, '入れ替えが終わったら削除してください');
      }
    }
  }

  return checks;
}

const LEVEL_LABEL = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', info: 'INFO', skip: 'SKIP', error: 'ERROR' };

/** 保管場所の一覧の 1 行 */
function storeLines(label, store, names) {
  if (store.state === 'skipped') return [`  ${label}: 確かめていない`];
  if (store.state === 'error') return [`  ${label}: 読めなかった`];
  return names.map((name) => `  ${label} ${name}: ${describeEntry(store.entries[name])}`);
}

/**
 * 結果の表示。出すのは名前・状態・ダイジェストの先頭だけで、値は出さない (そもそも値を受け取らない)。
 */
export function formatReport(checks, snapshot) {
  const lines = [
    `Cron の共有シークレットの照合 (#1196)。値は表示しません。SHA-256 のダイジェストの先頭 ${DIGEST_PREFIX_LENGTH} 文字だけを出します。`,
    '',
    '保管場所:',
    ...storeLines('Edge Function secrets', snapshot.edge, [CURRENT_NAME, ALIAS_NAME, PREVIOUS_NAME]),
    ...storeLines('Vault', snapshot.vault, [VAULT_SECRET_NAME]),
    ...storeLines('Vercel', snapshot.vercel, [CURRENT_NAME, PREVIOUS_NAME]),
    '',
    '判定:',
  ];
  for (const check of checks) {
    lines.push(`  [${LEVEL_LABEL[check.level]}] ${check.title}`);
    if (check.detail) lines.push(`         ${check.detail}`);
  }
  const count = (level) => checks.filter((check) => check.level === level).length;
  lines.push('');
  lines.push(
    `結果: FAIL ${count('fail')} 件 / WARN ${count('warn')} 件 / 読めなかった保管場所 ${count('error')} か所` +
      (count('fail') === 0 && count('error') === 0 ? ' — 値のずれは見つかりませんでした' : ''),
  );
  return lines.join('\n');
}

/** 判定の一覧から終了コードを決める (FAIL を優先) */
export function exitCodeOf(checks) {
  if (checks.some((check) => check.level === 'fail')) return 1;
  if (checks.some((check) => check.level === 'error')) return 2;
  return 0;
}

/**
 * @param {string[]} [argv]
 * @param {{ env?: Record<string, string | undefined>, log?: (line: string) => void, errorLog?: (line: string) => void,
 *           stores?: { edge: () => Promise<object>, vault: () => Promise<object>, vercel: () => Promise<object> },
 *           run?: typeof runCommand, fsApi?: object, tmpdir?: string }} [deps]
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line) => console.log(line));
  const errorLog = deps.errorLog ?? ((line) => console.error(line));
  let options;
  try {
    options = parseArgs(argv, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    errorLog(`check-cron-secret-drift: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    log(HELP);
    return 0;
  }

  const stores = deps.stores ?? createDefaultStores({ options, env, run: deps.run, fsApi: deps.fsApi, tmpdir: deps.tmpdir });
  const guard = async (read) => {
    try {
      return await read();
    } catch {
      // 例外の文に何が入っているか分からないので、出さない
      return failed('読み取りの途中で予期しないエラーが起きました');
    }
  };
  const [edge, vault, vercel] = await Promise.all([guard(stores.edge), guard(stores.vault), guard(stores.vercel)]);
  const snapshot = { edge, vault, vercel };
  const checks = evaluate(snapshot, options);
  log(formatReport(checks, snapshot));
  return exitCodeOf(checks);
}
