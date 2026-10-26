// @vitest-environment node
/**
 * 設計書 (docs/design) の表紙の版と、改定履歴の最後の版が食い違わないことの contract テスト (ソース走査)
 *
 * 表紙の表に `| 版 | vX.Y (日付) |` の行 (または表紙の引用に `> 版: vX.Y (日付)` の行) を持ち、
 * 改定履歴に `| vX.Y | 日付 | 内容 |` の行を持つ冊では、表紙の版 = 改定履歴のいちばん大きい版 でなければならない。
 * 改定履歴に行を足したのに表紙の版を上げ忘れると、正典が自分で食い違う (#1912 の 10/22 の記録の追随の R1 の指摘:
 * billing/03 の改定履歴に v1.13〜v1.18 を足す PATCH が、表紙を v1.12 のまま残していた)。
 * 逆に、表紙の版と表紙の改定履歴の文だけを上げて、本文の改定履歴の表に行を足し忘れても食い違う
 * (#2050 の R1 の指摘: family/11 の表紙を v1.13 に上げた PATCH が、§26 の表を v1.12 で止めていた)。
 *
 * 冒頭と本文の 2 か所に版の表を持つ冊 (冒頭の `| 版 | 日付 | 内容 |` の表と、本文の「改定履歴」の節の表) では、
 * 改定履歴の節の最後の版 = 冊の中の版の行のいちばん大きい版 でなければならない
 * (#2050 の R1 の指摘: cross/23 の冒頭の表に v1.1 を足した PATCH が、§22 改定履歴の表を v1.0 で止めていた)。
 *
 * 改定履歴を `vX.Y` の行で持たない冊 (表紙だけに版を書く冊・改定履歴の書き方が別の冊) は対象外。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const DESIGN_DIR = 'docs/design';

/** 表紙の版の行: 表の `| 版 | v1.12 (2026-10-22) |` か、引用の `> 版: v1.12 (2026-10-19) / Issue: …` */
const HEADER_VERSION_PATTERN = /^(?:\| 版 \| |> 版: )v(\d+)\.(\d+)\b/m;
/** 改定履歴の行: `| v1.12 | 2026-10-22 | … |` */
const HISTORY_VERSION_PATTERN = /^\| v(\d+)\.(\d+) \|/gm;

/** 本文の「改定履歴」の節の見出し (`## 26. 改定履歴` など。見出しの深さは 2 か 3) */
const HISTORY_SECTION_HEADING_PATTERN = /^(#{2,3}) [^\n]*改定履歴[^\n]*$/m;

/** 本冊の起こりになった冊。この冊が対象に入っていないなら走査の正規表現が壊れている */
const BILLING_PAID_PLANS_DOC = 'docs/design/billing/03-paid-plans-and-iap.md';
/** 表紙を引用 (`> 版:`) で書く冊。この冊が表紙の版の対象に入っていないなら引用の形の正規表現が壊れている */
const FAMILY_SELF_DISSOLVE_DOC = 'docs/design/family/11-self-dissolve.md';
/** 冒頭と本文の 2 か所に版の表を持つ冊。この冊が改定履歴の節の対象に入っていないなら節の走査が壊れている */
const PLANNED_MEALS_INTEGRITY_DOC = 'docs/design/cross/23-planned-meals-score-integrity.md';

type Version = readonly [major: number, minor: number];

const formatVersion = ([major, minor]: Version): string => `v${major}.${minor}`;
const compareVersion = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1];

const versionsOf = (markdown: string): Version[] =>
  [...markdown.matchAll(HISTORY_VERSION_PATTERN)].map(([, major, minor]) => [Number(major), Number(minor)] as const);
const latestOf = (versions: readonly Version[]): Version =>
  versions.reduce((max, v) => (compareVersion(v, max) > 0 ? v : max));

/** 表紙の版と、改定履歴のいちばん大きい版 (どちらかが無ければ null) */
function versionPair(markdown: string): { header: Version; latestHistory: Version } | null {
  const headerMatch = HEADER_VERSION_PATTERN.exec(markdown);
  if (!headerMatch) return null;
  const history = versionsOf(markdown);
  if (history.length === 0) return null;
  return { header: [Number(headerMatch[1]), Number(headerMatch[2])], latestHistory: latestOf(history) };
}

/** 本文の「改定履歴」の節の最後の版と、冊の中の版の行のいちばん大きい版 (節が無いか、節に版の行が無ければ null) */
function historySectionPair(markdown: string): { section: Version; latestInDoc: Version } | null {
  const heading = HISTORY_SECTION_HEADING_PATTERN.exec(markdown);
  if (!heading) return null;
  const bodyStart = heading.index + heading[0].length;
  const depth = heading[1].length;
  const nextHeading = new RegExp(`^#{2,${depth}} `, 'm').exec(markdown.slice(bodyStart));
  const body = nextHeading ? markdown.slice(bodyStart, bodyStart + nextHeading.index) : markdown.slice(bodyStart);
  const inSection = versionsOf(body);
  if (inSection.length === 0) return null;
  return { section: latestOf(inSection), latestInDoc: latestOf(versionsOf(markdown)) };
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

  it('表紙を引用 (> 版:) で書く冊でも、表紙だけを上げて改定履歴の表に行を足し忘れたら食い違い (#2050)', () => {
    const stale = [
      '> 版: v1.13 (2026-10-26) / Issue: #1917',
      '> 改定履歴: v1.0 2026-10-19 初版。v1.12 2026-10-19 網羅性。v1.13 2026-10-26 改定の反映。',
      '',
      '## 26. 改定履歴',
      '',
      '| 版 | 日付 | 内容 |',
      '|---|---|---|',
      '| v1.0 | 2026-10-19 | 初版 |',
      '| v1.12 | 2026-10-19 | 網羅性 |',
    ].join('\n');
    const pair = versionPair(stale);
    expect(pair && formatVersion(pair.header)).toBe('v1.13');
    expect(pair && formatVersion(pair.latestHistory)).toBe('v1.12');
    const aligned = `${stale}\n| v1.13 | 2026-10-26 | 改定の反映 |`;
    const alignedPair = versionPair(aligned);
    expect(alignedPair && formatVersion(alignedPair.latestHistory)).toBe('v1.13');
  });

  it('冒頭の版の表に行を足して、本文の改定履歴の節に足し忘れたら食い違い (#2050)', () => {
    const stale = [
      '| 版 | 日付 | 内容 |',
      '|---|---|---|',
      '| v1.0 | 2026-10-25 | 新設 |',
      '| v1.1 | 2026-10-26 | 着地の記録 |',
      '',
      '## 22. 改定履歴',
      '',
      '| 版 | 日付 | 内容 |',
      '|---|---|---|',
      '| v1.0 | 2026-10-25 | 新設 |',
    ].join('\n');
    const pair = historySectionPair(stale);
    expect(pair && formatVersion(pair.section)).toBe('v1.0');
    expect(pair && formatVersion(pair.latestInDoc)).toBe('v1.1');
    const alignedPair = historySectionPair(`${stale}\n| v1.1 | 2026-10-26 | 着地の記録 |`);
    expect(alignedPair && formatVersion(alignedPair.section)).toBe('v1.1');
    expect(alignedPair && formatVersion(alignedPair.latestInDoc)).toBe('v1.1');
  });

  it('改定履歴の節は次の同じ深さの見出しまで (後ろの節の版の行を節の版に数えない)', () => {
    const doc = [
      '## 22. 改定履歴',
      '',
      '| v1.0 | 2026-10-25 | 新設 |',
      '',
      '## 23. 付録',
      '',
      '| v2.0 | 付録の表の行 |',
    ].join('\n');
    const pair = historySectionPair(doc);
    expect(pair && formatVersion(pair.section)).toBe('v1.0');
    expect(pair && formatVersion(pair.latestInDoc)).toBe('v2.0');
  });

  it('改定履歴の節が無い冊・節に版の行が無い冊は対象外 (null)', () => {
    expect(historySectionPair(['| v1.0 | 2026-10-25 | 新設 |'].join('\n'))).toBeNull();
    expect(historySectionPair(['## 9. 改定履歴', '', '- 2026-10-25 新設'].join('\n'))).toBeNull();
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
    expect(checked, `${FAMILY_SELF_DISSOLVE_DOC} が走査の対象に入る (表紙が引用の形)`).toContain(FAMILY_SELF_DISSOLVE_DOC);
    expect(mismatches).toEqual([]);
  });

  it('本文に改定履歴の節を持つ冊はどれも、節の最後の版が冊の中の版の行のいちばん大きい版と同じ', () => {
    const checked: string[] = [];
    const mismatches: string[] = [];
    for (const rel of designDocs()) {
      const pair = historySectionPair(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
      if (!pair) continue;
      checked.push(rel);
      if (compareVersion(pair.section, pair.latestInDoc) !== 0) {
        mismatches.push(`${rel}: 改定履歴の節の最後 ${formatVersion(pair.section)} / 冊の中の最大 ${formatVersion(pair.latestInDoc)}`);
      }
    }
    expect(checked, `${PLANNED_MEALS_INTEGRITY_DOC} が走査の対象に入る`).toContain(PLANNED_MEALS_INTEGRITY_DOC);
    expect(checked, `${FAMILY_SELF_DISSOLVE_DOC} が走査の対象に入る`).toContain(FAMILY_SELF_DISSOLVE_DOC);
    expect(mismatches).toEqual([]);
  });
});
