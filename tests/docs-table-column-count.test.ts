/**
 * #1125 docs/ の Markdown の表で、行のセルの数が見出しの行と同じ
 *
 * 記録の掃除 (docs-1017e) の design-doc.patch が、mobile/03-push-notification.md §3.8 の
 * 「APNs / FCM」の行 (列は 機能 | iOS | Android の 3 つ) を書き換えたとき、iOS のセルと Android のセルの間の `|` を落とした。
 * 行は 2 セルになり、Android の FCM V1 の記述が iOS の列に入って Android の列が空になる (読むと「iOS が FCM を登録する」に読める)。
 * 表の列の数は目では見落としやすいので、ここで機械で数える。
 *   1. docs/ の下の .md の表 (行頭が `|` の行が続くかたまり。コードのフェンスの中は見ない) で、どの行も見出しの行と同じ数の区切りを持つ
 *   2. 区切りの数は、エスケープした `\|` とコードの span (`…`) の中の `|` を数えない (書き手がセルの中身として書いた `|`)
 *   3. 既に食い違っていて、この案件の範囲の外のもの (KNOWN_MISMATCHES) は一覧と突き合わせる。一覧に無い食い違いも、
 *      直したのに一覧に残っているもの (一覧の行が見つからない) も赤
 *   4. 走査が空振りしていない (表の行を 1 件以上見つける・§3.8 の「APNs / FCM」の行を見つける)
 * 走査はファイルの一番外側 (収集のとき) で 1 回だけ行う。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
/** 走査する文書の根 (リポジトリの根からの相対) */
const DOCS_DIR = 'docs';
/** コードのフェンスの開き・閉じ (行頭の空白のあとに ``` か ~~~) */
const FENCE = /^\s*(```|~~~)/;
/** 1 行のうちコードの span (`…`)。中の `|` はセルの区切りでない */
const CODE_SPAN = /`[^`]*`/g;
/** エスケープした `|` */
const ESCAPED_PIPE = /\\\|/g;
/** 空振りの確認に使う行 (mobile/03-push-notification.md §3.8 の iOS / Android の表) */
const SENTINEL_FILE = 'docs/design/mobile/03-push-notification.md';
const SENTINEL_ROW_PREFIX = '| APNs / FCM |';

type Mismatch = { file: string; row: string; expected: number; actual: number };

/**
 * 既に食い違っている行 (この案件の範囲の外)。直したら一覧から消す。
 * family/09 の 01-trigger-flow.md: `{ entry_source: 'auto'|'settings_force' }` の `|` がコードの span の外にある。
 */
const KNOWN_MISMATCHES: ReadonlyArray<{ file: string; row: string }> = [
  {
    file: 'docs/design/family/09-onboarding-handson-tour/01-trigger-flow.md',
    row: "| status API success + should_show=true | `handson_tour_eligible` | { entry_source: 'auto'|'settings_force' } |",
  },
];

function separatorCount(line: string): number {
  const stripped = line.replace(CODE_SPAN, '').replace(ESCAPED_PIPE, '');
  return stripped.split('|').length - 1;
}

function tableMismatches(file: string, text: string): { rows: number; mismatches: Mismatch[] } {
  const mismatches: Mismatch[] = [];
  let rows = 0;
  let header: number | null = null;
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      header = null;
      continue;
    }
    if (inFence || !line.startsWith('|')) {
      header = null;
      continue;
    }
    rows += 1;
    const count = separatorCount(line);
    if (header === null) {
      header = count;
    } else if (count !== header) {
      mismatches.push({ file, row: line, expected: header, actual: count });
    }
  }
  return { rows, mismatches };
}

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listMarkdown(rel));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

const scanned = listMarkdown(DOCS_DIR).map((file) => {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return { file, text, ...tableMismatches(file, text) };
});
const allMismatches = scanned.flatMap((s) => s.mismatches);
const totalRows = scanned.reduce((sum, s) => sum + s.rows, 0);

describe('docs の Markdown の表の列の数 (#1125)', () => {
  it('区切りの数え方: エスケープとコードの span の中の | は数えない', () => {
    expect(separatorCount('| a | b |')).toBe(3);
    expect(separatorCount('| a \\| b | c |')).toBe(3);
    expect(separatorCount('| `a|b` | c |')).toBe(3);
    // §3.8 で起きた形: 3 列の表で 2 つ目と 3 つ目のセルの間の | が落ちる
    const { mismatches } = tableMismatches(
      'x.md',
      ['| 機能 | iOS | Android |', '|---|---|---|', '| APNs / FCM | iOS の文 Android の文 |'].join('\n'),
    );
    expect(mismatches).toEqual([
      { file: 'x.md', row: '| APNs / FCM | iOS の文 Android の文 |', expected: 4, actual: 3 },
    ]);
  });

  it('コードのフェンスの中と、空行で切れた別の表は、見出しを引き継がない', () => {
    const text = ['| a | b |', '|---|---|', '', '| a |', '|---|', '```', '| x | y | z |', '```'].join('\n');
    expect(tableMismatches('x.md', text).mismatches).toEqual([]);
  });

  it('走査が空振りしていない', () => {
    expect(totalRows).toBeGreaterThan(0);
    const sentinel = scanned.find((s) => s.file === SENTINEL_FILE);
    expect(sentinel).toBeDefined();
    expect(sentinel?.text.split('\n').some((l) => l.startsWith(SENTINEL_ROW_PREFIX))).toBe(true);
  });

  it('どの表の行も見出しの行と同じ数のセルを持つ (既知の食い違いは一覧と一致)', () => {
    const key = (m: { file: string; row: string }) => `${m.file} :: ${m.row}`;
    const known = new Set(KNOWN_MISMATCHES.map(key));
    const found = new Set(allMismatches.map(key));
    const unexpected = allMismatches.filter((m) => !known.has(key(m)));
    const stale = KNOWN_MISMATCHES.filter((m) => !found.has(key(m)));
    expect(unexpected).toEqual([]);
    expect(stale).toEqual([]);
  });
});
