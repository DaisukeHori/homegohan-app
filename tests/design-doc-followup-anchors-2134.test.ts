// @vitest-environment node
/**
 * cross/16 がメンバー移譲の候補の API と画面を指す記述の contract テスト (ソース走査。#2134 docs-1031d の R1 指摘 1)
 *
 * cross/16 は、メンバー移譲の候補の API (`org/[id]/candidates/route.ts`・`family/[id]/candidates/route.ts`) と
 * 候補の画面 (`{orgs,families}/[id]/transfer/page.tsx`) が `user_profiles.last_login_at` を読む所を書く。
 * 記述が書く並べ替えの式・並びの名前・行番号・関数の名前が、今のコードに無ければ、記述は事実と違う。
 *
 * ここでは、
 *  1. org の候補の API を指す記述が書く並べ替え (`.order('last_login_at', …)` / `LIST_ORDERS.<名前>`) が、
 *     その route のコードにあること。記述が書く行番号は、どれも `last_login_at` を含む行を指すこと
 *  2. family の候補の API を指す記述が書く行番号 (`:N` / `:N〜M`) と `profileMap` が、その route のコードにあること
 *  3. 候補の画面を指す記述が書く `formatLastLogin(c.last_login_at)` が、org と family の両方の画面にあること
 * を確かめる。1. の確かめ方が食い違いを見つけることも、式で並べる route と名前で並べる route の見本で確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

const CROSS16 = 'docs/design/cross/16-auth-history-sessions.md';
const ORG_CANDIDATES_ROUTE = 'src/app/api/operator/membership/org/[id]/candidates/route.ts';
const FAMILY_CANDIDATES_ROUTE = 'src/app/api/operator/membership/family/[id]/candidates/route.ts';
const TRANSFER_PAGES = [
  'src/app/(operator)/operator/membership/orgs/[id]/transfer/page.tsx',
  'src/app/(operator)/operator/membership/families/[id]/transfer/page.tsx',
] as const;

/** 記述が route を指すときの名前 (cross/16 は `src/app/api/operator/membership/` を付けて、または付けずに書く) */
const ORG_ROUTE_MENTION = 'org/[id]/candidates/route.ts';
const FAMILY_ROUTE_MENTION = 'family/[id]/candidates/route.ts';
const TRANSFER_PAGE_MENTION = '[id]/transfer/page.tsx';

/** 候補の画面が最終ログインを出す式 */
const LAST_LOGIN_RENDER = 'formatLastLogin(c.last_login_at)';
/** route が読む列 */
const LAST_LOGIN_COLUMN = 'last_login_at';
/** org の route が今の式で並べるときの書き方 */
const ORDER_BY_LAST_LOGIN = ".order('last_login_at'";

/** 1 つの path の説明の終わり (次の path へ移る「)・」・次の文へ移る「 と、」・文の終わり「。」) */
const SEGMENT_ENDS = [')・', ' と、', '。'] as const;

/**
 * 記述の中で mention を指す所ごとに、その直後の記述 (次の区切り SEGMENT_ENDS のうち最も近いものまで。無ければ行の終わりまで)。
 * cross/16 は「`<path>` (<その path の説明>)・`<次の path>`」や「`<path>` と、それを出す …」の形で並べる。
 */
function segmentsAfter(doc: string, mention: string): string[] {
  return doc.split('\n').flatMap((line) => {
    const segments: string[] = [];
    let from = line.indexOf(mention);
    while (from !== -1) {
      const rest = line.slice(from + mention.length);
      const ends = SEGMENT_ENDS.map((separator) => rest.indexOf(separator)).filter((index) => index !== -1);
      segments.push(ends.length === 0 ? rest : rest.slice(0, Math.min(...ends)));
      from = line.indexOf(mention, from + mention.length);
    }
    return segments;
  });
}

/** `:N` と `:N〜M` / `:N-M` を、行番号の並び (範囲は始めと終わりの 2 つ) にする */
function anchorNumbers(text: string): number[] {
  return [...text.matchAll(/:(\d+)(?:[〜-](\d+))?/g)].flatMap(([, start, end]) =>
    end === undefined ? [Number(start)] : [Number(start), Number(end)],
  );
}

/** 行番号 (1 始まり) のうち、source のその行が needle を含まないもの */
function anchorsMissing(source: string, anchors: number[], needle: string): number[] {
  const lines = source.split('\n');
  return anchors.filter((lineNumber) => !(lines[lineNumber - 1] ?? '').includes(needle));
}

/** org の候補の route を指す記述のうち、route のコードと食い違うもの */
function orgCandidatesDrift(doc: string, routeSource: string): string[] {
  return segmentsAfter(doc, ORG_ROUTE_MENTION).flatMap((segment) => {
    const problems: string[] = [];
    if (/order\('last_login_at'/.test(segment) && !routeSource.includes(ORDER_BY_LAST_LOGIN)) {
      problems.push(`記述は ${ORDER_BY_LAST_LOGIN} で並べると書くが、route にその式が無い: ${segment}`);
    }
    for (const [, orderName] of segment.matchAll(/LIST_ORDERS\.(\w+)/g)) {
      if (!routeSource.includes(`LIST_ORDERS.${orderName}`)) {
        problems.push(`記述は LIST_ORDERS.${orderName} で並べると書くが、route にその名前が無い: ${segment}`);
      }
    }
    for (const lineNumber of anchorsMissing(routeSource, anchorNumbers(segment), LAST_LOGIN_COLUMN)) {
      problems.push(`記述の行番号 :${lineNumber} の行に ${LAST_LOGIN_COLUMN} が無い: ${segment}`);
    }
    return problems;
  });
}

describe('cross/16 がメンバー移譲の候補の API と画面を指す記述 (#2134 docs-1031d の R1 指摘 1)', () => {
  it('org の候補の API を指す記述が書く並べ替え・行番号は、route のコードにある', () => {
    const doc = read(CROSS16);
    expect(segmentsAfter(doc, ORG_ROUTE_MENTION).length, `${CROSS16} は org の候補の API を指す`).toBeGreaterThan(0);
    expect(orgCandidatesDrift(doc, read(ORG_CANDIDATES_ROUTE))).toEqual([]);
  });

  it('family の候補の API を指す記述が書く行番号と profileMap は、route のコードにある', () => {
    const doc = read(CROSS16);
    const routeSource = read(FAMILY_CANDIDATES_ROUTE);
    const segments = segmentsAfter(doc, FAMILY_ROUTE_MENTION);
    expect(segments.length, `${CROSS16} は family の候補の API を指す`).toBeGreaterThan(0);
    expect(segments.flatMap((segment) => anchorsMissing(routeSource, anchorNumbers(segment), LAST_LOGIN_COLUMN))).toEqual([]);
    const mentionsProfileMap = segments.some((segment) => segment.includes('profileMap'));
    expect(!mentionsProfileMap || routeSource.includes('profileMap'), 'profileMap を書くなら route にある').toBe(true);
  });

  it('候補の画面を指す記述が書く formatLastLogin(c.last_login_at) は、org と family の両方の画面にある', () => {
    const doc = read(CROSS16);
    const segments = segmentsAfter(doc, TRANSFER_PAGE_MENTION);
    expect(segments.some((segment) => segment.includes(LAST_LOGIN_RENDER)), `${CROSS16} は画面の式を名前で書く`).toBe(true);
    for (const page of TRANSFER_PAGES) {
      expect(read(page), `${page} は ${LAST_LOGIN_RENDER} で最終ログインを出す`).toContain(LAST_LOGIN_RENDER);
    }
  });

  it('確かめ方が空振りしない: 式で並べると書く記述は式の無い route と食い違い、名前で並べると書く記述は名前の無い route と食い違う', () => {
    const orderName = 'operatorOrgTransferCandidates';
    const expressionRoute = ["  .select('id, nickname, org_role, last_login_at')", `  ${ORDER_BY_LAST_LOGIN}, { ascending: false });`].join('\n');
    const namedRoute = [`orderListBy(LIST_ORDERS.${orderName}, admin.from('user_profiles')`, "  .select('id, nickname, org_role, last_login_at'))"].join('\n');
    const expressionDoc = `- \`${ORG_ROUTE_MENTION}\` (\`.order('last_login_at', { ascending: false, nullsFirst: false })\`)・\`${FAMILY_ROUTE_MENTION}\``;
    expect(orgCandidatesDrift(expressionDoc, expressionRoute), '式で並べると書く記述は、式で並べる route と食い違わない').toEqual([]);
    expect(orgCandidatesDrift(expressionDoc, namedRoute).length, '式で並べると書く記述は、式の無い route と食い違う').toBeGreaterThan(0);
    const namedDoc = `- \`${ORG_ROUTE_MENTION}\` (並びは \`LIST_ORDERS.${orderName}\`)・\`${FAMILY_ROUTE_MENTION}\``;
    expect(orgCandidatesDrift(namedDoc, namedRoute), '名前で並べると書く記述は、その名前の route と食い違わない').toEqual([]);
    expect(orgCandidatesDrift(namedDoc, expressionRoute).length, '名前で並べると書く記述は、その名前の無い route と食い違う').toBeGreaterThan(0);
    const firstLineWithoutColumn = namedRoute.split('\n').findIndex((line) => !line.includes(LAST_LOGIN_COLUMN)) + 1;
    const anchoredDoc = `- \`${ORG_ROUTE_MENTION}\` (:${firstLineWithoutColumn})・\`${FAMILY_ROUTE_MENTION}\``;
    expect(orgCandidatesDrift(anchoredDoc, namedRoute), '列の無い行を指す行番号は食い違う').toEqual([
      expect.stringContaining(`:${firstLineWithoutColumn} の行に ${LAST_LOGIN_COLUMN} が無い`),
    ]);
  });
});
