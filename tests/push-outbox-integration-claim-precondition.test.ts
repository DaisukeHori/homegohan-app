/**
 * #2245 K6 の番兵: 結合テスト tests/integration/rls/push-outbox.test.ts の claim の呼び出しが、表に残ったほかの行に依存しないこと。
 *
 * claim_push_outbox / claim_push_receipts は表の全体から古い順に取るので、テストが取った行を比べるには次のどれかが要る (#2235 I6・#2245 K6):
 *   (a) 上限を自分の行が必ず入る数にする (claimLimitCovering。戻りは自分の行に絞って比べる)
 *   (b) 上限を自分の行の数 (上限 1 など) にするなら、その前に自分の行が先頭にあることを確かめる (expectOwnRowsAtHead。
 *       claimRowsAtHead / claimReceiptsAtHead / claimReceiptsOldestFirst はこれを中で呼ぶ)
 * #2245 K6 の欠陥: createOutboxStore の検査の store.claimQueued(workerId, 1, …) → toEqual([row.id]) の前に (b) が無かった。
 * また、前回の実行が途中で止まって残った 2000 年の行を消さなかった (afterEach は今回 seed した行だけを消す) ので、
 * ファイルの先頭で前回の残りを消す beforeAll (purgeLeftoverRows) が、このファイルが積む全部の種類 (LEFTOVER_KINDS) を消すことも確かめる。
 * #2254 M4: weekly_menu_requests にも 2000 年の行 (attempt_limit_exceeded の検査の行) を積むので、その行が目印 (prompt) を持ち、
 * 前回の残りを消す beforeAll (purgeLeftoverMenuRequests) がこのファイルの全部の目印 (LEFTOVER_REQUEST_PROMPTS) を消すことと、
 * claim_menu_request (表の全体から最も古い取れる行を 1 件取る) の戻りの行を比べないことも確かめる。
 *
 * 結合テストの中身を実 DB で動かす検査ではない (それは結合テストそのもの)。ソースを読み、claim の呼び出しの形を数える。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const TARGET = path.join(__dirname, 'integration', 'rls', 'push-outbox.test.ts');

/** claim を直接呼ぶ形 (ラッパーの claimRows / claimReceipts・store の claimQueued / claimReceipts・RPC の名前) */
const RAW_CLAIM_CALL = /(?<![\w.])(?:claimRows|claimReceipts)\(|\.claim(?:Queued|Receipts)\(|rpc\('claim_push_(?:outbox|receipts)'/g;
/** 上の形を中で 1 回呼ぶだけのラッパー。上限を引数のまま渡すので、呼び出し側で確かめる */
const PASS_THROUGH_WRAPPERS = new Set(['claim', 'claimRows', 'claimReceipts']);
/** 呼び出しを囲む関数・テストの始まり (ファイルの書き方: トップレベルの async function と、describe の中の it) */
const SCOPE_START = /^\s*(?:async function (\w+)\b|it\()/;
/** 上限の引数が、自分の行が必ず入る数 (claimLimitCovering) */
const COVERING_LIMIT = /^await claimLimitCovering\(/;
/** 上限 1 などの claim の前に、自分の行が先頭にあることを確かめる呼び出し */
const HEAD_PRECONDITION = 'expectOwnRowsAtHead(';
/**
 * 前提を確かめずに claim してよい上限 (理由つき)。legacyLimit は #2235 I6 の回帰テストが、直す前の上限では自分の行が押し出されることを
 * わざと見せるための上限 (自分の行が全部は入らないことを確かめる。表にほかの行が多くても結論は変わらない)
 */
const ALLOWED_LIMITS = new Set(['legacyLimit']);

interface ClaimSite {
  line: number;
  text: string;
  limit: string | null;
  verdict: 'covering' | 'head-checked' | 'allowed' | 'pass-through' | 'permission' | 'violation';
}

/** 呼び出しの '(' の直後から、深さ 0 のカンマで引数を分ける。同じ行で閉じなければ null */
function splitArgs(text: string, openIndex: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = openIndex + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
      depth--;
    }
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  return null;
}

/** ソースの claim の呼び出しを全部拾い、上の (a) / (b) のどちらかを満たすかを判定する */
function classifyClaimSites(source: string): ClaimSite[] {
  const lines = source.split('\n');
  const sites: ClaimSite[] = [];
  lines.forEach((text, index) => {
    if (/^\s*async function /.test(text)) return; // ラッパーの定義の行
    for (const match of text.matchAll(RAW_CLAIM_CALL)) classifySite(lines, index, match, sites);
  });
  return sites;
}

/** 1 つの呼び出しを判定して sites に足す */
function classifySite(lines: string[], index: number, match: RegExpMatchArray, sites: ClaimSite[]): void {
  const text = lines[index];
  const line = index + 1;
  if (text.includes('expectPermissionDenied(')) {
    sites.push({ line, text, limit: null, verdict: 'permission' });
    return;
  }
  let scopeStart = index;
  let scopeName: string | null = null;
  for (let i = index; i >= 0; i--) {
    const scope = SCOPE_START.exec(lines[i]);
    if (scope) {
      scopeStart = i;
      scopeName = scope[1] ?? null;
      break;
    }
  }
  if (scopeName !== null && PASS_THROUGH_WRAPPERS.has(scopeName)) {
    sites.push({ line, text, limit: null, verdict: 'pass-through' });
    return;
  }
  const callIndex = match.index ?? 0;
  const args = splitArgs(text, callIndex + match[0].indexOf('('));
  const limit = args && args.length >= 2 ? args[1] : null;
  const before = [...lines.slice(scopeStart, index), text.slice(0, callIndex)].join('\n');
  let verdict: ClaimSite['verdict'] = 'violation';
  if (limit !== null && COVERING_LIMIT.test(limit)) verdict = 'covering';
  else if (limit !== null && /^\w+$/.test(limit) && new RegExp(`const ${limit} = await claimLimitCovering\\(`).test(before)) verdict = 'covering';
  else if (before.includes(HEAD_PRECONDITION)) verdict = 'head-checked';
  else if (limit !== null && ALLOWED_LIMITS.has(limit)) verdict = 'allowed';
  sites.push({ line, text, limit, verdict });
}

describe('#2245 K6 push-outbox の結合テストの claim は表に残ったほかの行に依存しない', () => {
  const source = readFileSync(TARGET, 'utf-8');
  const sites = classifyClaimSites(source);

  it('claim の呼び出しは、上限が自分の行を必ず含む数か、前に自分の行が先頭にあることを確かめている', () => {
    const violations = sites.filter((s) => s.verdict === 'violation').map((s) => `${s.line}: ${s.text.trim()}`);
    expect(violations).toEqual([]);
    // 空振りしていない: store の上限 1 の claim (#2245 K6 の欠陥の場所) を拾い、前提を確かめた形と判定している
    const storeClaims = sites.filter((s) => s.text.includes('store.claimQueued('));
    expect(storeClaims.map((s) => [s.limit, s.verdict])).toEqual([['1', 'head-checked']]);
    // 3 つの形 (まとめて取る・前提を確かめて取る・ラッパー) がどれも拾えている
    for (const verdict of ['covering', 'head-checked', 'pass-through'] as const) {
      expect(sites.some((s) => s.verdict === verdict), verdict).toBe(true);
    }
  });

  it('ファイルの先頭で、前回の実行の残りの行を消す (トップレベルの beforeAll が、このファイルの全部の種類で purgeLeftoverRows を呼ぶ)', () => {
    expect(source).toMatch(/^beforeAll\(async \(\) => \{\n\s*await purgeLeftoverRows\(LEFTOVER_KINDS\);\n\}/m);
    expect(source).toMatch(/^async function purgeLeftoverRows\(kinds: readonly string\[\] = \[TEST_KIND\]\): Promise<void> \{/m);
    // このファイルが enqueue に渡す種類の定数 (p_kind: 名前) は、どれも beforeAll が消す種類 (LEFTOVER_KINDS) に入っている
    // (2000 年にした行を、途中で止まった実行が残しても、次の実行の beforeAll が消す)
    const leftover = /^const LEFTOVER_KINDS: readonly string\[\] = \[([^\]]*)\];$/m.exec(source);
    expect(leftover).not.toBeNull();
    const listed = new Set((leftover?.[1] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0));
    const enqueuedKinds = [...new Set([...source.matchAll(/p_kind: ([A-Z_]+)\b/g)].map((m) => m[1]))];
    expect(enqueuedKinds.sort()).toEqual(['OTHER_TEST_KIND', 'TEST_KIND']);
    expect(enqueuedKinds.filter((k) => !listed.has(k))).toEqual([]);
  });

  it('weekly_menu_requests の 2000 年の行は目印を持ち、ファイルの先頭で前回の残りを消す。claim_menu_request の戻りの行は比べない (#2254 M4)', () => {
    expect(source).toMatch(/^beforeAll\(async \(\) => \{\n\s*await purgeLeftoverMenuRequests\(LEFTOVER_REQUEST_PROMPTS\);\n\}/m);
    expect(source).toMatch(/^async function purgeLeftoverMenuRequests\(prompts: readonly string\[\] = \[OLD_REQUEST_PROMPT\]\): Promise<void> \{/m);
    // weekly_menu_requests の行は insertRequest だけが積み、created_at を指定した (2000 年にした) 行には目印を入れる
    expect([...source.matchAll(/from\('weekly_menu_requests'\)\s*\.insert\(/g)]).toHaveLength(1);
    expect(source).toContain('...(seed.createdAt ? { created_at: seed.createdAt, prompt: OLD_REQUEST_PROMPT } : {}),');
    // このファイルが prompt に入れる目印 (prompt: 名前) は、どれも beforeAll が消す目印 (LEFTOVER_REQUEST_PROMPTS) に入っている
    const leftover = /^const LEFTOVER_REQUEST_PROMPTS: readonly string\[\] = \[([^\]]*)\];$/m.exec(source);
    expect(leftover).not.toBeNull();
    const listed = new Set((leftover?.[1] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0));
    const prompts = [...new Set([...source.matchAll(/prompt: ([A-Z_]+)\b/g)].map((m) => m[1]))];
    expect(prompts.sort()).toEqual(['OLD_REQUEST_PROMPT', 'OTHER_REQUEST_PROMPT']);
    expect(prompts.filter((p) => !listed.has(p))).toEqual([]);
    // claim_menu_request は表の全体から最も古い取れる行を取る (自分の行とは限らない) ので、戻りの行を受け取らず error だけを見る
    const menuClaims = source.split('\n').filter((l) => l.includes("rpc('claim_menu_request'"));
    expect(menuClaims).toHaveLength(1);
    expect(menuClaims[0]).toMatch(/^\s*const \{ error \} = await srAdmin\.rpc\('claim_menu_request', /);
  });

  it('判定器は、前提を確かめない上限 1 の claim と、自分の行の数だけの claim を違反として拾う', () => {
    const bad = [
      "  it('x', async () => {",
      '    const row = await seedQueued(userId, "x");',
      '    const claimed = await store.claimQueued(workerId, 1, LEASE_SECONDS);',
      '    const rows = await claimRows(workerId, ids.length);',
      "    const receipts = ((await claimReceipts('w', 1)).data ?? []) as OutboxRow[];",
      '  });',
    ].join('\n');
    expect(classifyClaimSites(bad).map((s) => s.verdict)).toEqual(['violation', 'violation', 'violation']);
    const good = [
      "  it('x', async () => {",
      "    await expectOwnRowsAtHead('queued', [row.id]);",
      '    const claimed = await store.claimQueued(workerId, 1, LEASE_SECONDS);',
      "    const limit = await claimLimitCovering('receipt', ids);",
      "    const fresh = ((await claimReceipts('w', limit)).data ?? []) as OutboxRow[];",
      "    const again = ((await claimReceipts('w', await claimLimitCovering('receipt', ids))).data ?? []) as OutboxRow[];",
      '  });',
    ].join('\n');
    expect(classifyClaimSites(good).map((s) => s.verdict)).toEqual(['head-checked', 'covering', 'covering']);
  });
});
