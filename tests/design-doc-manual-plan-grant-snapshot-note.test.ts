// @vitest-environment node
/**
 * billing/02 §8.6 の正典コードの前の注記が、ブロックに入っている後の追随を言い落とさないことの contract テスト (ソース走査)
 *
 * #2086 (docs-1030a) で §8.6 のブロックの前に「下の全文は段 C (PR #1854) の時点の記録」と注記したが、
 * ブロックの先頭のコメントはすでに PR #2091 (#2086 V4) の 403 の理由の文の規則に追随していて、注記が事実と違っていた
 * (ブロックの中の `#2086 V4` の印が注記に無かった)。
 *
 * ここでは §8.6 の見出しとコードの柵の間の注記が「…の時点の記録」と宣言しているとき、
 * ブロックの中に書かれた Issue / PR の印 (`#<番号>`) がどれも注記にも出ていることを確かめる
 * (時点の記録のあとに取り込んだ追随を、注記が名指ししていること)。注記が無いときは印の突き合わせはしない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MANUAL_PLAN_GRANT = 'docs/design/billing/02-manual-plan-grant.md';
/** §8.6 の見出し (「### 8.6 `src/components/admin/ManualPlanGrantSection.tsx` (画面の節)」) */
const SECTION86_HEADING = /^### 8\.6 /;
/** 正典コードの柵の始まりと終わり */
const FENCE_OPEN = /^```tsx\s*$/;
const FENCE_CLOSE = /^```\s*$/;
/** 注記が「ある時点の記録」と宣言していることを示す語 */
const SNAPSHOT_DECLARATION = '時点の記録';
/** Issue / PR の印 (`#2086` など) */
const ISSUE_MARK = /#\d+/g;

function section86(): { note: string; block: string[] } {
  const lines = fs.readFileSync(path.join(ROOT, MANUAL_PLAN_GRANT), 'utf-8').split('\n');
  const headingIndex = lines.findIndex((line) => SECTION86_HEADING.test(line));
  expect(headingIndex, `${MANUAL_PLAN_GRANT} に §8.6 の見出しがある`).toBeGreaterThanOrEqual(0);
  const fenceOpen = lines.findIndex((line, index) => index > headingIndex && FENCE_OPEN.test(line));
  expect(fenceOpen, `${MANUAL_PLAN_GRANT} の §8.6 に tsx のブロックがある`).toBeGreaterThan(headingIndex);
  const fenceClose = lines.findIndex((line, index) => index > fenceOpen && FENCE_CLOSE.test(line));
  expect(fenceClose, `${MANUAL_PLAN_GRANT} の §8.6 の tsx のブロックが閉じている`).toBeGreaterThan(fenceOpen);
  return {
    note: lines.slice(headingIndex + 1, fenceOpen).join('\n'),
    block: lines.slice(fenceOpen + 1, fenceClose),
  };
}

describe('billing/02 §8.6 の注記とブロックの印', () => {
  it('§8.6 の tsx のブロックを取り出せる (ManualPlanGrantSection.tsx の置き場所の印がある)', () => {
    const { block } = section86();
    expect(block.some((line) => line.includes('tsc:skip place=src/components/admin/ManualPlanGrantSection.tsx'))).toBe(true);
  });

  it('注記が「…の時点の記録」と宣言するなら、ブロックの中の Issue / PR の印はどれも注記に出ている', () => {
    const { note, block } = section86();
    if (!note.includes(SNAPSHOT_DECLARATION)) return;
    const marksInBlock = [...new Set(block.flatMap((line) => line.match(ISSUE_MARK) ?? []))];
    const missingInNote = marksInBlock.filter((mark) => !note.includes(mark));
    expect(missingInNote, `§8.6 のブロックにあるのに注記が名指ししていない印 (注記: ${note.trim()})`).toEqual([]);
  });
});
