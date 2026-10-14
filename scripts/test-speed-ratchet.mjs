#!/usr/bin/env node
/**
 * scripts/test-speed-ratchet.mjs — 単体テストの 1 ファイルの時間の予算 (既定 5 秒) を超えたファイルを一覧にする (#1496)
 * (scripts/local-ci.sh の unit の段が、vitest のあとで呼ぶ。テストは tests/test-speed-ratchet.test.ts)
 *
 *   node scripts/test-speed-ratchet.mjs <結果の JSON> [--out <一覧の JSON>] [--root <リポジトリの根>]
 *
 * 結果の JSON は次のどちらでもよい:
 *   - scripts/vitest-file-timing-reporter.mjs が書くもの (format: vitest-file-timing/1)。
 *     ファイルの所要 = 収集 (import と describe の中身) + すべてのテストとフック (beforeAll など)。こちらを使う
 *   - vitest の JSON reporter (--reporter=json) のもの。ファイルの所要 = 最初のテストの開始から最後のテストの終わりまで
 *     (収集と、最初のテストの前の beforeAll を含まない。上の reporter の結果が無いときの代わり)
 *
 * ⚠ 赤にはしない (記録だけ)。所要は機械の負荷で大きく揺れ、予算を超えたことだけで落とすと偽の赤が出るため。
 * 結果の JSON が読めない・予算の環境変数が正の整数でないときだけ、終了コード 2 で終わる (呼ぶ側はそれでも段を赤にしない)。
 *
 * 時間切れを延ばしたファイル (#1488・#1501。tests/helpers/heavy-unit-test-timeout.ts の一覧と、tests/local-ci-slot*.test.ts など)
 * は、時間切れでは赤にならないので遅くなっても気づきにくい。一覧ではそれらに印を付け、予算の内外によらず所要を別に並べる。
 * 延ばしたかどうかは、ファイルの中身 (延ばす関数の呼び出し・vi.setConfig の testTimeout / hookTimeout) で見分ける
 * (手で直す一覧に頼らない。新しく延ばしたファイルも拾う)。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 1 ファイルの時間の予算の既定 (ms)。統合スイープ (#1496) が速度の債務とした線と同じ 5 秒。超えたものは速くするか、理由を残す */
export const DEFAULT_TEST_FILE_BUDGET_MS = 5_000;
/** 予算の上書きの環境変数 (正の整数のミリ秒。機械に合わせて変えるとき) */
export const TEST_FILE_BUDGET_ENV = 'UNIT_TEST_FILE_BUDGET_MS';
/** 一覧の JSON の形の版 */
export const SPEED_REPORT_FORMAT = 'test-speed-ratchet/1';
/** scripts/vitest-file-timing-reporter.mjs の出力の形の版 */
export const FILE_TIMING_FORMAT = 'vitest-file-timing/1';
/** 使い方の誤り・読めない入力の終了コード */
export const EXIT_USAGE = 2;
/** 文の一覧で、所要 (ms) の数字を右にそろえる桁数 (8 桁 = 1 ファイル 27 時間まで) */
const MS_COLUMN_WIDTH = 8;

/**
 * 時間切れを延ばしたファイルの印 (ファイルの中身にこれがあれば、延ばしたファイルとみなす)。
 *   - applyHeavyUnitTestTimeout / resolveHeavyUnitTimeouts: tests/helpers/heavy-unit-test-timeout.ts (#1488)
 *   - resolveUnitSlotTestTimeout: tests/helpers/local-ci-slot-test-timeout.ts (#1488)
 *   - vi.setConfig({ testTimeout / hookTimeout }): ファイルが自分で延ばしたもの
 */
export const EXTENDED_TIMEOUT_MARKERS = [
  /\b(?:applyHeavyUnitTestTimeout|resolveHeavyUnitTimeouts|resolveUnitSlotTestTimeout)\s*\(/,
  /\bvi\.setConfig\(\s*\{[^}]*\b(?:testTimeout|hookTimeout)\b/,
];

/** 予算 (ms) を環境変数から決める。無い・空白だけなら既定、正の整数でなければ投げる (黙って既定に戻さない) */
export function resolveTestFileBudgetMs(env = process.env) {
  const raw = env[TEST_FILE_BUDGET_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_TEST_FILE_BUDGET_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${TEST_FILE_BUDGET_ENV} は正の整数 (ミリ秒) にしてください: ${raw}`);
  }
  return value;
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** ファイルの名前を、リポジトリの根からの相対パス (区切りは /) にそろえる */
function relativeFile(file, root) {
  const rel = path.isAbsolute(file) ? path.relative(root, file) : file;
  return rel.split(path.sep).join('/');
}

/**
 * 結果の JSON から、ファイルごとの所要を読む。
 * @returns {{ source: 'file-timing' | 'vitest-json'; files: Array<{ file: string; state: string; ms: number; collectMs: number | null; testsAndHooksMs: number | null; overheadMs: number | null }> }}
 */
export function readFileDurations(report, root) {
  if (report && report.format === FILE_TIMING_FORMAT && Array.isArray(report.files)) {
    return {
      source: 'file-timing',
      files: report.files.map((f) => {
        const collectMs = finite(f.collectDuration);
        const testsAndHooksMs = finite(f.duration);
        return {
          file: relativeFile(String(f.file), root),
          state: String(f.state ?? 'unknown'),
          ms: collectMs + testsAndHooksMs,
          collectMs,
          testsAndHooksMs,
          // vitest の準備・環境 (jsdom など)・setupFiles の読み込み (ファイルの中身では変えられないので予算に数えない)
          overheadMs: finite(f.prepareDuration) + finite(f.environmentSetupDuration) + finite(f.setupDuration),
        };
      }),
    };
  }
  if (report && Array.isArray(report.testResults)) {
    return {
      source: 'vitest-json',
      files: report.testResults.map((r) => ({
        file: relativeFile(String(r.name), root),
        state: String(r.status ?? 'unknown'),
        ms: Math.max(0, finite(r.endTime) - finite(r.startTime)),
        collectMs: null,
        testsAndHooksMs: null,
        overheadMs: null,
      })),
    };
  }
  throw new Error(`結果の JSON の形が分からない (format: ${FILE_TIMING_FORMAT} か、vitest の --reporter=json の testResults が要る)`);
}

/** ファイルの中身から、時間切れを延ばしたファイルかを見分ける (読めないファイルは延ばしていないとみなす) */
export function hasExtendedTimeout(source) {
  return EXTENDED_TIMEOUT_MARKERS.some((re) => re.test(source));
}

/**
 * 一覧を作る。
 * @param {ReturnType<typeof readFileDurations>} durations
 * @param {{ budgetMs: number; readSource: (file: string) => string | undefined }} options
 */
export function buildSpeedReport(durations, { budgetMs, readSource }) {
  const files = durations.files.map((f) => {
    const source = readSource(f.file);
    return { ...f, ms: Math.round(f.ms), extendedTimeout: source !== undefined && hasExtendedTimeout(source) };
  });
  const byMsDesc = (a, b) => b.ms - a.ms || a.file.localeCompare(b.file);
  return {
    format: SPEED_REPORT_FORMAT,
    source: durations.source,
    budgetMs,
    totalFiles: files.length,
    overBudget: files.filter((f) => f.ms > budgetMs).sort(byMsDesc),
    extendedTimeout: files.filter((f) => f.extendedTimeout).sort(byMsDesc),
  };
}

/** 一覧を人が読む文にする (local-ci.sh のログに出す) */
export function formatSpeedReport(report) {
  const measure =
    report.source === 'file-timing'
      ? '収集 (import と describe の中身) + テストとフック'
      : '最初のテストの開始から最後のテストの終わりまで (収集と最初の beforeAll を含まない)';
  const line = (f) => {
    const parts = [`${String(f.ms).padStart(MS_COLUMN_WIDTH)} ms  ${f.file}`];
    if (f.extendedTimeout) parts.push('[時間切れを延ばしたファイル]');
    if (f.state !== 'passed' && f.state !== 'pass') parts.push(`[${f.state}]`);
    if (f.collectMs !== null && f.testsAndHooksMs !== null) {
      parts.push(`(収集 ${Math.round(f.collectMs)} ms + テストとフック ${Math.round(f.testsAndHooksMs)} ms)`);
    }
    return parts.join(' ');
  };
  const out = [
    `1 ファイルの時間の予算: ${report.budgetMs} ms (${TEST_FILE_BUDGET_ENV} で上書きできる。記録だけで、赤にはしない)`,
    `所要の測り方: ${measure}`,
    `予算を超えたファイル: ${report.overBudget.length} 本 (全 ${report.totalFiles} 本中)`,
    ...report.overBudget.map(line),
    `時間切れを延ばしたファイル: ${report.extendedTimeout.length} 本 (予算の内外によらず、所要の順)`,
    ...report.extendedTimeout.map(line),
  ];
  return `${out.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = { input: undefined, out: undefined, root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[(i += 1)];
    else if (a === '--root') args.root = argv[(i += 1)];
    else if (args.input === undefined) args.input = a;
    else throw new Error(`余分な引数: ${a}`);
  }
  if (!args.input) throw new Error('使い方: node scripts/test-speed-ratchet.mjs <結果の JSON> [--out <一覧の JSON>] [--root <リポジトリの根>]');
  if (args.out === undefined && argv.includes('--out')) throw new Error('--out の後に出力先が要る');
  if (args.root === undefined) throw new Error('--root の後にリポジトリの根が要る');
  return args;
}

/**
 * CLI の本体 (テストから直接呼ぶ)。終了コードを返す
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 * @param {{ stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } }} [io]
 * @returns {number}
 */
export function main(argv, env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  let args;
  let budgetMs;
  let report;
  try {
    args = parseArgs(argv);
    budgetMs = resolveTestFileBudgetMs(env);
    const root = path.resolve(args.root);
    const durations = readFileDurations(JSON.parse(readFileSync(args.input, 'utf8')), root);
    report = buildSpeedReport(durations, {
      budgetMs,
      readSource: (file) => {
        try {
          return readFileSync(path.join(root, file), 'utf8');
        } catch {
          return undefined;
        }
      },
    });
  } catch (error) {
    io.stderr.write(`[test-speed-ratchet] ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }
  if (args.out) {
    mkdirSync(path.dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  io.stdout.write(formatSpeedReport(report));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
