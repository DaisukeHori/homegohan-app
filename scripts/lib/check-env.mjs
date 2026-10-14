/**
 * 環境変数の検査の本体 (#1182)。CLI の入口は scripts/check-env.mjs (npm run check:env)。
 *
 * 検査の規則 (どの変数が必須で、どれが任意か。URL の形式) は src/lib/env.ts の zod スキーマと同じものを使う。
 * 古い check-env.sh は、一覧が手書きで、UPSTASH・STRIPE などを欠いたまま古くなっていた。
 * 単体テスト (tests/check-env-script.test.ts) からファイルと環境変数を差し替えて検証できるよう、
 * ファイルの読み込みと終了コードに触れる処理は main() に閉じ込めてある。
 *
 * 守っていること:
 *   - 環境変数の値は出力に含めない (変数名と、設定されているかどうかだけを出す)
 *   - .env ファイルは読むだけで、書き換えない
 *   - CI には組み込まない (CI にはシークレットが無く、必須の変数が揃わないため)。手元の .env.local や、
 *     別の環境の値を書いたファイルを確かめるときに使う
 *
 * src/lib/env.ts は TypeScript なので、Node.js の型の除去 (type stripping) で直接読み込む。
 * Node.js 22.18 以上では既定で有効。それより古いと読み込めないので、その旨を案内して終了する。
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/** --file を指定しないときに読むファイル。先に書いたものが優先される (Next.js と同じ順) */
export const DEFAULT_ENV_FILES = ['.env.local', '.env'];

export const USAGE = `環境変数の検査 (#1182)

使い方:
  npm run check:env
  npm run check:env -- --file=.env.production.local
  npm run check:env -- --strict

アプリが読む環境変数を、src/lib/env.ts の一覧 (zod のスキーマ) に照らして検査する。
  必須 ... 無いとアプリが動かない (Supabase の接続情報)。足りなければ終了コード 1
  任意 ... 無くても動くが、機能が縮退する (メール・レート制限・AI・課金など)。未設定は説明つきで表示するだけ

検査する値: 指定したファイル (既定: ${DEFAULT_ENV_FILES.join(' → ')}。先のファイルが優先) と、実行中の環境変数。
同じ名前は実行中の環境変数が優先される (Next.js と同じ)。別の環境の値を確かめるときは、
その値を書いたファイルを --file で指定する。
環境変数の値は出力しない (名前と、設定されているかどうかだけを出す)。

オプション:
  --file=<パス>  読み込むファイル。繰り返し指定できる。指定したファイルが無ければエラー
  --strict           任意の変数の「値の形式の誤り」と「組の片方だけの設定」も失敗にする
                     (任意の変数が未設定なだけでは失敗にならない)
  -h, --help         この説明を表示する

終了コード: 0 = 必須の変数がそろっている / 1 = 必須の変数が足りない・不正 (--strict ではさらに警告あり) / 2 = 引数の誤り・実行できない
`;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * コマンドライン引数を解釈する。不正なら UsageError。
 * ファイルの指定を --env-file にしないのは、Node.js 自身が `--env-file=` を (スクリプト名のあとでも) 横取りして
 * 読み込み、引数からも取り除いてしまうため (存在しないファイルを渡すと Node.js が exit 9 で止まる)。
 */
export function parseArgs(argv) {
  const args = { envFiles: [], strict: false, help: false };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '--strict') {
      args.strict = true;
    } else if (arg.startsWith('--file=')) {
      const file = arg.slice('--file='.length);
      if (!file) throw new UsageError('--file にはファイルのパスを指定してください');
      args.envFiles.push(file);
    } else {
      throw new UsageError(`不明な引数です: ${arg}`);
    }
  }
  return args;
}

/**
 * .env ファイルを読み、環境変数の集合を返す。実行中の環境変数 (env) が、同じ名前のファイルの値より優先される
 * (Next.js も、すでに設定されている環境変数を .env ファイルで上書きしない)。
 * 指定されたファイルが無ければ UsageError。既定のファイルは、無ければ読み飛ばす。
 *
 * @returns {{ source: Record<string, string | undefined>, loadedFiles: string[] }}
 */
export function collectEnvSource({ envFiles, env, cwd, existsSync = fs.existsSync, readFileSync = fs.readFileSync }) {
  const explicit = envFiles.length > 0;
  const files = explicit ? envFiles : DEFAULT_ENV_FILES;

  const source = {};
  const loadedFiles = [];
  for (const file of files) {
    const resolved = path.resolve(cwd, file);
    if (!existsSync(resolved)) {
      if (explicit) throw new UsageError(`--file のファイルが見つかりません: ${file}`);
      continue;
    }
    // 先に読んだファイルの値を、後のファイルで上書きしない (.env.local が .env より優先)
    for (const [key, value] of Object.entries(dotenv.parse(readFileSync(resolved)))) {
      if (!(key in source)) source[key] = value;
    }
    loadedFiles.push(file);
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') source[key] = value;
  }
  return { source, loadedFiles };
}

/** src/lib/env.ts を読み込む。TypeScript を直接読めない古い Node.js では、わかりやすい案内を添えて投げる */
export async function loadEnvModule() {
  try {
    return await import('../../src/lib/env.ts');
  } catch (error) {
    throw new Error(
      `src/lib/env.ts を読み込めませんでした (${error?.message ?? error})。` +
        `TypeScript を直接読むため Node.js 22.18 以上が必要です (現在: ${process.version})。` +
        '22.6 〜 22.17 では node --experimental-strip-types を付けて実行してください。',
    );
  }
}

const MARK = { ok: '[OK]', ng: '[NG]', unset: '[--]', warn: '[!!]' };

/**
 * 検査結果を表示用の行にする。値は含めない。
 *   [OK] 設定されている / [NG] 必須なのに足りない・不正 / [--] 任意で未設定 / [!!] 任意だが形式が不正・組が不完全
 *
 * @returns {string[]}
 */
export function formatReport(report, vars) {
  const findingsByName = new Map();
  for (const finding of [...report.errors, ...report.warnings]) {
    findingsByName.set(finding.name, [...(findingsByName.get(finding.name) ?? []), finding]);
  }

  const lineFor = (entry) => {
    const findings = findingsByName.get(entry.name) ?? [];
    if (findings.length === 0) return `  ${MARK.ok} ${entry.name}`;
    // 形式の誤り・組の片方だけの設定があれば、そちらを優先して示す (「未設定です」の説明は重ねない)
    const actionable = findings.filter((finding) => finding.kind !== 'missing');
    const shown = actionable.length > 0 ? actionable : findings;
    const mark = entry.required ? MARK.ng : actionable.length > 0 ? MARK.warn : MARK.unset;
    return `  ${mark} ${entry.name} - ${shown.map((finding) => finding.message).join(' / ')}`;
  };

  const lines = [];
  for (const [title, required] of [
    ['必須', true],
    ['任意', false],
  ]) {
    lines.push(title);
    for (const entry of vars.filter((candidate) => candidate.required === required)) {
      lines.push(lineFor(entry));
    }
    lines.push('');
  }

  const unsetOptional = report.warnings.filter((finding) => finding.kind === 'missing').length;
  const otherWarnings = report.warnings.length - unsetOptional;
  lines.push(
    `必須の不足・不正 ${report.errors.length} 件 / 任意の未設定 ${unsetOptional} 件 / 任意の警告 ${otherWarnings} 件` +
      ` (設定済み ${report.present.length} 件)`,
  );
  return lines;
}

/**
 * CLI の本体。終了コードを返す。
 *
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {{ log?: (line: string) => void, errorLog?: (line: string) => void, cwd?: string,
 *           existsSync?: typeof fs.existsSync, readFileSync?: typeof fs.readFileSync,
 *           loadEnv?: typeof loadEnvModule }} [options]
 */
export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  {
    log = console.log,
    errorLog = console.error,
    cwd = process.cwd(),
    existsSync = fs.existsSync,
    readFileSync = fs.readFileSync,
    loadEnv = loadEnvModule,
  } = {},
) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    errorLog(`check-env: ${error.message}`);
    errorLog('check-env: 使い方は --help を参照してください');
    return 2;
  }

  if (args.help) {
    log(USAGE);
    return 0;
  }

  let collected;
  try {
    collected = collectEnvSource({ envFiles: args.envFiles, env, cwd, existsSync, readFileSync });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    errorLog(`check-env: ${error.message}`);
    return 2;
  }

  let envModule;
  try {
    envModule = await loadEnv();
  } catch (error) {
    errorLog(`check-env: ${error.message}`);
    return 2;
  }

  const report = envModule.validateEnv(collected.source);

  log('環境変数の検査 (値は表示しません)');
  log(
    collected.loadedFiles.length > 0
      ? `読み込んだファイル: ${collected.loadedFiles.join(', ')} と、実行中の環境変数 (同じ名前は環境変数が優先)`
      : '読み込んだファイル: なし (実行中の環境変数だけを検査します)',
  );
  log('');
  for (const line of formatReport(report, envModule.ENV_VARS)) log(line);
  log('');

  if (!report.ok) {
    log(`結果: NG - 必須の環境変数に ${report.errors.length} 件の不足・不正があります。上の [NG] を直してください`);
    return 1;
  }
  const strictFailures = args.strict ? report.warnings.filter((finding) => finding.kind !== 'missing') : [];
  if (strictFailures.length > 0) {
    log(`結果: NG (--strict) - 任意の環境変数に ${strictFailures.length} 件の警告があります。上の [!!] を直してください`);
    return 1;
  }
  log('結果: OK - 必須の環境変数はそろっています');
  return 0;
}
