// @vitest-environment node
/**
 * 設計書 (docs/design) の表紙の版と、改定履歴の最後の版が食い違わないことの contract テスト (ソース走査)
 *
 * 表紙の表に `| 版 | vX.Y (日付) |` の行を持ち、改定履歴に `| vX.Y | 日付 | 内容 |` の行を持つ冊では、
 * 表紙の版 = 改定履歴のいちばん大きい版 でなければならない。
 * 改定履歴に行を足したのに表紙の版を上げ忘れると、正典が自分で食い違う (#1912 の 10/22 の記録の追随の R1 の指摘:
 * billing/03 の改定履歴に v1.13〜v1.18 を足す PATCH が、表紙を v1.12 のまま残していた)。
 *
 * 改定履歴を `vX.Y` の行で持たない冊 (表紙だけに版を書く冊・改定履歴の書き方が別の冊) は対象外。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const DESIGN_DIR = 'docs/design';

/** 表紙の表の版の行: `| 版 | v1.12 (2026-10-22) |` */
const HEADER_VERSION_PATTERN = /^\| 版 \| v(\d+)\.(\d+)\b/m;
/** 改定履歴の行: `| v1.12 | 2026-10-22 | … |` */
const HISTORY_VERSION_PATTERN = /^\| v(\d+)\.(\d+) \|/gm;

/** 本冊の起こりになった冊。この冊が対象に入っていないなら走査の正規表現が壊れている */
const BILLING_PAID_PLANS_DOC = 'docs/design/billing/03-paid-plans-and-iap.md';

type Version = readonly [major: number, minor: number];

const formatVersion = ([major, minor]: Version): string => `v${major}.${minor}`;
const compareVersion = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1];

/** 表紙の版と、改定履歴のいちばん大きい版 (どちらかが無ければ null) */
function versionPair(markdown: string): { header: Version; latestHistory: Version } | null {
  const headerMatch = HEADER_VERSION_PATTERN.exec(markdown);
  if (!headerMatch) return null;
  const history = [...markdown.matchAll(HISTORY_VERSION_PATTERN)].map(
    ([, major, minor]) => [Number(major), Number(minor)] as const,
  );
  if (history.length === 0) return null;
  const latestHistory = history.reduce((max, v) => (compareVersion(v, max) > 0 ? v : max));
  return { header: [Number(headerMatch[1]), Number(headerMatch[2])], latestHistory };
}

/** 設計書の markdown をすべて (docs/design の下を再帰で) */
function designDocs(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.md')) out.push(rel);
    }
  };
  walk(DESIGN_DIR);
  return out.sort();
}

describe('設計書の表紙の版 = 改定履歴の最後の版 (#1912)', () => {
  it('食い違いを見分ける (表紙 v1.12・改定履歴 v1.18 は食い違い、そろえれば一致)', () => {
    const stale = ['| 版 | v1.12 (2026-10-22) |', '', '| v1.12 | 2026-10-22 | a |', '| v1.18 | 2026-10-22 | b |'].join('\n');
    const pair = versionPair(stale);
    expect(pair && formatVersion(pair.header)).toBe('v1.12');
    expect(pair && formatVersion(pair.latestHistory)).toBe('v1.18');
    const aligned = stale.replace('| 版 | v1.12 ', '| 版 | v1.18 ');
    const alignedPair = versionPair(aligned);
    expect(alignedPair && formatVersion(alignedPair.header)).toBe('v1.18');
  });

  it('版は数で比べる (v1.9 < v1.10)', () => {
    const doc = ['| 版 | v1.10 (2026-10-21) |', '', '| v1.9 | 2026-10-20 | a |', '| v1.10 | 2026-10-21 | b |'].join('\n');
    const pair = versionPair(doc);
    expect(pair && formatVersion(pair.latestHistory)).toBe('v1.10');
  });

  it('表紙と改定履歴の両方に版を持つ冊はどれも、表紙の版が改定履歴の最後の版と同じ', () => {
    const checked: string[] = [];
    const mismatches: string[] = [];
    for (const rel of designDocs()) {
      const pair = versionPair(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
      if (!pair) continue;
      checked.push(rel);
      if (compareVersion(pair.header, pair.latestHistory) !== 0) {
        mismatches.push(`${rel}: 表紙 ${formatVersion(pair.header)} / 改定履歴の最後 ${formatVersion(pair.latestHistory)}`);
      }
    }
    expect(checked, `${BILLING_PAID_PLANS_DOC} が走査の対象に入る`).toContain(BILLING_PAID_PLANS_DOC);
    expect(mismatches).toEqual([]);
  });
});
