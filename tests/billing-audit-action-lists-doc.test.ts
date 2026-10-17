/**
 * #1125 課金の監査の名前の一覧が 2 つあること (コード) と、operator/07 §4 の網羅リスト (文書) の突き合わせ
 *
 * 記録の掃除 (docs-1017e) の design-doc.patch が operator/07 §4.7 に「TS が書く課金の監査の名前の一覧は
 * `BILLING_AUDIT_ACTIONS`」と書いた。#1843 (手動のプランの付与のサーバ層) が、route (TS) から
 * `admin.billing.manual_grant` / `admin.billing.manual_revoke` を `MANUAL_GRANT_AUDIT_ACTIONS` で書くようにしたので、
 * その文は main で偽になった (R2 の指摘)。§4.7 の文は「核の 9 つは `BILLING_AUDIT_ACTIONS`・手動の付与の 3 つは
 * `MANUAL_GRANT_AUDIT_ACTIONS`」と 2 つの一覧に分けて書く。ここでは、その文が頼る事実を機械で数える:
 *   1. 2 つの一覧は重ならない (同じ名前が両方に入らない)
 *   2. どちらの一覧の名前も operator/07 §4 の網羅リスト (コードのフェンスの中の `名前  - 説明` の行) にある。
 *      逆に §4 の `*.billing.*` の名前は、どちらかの一覧にある (文書だけの課金の名前を作らない)
 *   3. 置き場所: 手動の付与の `admin.*` は §4.2、`system.*` は §4.5。核の `system.*` は §4.5、`user.*` は §4.7
 *   4. operator/07 が `BILLING_AUDIT_ACTIONS` の数を書いたら (「N つ」)、コードの数と同じ
 * 走査はファイルの一番外側 (収集のとき) で 1 回だけ行う。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BILLING_AUDIT_ACTIONS } from '@/lib/billing/core';
import { MANUAL_GRANT_AUDIT_ACTION_VALUES } from '@/lib/billing/manual-grant';

const DOC_FILE = path.resolve(__dirname, '..', 'docs/design/operator/07-audit-monitoring.md');
/** §4 の始まりと終わり (見出しの行頭) */
const SECTION_4_HEADING = '## 4.';
const SECTION_5_HEADING = '## 5.';
/** §4 の中の小見出し (`### 4.2 …` など) */
const SUBSECTION_HEADING = /^### (4\.\d+[a-z]?) /;
/** コードのフェンスの開き・閉じ */
const FENCE = /^\s*```/;
/** 網羅リストの 1 行: `名前` のあとに空白と `- 説明` */
const AUDIT_NAME_LINE = /^([a-z_]+(?:\.[a-z_]+)+)\s+-\s/;
/** 課金の名前 (網羅リストのうち、どちらかの一覧に入っているべきもの) */
const BILLING_NAME = /\.billing\./;
/** 文の中の `BILLING_AUDIT_ACTIONS` から、同じ文 (。まで) の最初の「N つ」 */
const BILLING_COUNT_CLAIM = /`BILLING_AUDIT_ACTIONS`[^。]*?(\d+) つ/g;

const doc = fs.readFileSync(DOC_FILE, 'utf8');

/** §4 の網羅リストの名前 → 置かれた小見出し (4.2 など) */
function auditNamesBySubsection(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let inSection = false;
  let inFence = false;
  let subsection = '';
  for (const line of text.split('\n')) {
    if (line.startsWith(SECTION_4_HEADING)) inSection = true;
    else if (line.startsWith(SECTION_5_HEADING)) inSection = false;
    if (!inSection) continue;
    const heading = SUBSECTION_HEADING.exec(line);
    if (heading) subsection = heading[1];
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    const m = inFence ? AUDIT_NAME_LINE.exec(line) : null;
    if (m) out.set(m[1], subsection);
  }
  return out;
}

const docNames = auditNamesBySubsection(doc);
const coreNames: readonly string[] = BILLING_AUDIT_ACTIONS;
const manualNames: readonly string[] = MANUAL_GRANT_AUDIT_ACTION_VALUES;

describe('課金の監査の 2 つの一覧と operator/07 §4 (#1125)', () => {
  it('走査が空振りしていない (§4 の網羅リストを読めている)', () => {
    expect(docNames.size).toBeGreaterThan(coreNames.length + manualNames.length);
  });

  it('核の一覧と手動の付与の一覧は重ならない', () => {
    expect(coreNames.filter((n) => manualNames.includes(n))).toEqual([]);
  });

  it('どちらの一覧の名前も §4 の網羅リストにあり、§4 の *.billing.* はどちらかの一覧にある', () => {
    const union = new Set([...coreNames, ...manualNames]);
    expect([...union].filter((n) => !docNames.has(n))).toEqual([]);
    expect([...docNames.keys()].filter((n) => BILLING_NAME.test(n) && !union.has(n))).toEqual([]);
  });

  it('置き場所: 手動の付与の admin.* は 4.2・system.* は 4.5、核の system.* は 4.5・user.* は 4.7', () => {
    const expectedSubsection = (name: string, manual: boolean): string => {
      if (name.startsWith('admin.')) return manual ? '4.2' : 'unexpected';
      if (name.startsWith('system.')) return '4.5';
      if (name.startsWith('user.')) return manual ? 'unexpected' : '4.7';
      return 'unexpected';
    };
    const placement = (names: readonly string[], manual: boolean) =>
      names.map((n) => ({ name: n, actual: docNames.get(n), expected: expectedSubsection(n, manual) }));
    const wrong = [...placement(coreNames, false), ...placement(manualNames, true)].filter(
      (p) => p.actual !== p.expected,
    );
    expect(wrong).toEqual([]);
  });

  it('operator/07 が書く BILLING_AUDIT_ACTIONS の数はコードと同じ', () => {
    const claims = [...doc.matchAll(BILLING_COUNT_CLAIM)].map((m) => Number(m[1]));
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.filter((n) => n !== coreNames.length)).toEqual([]);
  });
});
