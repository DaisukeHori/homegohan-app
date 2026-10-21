/**
 * 紹介ページの設計書 (docs/design/marketing/01-landing-site.md) の料金の記述を、#1911 (#1916) の後の今の姿にそろえる番兵
 *
 * #1911 で料金の区切りのカードは 1 枚 (`LANDING_COPY.pricing.plans`) になった。docs-1019b の設計書の追随で、
 * §13.1 の幅の表の ≥ 1024 の行と §8.3 の表は 1 枚に直したが、同じ表の 768〜1023 の行に「料金はカード 2 列」が残り、
 * §4.1 の主張 `free-now` の根拠の行の番号 (`PricingPageView.tsx:125`・`:68`) を §19 で直したのに、§20 の行が古い
 * `:45`・`:71` を指したまま残った (R1 の指摘)。読み手は、料金のカードの数と根拠の行を本書の中で食い違ったまま読む。
 *   1. §13.1 の幅の表の行で料金のカードを言うものは、すべて `LANDING_COPY.pricing.plans` の数の「カード N 枚」で言い、
 *      「カード 2 列」(2 枚のカードを横に並べる言い方) を書かない
 *   2. 本書が `PricingPageView.tsx` の行を指す 3 か所 (§4.1 の `free-now` の行・§19 の番兵の行・§20 の保持の行) は、
 *      同じ行の番号の組を指す (§4.1 を直したら §19・§20 も追随する)。製品の行のずれそのものは見ない
 *      (本書の §19・§20 の決まり: 行の番号のずれは記録の古さで、見つけた案件が同日の docs PR で直す)
 *   3. 1 と 2 の検査は、R1 の指摘の時点の文を違反として捕まえる (検査が空振りしていない)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANDING_COPY } from '@/components/marketing/landing-copy';

const ROOT = path.resolve(__dirname, '..');
const LANDING_DESIGN_PATH = 'docs/design/marketing/01-landing-site.md';

/** §13.1 ①全パターン表の、JS ありの幅の行の頭 (料金の並びを言う行) */
const WIDTH_ROW_HEAD = '| 未ログイン |';
/** 幅の行の中で料金の並びを言う部分の頭 */
const PRICING_PHRASE_HEAD = '料金はカード';
/** 2 枚のカードを横に並べる言い方 (#1911 の前の姿) */
const TWO_CARD_COLUMNS = '料金はカード 2 列';
/** 本書が PricingPageView の行を指す 3 か所の、行の頭の目印 */
const EVIDENCE_ROW_MARKERS = [
  { name: '§4.1 の free-now', head: '| `free-now` |' },
  { name: '§19 の番兵の行', head: '| `tests/public-claims-guard.test.ts` の `#1151 料金ページ (/pricing)`' },
  { name: '§20 の保持の行', head: '| `src/app/pricing/PricingPageView.tsx` (主張 `free-now` の根拠。' },
] as const;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
}

/** 幅の表の行のうち、料金のカードを言う行 */
function pricingWidthRows(doc: string): string[] {
  return doc.split('\n').filter((line) => line.startsWith(WIDTH_ROW_HEAD) && line.includes(PRICING_PHRASE_HEAD));
}

/** 料金のカードの言い方の違反 (カードの数がコードと違う・2 列の言い方) */
function pricingWidthViolations(doc: string, planCount: number): string[] {
  const expected = `${PRICING_PHRASE_HEAD} ${planCount} 枚`;
  return pricingWidthRows(doc).filter((row) => row.includes(TWO_CARD_COLUMNS) || !row.includes(expected));
}

/**
 * 表の行の中で PricingPageView を指す行の番号の組 (`PricingPageView.tsx:125`・`:68` や `§4.1 の `:125`・`:68`` の形)。
 * `PricingPageView` を含むセルのうち、行の番号を持つ最初のセルから、`PricingPageView.tsx:N` と `` `:N` `` を順に取る
 * (ほかのセルの別のファイルの行の番号を拾わない)。
 */
function pricingLineRefs(row: string): string[] {
  for (const cell of row.split('|')) {
    if (!cell.includes('PricingPageView')) continue;
    const refs = [...cell.matchAll(/PricingPageView\.tsx:(\d+)|`:(\d+)`/g)].map((m) => m[1] ?? m[2]);
    if (refs.length > 0) return refs;
  }
  return [];
}

function evidenceRefSets(doc: string): { name: string; refs: string[] }[] {
  const lines = doc.split('\n');
  return EVIDENCE_ROW_MARKERS.map(({ name, head }) => {
    const row = lines.find((line) => line.startsWith(head)) ?? '';
    return { name, refs: pricingLineRefs(row) };
  });
}

describe('marketing/01 の料金の記述 (#1911 の後)', () => {
  const doc = read(LANDING_DESIGN_PATH);
  const planCount = LANDING_COPY.pricing.plans.length;

  it('幅の表の料金は、すべての行で今のカードの数 (LANDING_COPY.pricing.plans の数) で言い、「カード 2 列」を書かない', () => {
    expect(pricingWidthRows(doc).length).toBeGreaterThan(0);
    expect(pricingWidthViolations(doc, planCount)).toEqual([]);
  });

  it('PricingPageView の行を指す 3 か所は同じ行の番号の組を指す', () => {
    const sets = evidenceRefSets(doc);
    for (const { name, refs } of sets) {
      expect(refs.length, `${name} の行が見つからないか、行の番号が無い`).toBeGreaterThan(0);
    }
    const [canon, ...followers] = sets;
    for (const { name, refs } of followers) {
      expect(refs, `${name} が §4.1 と違う行を指す`).toEqual(canon.refs);
    }
  });

  it('検査は R1 の指摘の時点の文を捕まえる (空振りしていない)', () => {
    const staleWidthRow = `${WIDTH_ROW_HEAD} 768〜1023 (タブレット) | ブラウザ (任意) | 任意 | あり | 標準 | 安心は 2 列。料金はカード 2 列・上限 3 列 |`;
    expect(pricingWidthViolations(staleWidthRow, planCount)).toEqual([staleWidthRow]);

    const staleDoc = [
      '| `free-now` | 登録して使える機能は、いまは無料 | `src/app/pricing/PricingPageView.tsx:125` の `現在は無料でご利用いただけます。`・`:68` (料金の FAQ の答え) |',
      '| `tests/public-claims-guard.test.ts` の `#1151 料金ページ (/pricing)` | – | §4.1 の `free-now` の根拠の `PricingPageView.tsx:125` (0 件のときの段落)・`:68` (料金の FAQ の答え) |',
      '| `src/app/pricing/PricingPageView.tsx` (主張 `free-now` の根拠。§4.1 の `:45`・`:71`) | **変えない** |',
    ].join('\n');
    const sets = evidenceRefSets(staleDoc);
    expect(sets.map((s) => s.refs)).toEqual([
      ['125', '68'],
      ['125', '68'],
      ['45', '71'],
    ]);
  });
});
