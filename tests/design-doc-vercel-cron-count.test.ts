/**
 * 設計書が「いま」の Vercel Cron の本数として書く数が、vercel.json の crons の数と同じ (#1797 ほかの 10/18 の記録の掃除)
 *
 * #1720 段 B (307ae1cf) が vercel.json に `/api/cron/login-alerts` を足して 6 本になったあとも、operator/10・operator/11・operator/12 の
 * 「Vercel Cron 5 本」の記述が残った (整合ゲートと取り込みの再レビューの指摘)。cron を足す・外すたびに、この数が実物から外れないようにする。
 *   1. WATCHED_COUNT_STATEMENTS の各行は、その文書にちょうど 1 回だけ現れ、書かれた数 (捕まえた数のすべて) が vercel.json の crons の数と同じ
 *   2. operator/10 §2.1 の Vercel Cron の行は、vercel.json の crons の名前 (path の最後) をすべて挙げる
 *   3. 走査が空振りしていない (vercel.json の crons が 1 本以上ある)
 * 調査時点の事実として書いた行 (「調査時点 8f8dc1d6」などと時点を明示した行) は、ここでは見ない。
 * operator/08 の §3.0・§3.2・§5 の記述は tests/log-cleanup-dau-snapshot-contract.test.ts が、ENV_SETUP.md の CRON_SECRET の行は
 * tests/env-setup-cron-secret-crons.test.ts が見張る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const ROOT = path.resolve(__dirname, '..');
const VERCEL_JSON_PATH = 'vercel.json';
/** §2.1 で Vercel Cron の名前を全部挙げる文書 */
const OPERATOR_10_PATH = 'docs/design/operator/10-logs-and-mail-retry.md';

const VercelJsonSchema = z.object({ crons: z.array(z.object({ path: z.string(), schedule: z.string() })) });

/** vercel.json に登録されている Vercel Cron の名前 (path の最後の部分。例: /api/cron/login-alerts → login-alerts) */
function vercelCronNames(): string[] {
  const { crons } = VercelJsonSchema.parse(JSON.parse(fs.readFileSync(path.join(ROOT, VERCEL_JSON_PATH), 'utf-8')));
  return crons.map((cron) => cron.path.split('/').pop() ?? cron.path);
}

/**
 * 「いま」の Vercel Cron の本数を書いた文。pattern の捕まえる組はどれも本数 (1 つの行に 2 つあるときは両方)。
 * 文書の側で文を書き換えたら、ここも同じ PR で直す (ちょうど 1 回だけ現れることを見るので、黙って外れはしない)
 */
const WATCHED_COUNT_STATEMENTS: ReadonlyArray<{ file: string; label: string; pattern: RegExp }> = [
  {
    file: OPERATOR_10_PATH,
    label: '§2.1 の Vercel Cron の行',
    pattern: /^ {2}- Vercel Cron: `vercel\.json` に .* の (\d+) 本。$/gm,
  },
  {
    file: 'docs/design/operator/11-ops-batches-non-billing.md',
    label: '§2.1 の cron の route の名前の行 (いまの数)',
    pattern: /いまは [^。]*?を足した (\d+) 本で、どれも 1 対 1/g,
  },
  {
    file: 'docs/design/operator/11-ops-batches-non-billing.md',
    label: '§4.1 の構造の図',
    pattern: /V\[Vercel Cron の route (\d+) 本\]/g,
  },
  {
    file: 'docs/design/operator/11-ops-batches-non-billing.md',
    label: '§4.2 の案 D の行',
    pattern: /既存の (\d+) 本 \([^)]*\) はどれも `internalError` で 500 を返し/g,
  },
  {
    file: 'docs/design/operator/11-ops-batches-non-billing.md',
    label: '§11.1 のテストの名前 (cron-failure-monitoring-contract の 9)',
    pattern: /vercel\.json の crons の (\d+) 本 \([^)]*\) のどれもこの走査に入る'\)`/g,
  },
  {
    file: 'docs/design/operator/12-cron-secret-drift-monitor.md',
    label: '§0.5 の Issue 本文との食い違いの行 (いまの数)',
    pattern: /いまの `vercel\.json` の `crons` は (\d+) 本/g,
  },
  {
    file: 'docs/design/operator/12-cron-secret-drift-monitor.md',
    label: '§8.2 の状態比較表の vercel.json の行 (現行 / 設計後)',
    pattern: /^\| `vercel\.json` \| (\d+) 本 \| (\d+) 本 \(変えない\) \|$/gm,
  },
  {
    file: 'docs/design/operator/12-cron-secret-drift-monitor.md',
    label: '§14 の番兵の追随表の cron-failure-monitoring-contract の行',
    pattern: /`vercel\.json` の crons の (\d+) 本 \(/g,
  },
  {
    file: 'tests/cron-failure-monitoring-contract.test.ts',
    label: '9 の it の名前',
    pattern: /vercel\.json の crons の (\d+) 本 \([^)]*\) のどれもこの走査に入る/g,
  },
];

const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf-8');

describe('設計書の「いま」の Vercel Cron の本数と vercel.json の crons', () => {
  it('vercel.json の crons の検査が空振りしていない', () => {
    expect(vercelCronNames().length).toBeGreaterThan(0);
  });

  it.each(WATCHED_COUNT_STATEMENTS.map((entry) => [`${entry.file} ${entry.label}`, entry] as const))(
    '%s: ちょうど 1 回現れ、書かれた本数が vercel.json の crons の数と同じ',
    (_name, entry) => {
      const expected = vercelCronNames().length;
      const matches = [...read(entry.file).matchAll(entry.pattern)];
      expect(matches, `${entry.file} の「${entry.label}」がちょうど 1 回現れる`).toHaveLength(1);
      const counts = matches[0].slice(1).map(Number);
      expect(counts.length, '本数を捕まえている').toBeGreaterThan(0);
      for (const count of counts) expect(count, `${entry.file} の「${entry.label}」の本数`).toBe(expected);
    },
  );

  it('operator/10 §2.1 の Vercel Cron の行は vercel.json の crons の名前をすべて挙げる', () => {
    const entry = WATCHED_COUNT_STATEMENTS.find((candidate) => candidate.file === OPERATOR_10_PATH);
    expect(entry, 'operator/10 §2.1 の行が WATCHED_COUNT_STATEMENTS にある').toBeDefined();
    const line = entry === undefined ? '' : ([...read(entry.file).matchAll(entry.pattern)][0]?.[0] ?? '');
    expect(line, 'operator/10 §2.1 の Vercel Cron の行が見つかる').not.toBe('');
    const missing = vercelCronNames().filter((name) => !line.includes(`\`${name}\``));
    expect(missing, 'operator/10 §2.1 の行に挙がっていない Vercel Cron').toEqual([]);
  });
});
