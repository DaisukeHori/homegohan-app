// src/__tests__/app/menus/weekly/poll-tick-watch-guard.test.ts
// Issue #1657 (#1622 の残り):
//   週間献立の画面 (page.tsx) のポーリングの tick は、fetch を待つ (await) 間に監視が終わって (Realtime の完了・失敗・中止・
//   次の監視の開始) も、戻ってから進捗を置いたり、古い週の献立を置いたり、次の監視のポーリングを止めたりしえた。
//   また、状態の確認 (GET /api/ai/menu/weekly/status) が status:'not_found' (本人の行が無い) を返しても、
//   completed とも failed とも扱わず、確認を続けていた。
//   → 監視 1 回分の印 ({ active }) を持ち、tick と Realtime の処理は await のたびに印を確かめ、下りていれば何も置かない。
//     次の監視の開始・中止・アンマウントで前の印を下ろす。not_found は失敗と同じく止める。
//     単品の再生成の Realtime は、週の生成の監視 (realtimeChannelRef・requestWatchRef) と別のチャンネルで持つ
//     (共用していたので、再生成の cleanupRealtime が、動いている週の生成の監視の印まで下ろしていた)。
//
// page.tsx は巨大なクライアントコンポーネントで、全体の描画での検証は現実的でないため、既存の配線テスト
// (request-watch-guard.test.ts・regenerate-improve-polling-guard.test.ts) と同じくソースを検査する。

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const PAGE_TSX_PATH = path.resolve(__dirname, '../../../../app/(main)/menus/weekly/page.tsx');
const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

/** コメントの行を除いたソース (経緯のコメントに当たらないように、コードの行だけを検査する) */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
    .join('\n');
}

const pageCode = stripCommentLines(pageSource);

/** marker のあとの最初の '{' から、対応する '}' までのコード (marker より後ろの from から探す) */
function blockAfter(code: string, marker: string, from = 0): string {
  const at = code.indexOf(marker, from);
  if (at < 0) throw new Error(`印が見つからない: ${marker}`);
  let depth = 0;
  let bodyStart = -1;
  for (let i = at + marker.length - 1; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') {
      if (depth === 0) bodyStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && bodyStart >= 0) return code.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`終わりが見つからない: ${marker}`);
}

/** within の中で、start から始まり、そのあとで最初に end が現れるところまで (end を含む) */
function sliceBetween(within: string, start: string, end: string): string {
  const from = within.indexOf(start);
  if (from < 0) throw new Error(`開始の印が見つからない: ${start}`);
  const to = within.indexOf(end, from);
  if (to < 0) throw new Error(`終わりの印が見つからない: ${end}`);
  return within.slice(from, to + end.length);
}

function codeLines(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 監視の印の確かめの行 */
function guardLine(watchName: string): string {
  return `if (!${watchName}.active) return;`;
}

/** 早い return だけの行 (if (...) return;) */
const EARLY_RETURN_LINE = /^if \(.+\) return;$/;
/** 終わりの処理を呼ぶ await (その先は呼ばれた側が印を確かめる) */
const TERMINAL_AWAIT = /await finish(Regenerate|Improve)\(/;

/**
 * block の中の await (終わりの処理の呼び出しを除く) のそれぞれについて、そのあと何かを置く前に印を確かめているか。
 * await の次の行から、早い return の行 (if (...) return;) を読み飛ばし、印の確かめの行に会えばよい。
 * 先に次の await に会ったときは、その await の検査に任せる (間に何も置いていない)。
 * 印を確かめずに、ほかの行 (状態を置く・片づける・分岐) に会ったら、その await の行を返す。
 */
function awaitsWithoutGuard(block: string, watchName: string): string[] {
  const lines = codeLines(block);
  const missing: string[] = [];
  lines.forEach((line, index) => {
    if (!line.includes('await ') || TERMINAL_AWAIT.test(line)) return;
    for (let next = index + 1; next < lines.length; next++) {
      const candidate = lines[next];
      if (candidate === guardLine(watchName)) return;
      if (candidate.includes('await ') && !TERMINAL_AWAIT.test(candidate)) return;
      if (EARLY_RETURN_LINE.test(candidate)) continue;
      missing.push(line);
      return;
    }
    missing.push(line);
  });
  return missing;
}

/** block の最初の文 ('{' の次の行) */
function firstStatement(block: string): string {
  return codeLines(block)[1] ?? '';
}

// --- 週の生成の監視 (subscribeToRequestStatus / startPolling) ---
const startPollingCode = blockAfter(pageCode, 'const startPolling = useCallback((targetDate: string, requestId: string, ultimateMode: boolean, watch: { active: boolean }) => {');
const pollCode = blockAfter(startPollingCode, 'const poll = async () => {');
const subscribeCode = blockAfter(pageCode, 'const subscribeToRequestStatus = useCallback(');
const realtimeHandlerCode = blockAfter(subscribeCode, 'async (payload) => {');

// --- V4 の生成 (handleV4Generate) ---
// 引数の型 ({ targetSlots ... }) の '{' を避けて、本体の '}) => {' から取る
const v4Code = blockAfter(pageCode, '}) => {', pageCode.indexOf('const handleV4Generate = async ('));
const v4TickCode = blockAfter(v4Code, 'v4PollingIntervalRef.current = setInterval(async () => {');
const v4RealtimeCode = blockAfter(v4Code, 'v4Generation.subscribeToProgress(v4RequestId, (progress) => {');

// --- 単品の再生成 (subscribeToRegenerateStatus) ---
const regenerateCode = blockAfter(pageCode, 'const subscribeToRegenerateStatus = useCallback(');
const finishRegenerateCode = blockAfter(regenerateCode, 'const finishRegenerate = async (');
const pollRegenerateCode = blockAfter(regenerateCode, 'const pollRegenerate = async () => {');

// --- 献立の改善 (handleImprove) ---
const improveCode = blockAfter(pageCode, 'const handleImprove = async () => {');
const finishImproveCode = blockAfter(improveCode, 'const finishImprove = async (');
const pollImproveCode = blockAfter(improveCode, 'const pollImprove = async () => {');
const improveRealtimeCode = blockAfter(improveCode, 'async (progress: any) => {');

// --- 買い物リストの再生成 (subscribeToShoppingListRequest) ---
const shoppingListCode = blockAfter(pageCode, 'const subscribeToShoppingListRequest = useCallback(');
const shoppingListPollCode = blockAfter(shoppingListCode, 'const poll = async () => {');
const shoppingListRealtimeCode = blockAfter(shoppingListCode, 'async (payload) => {');
const cleanupShoppingListCode = blockAfter(pageCode, 'const cleanupShoppingListSubscription = useCallback(');

const cancelCode = blockAfter(pageCode, 'const handleCancelGeneration = useCallback(');
// cleanupRealtime のすぐあとの useEffect が、アンマウント時の片づけ
const unmountCode = blockAfter(pageCode, 'useEffect(() => {', pageCode.indexOf('const cleanupRealtime = useCallback('));

/** ポーリングの tick・Realtime の処理と、その監視の印の名前 */
const WATCHED_BLOCKS: Array<{ name: string; block: string; watch: string }> = [
  { name: '週の生成のポーリング (startPolling の poll)', block: pollCode, watch: 'watch' },
  { name: '週の生成の Realtime (subscribeToRequestStatus)', block: realtimeHandlerCode, watch: 'watch' },
  { name: 'V4 の生成のポーリング', block: v4TickCode, watch: 'v4Watch' },
  { name: 'V4 の生成の Realtime', block: v4RealtimeCode, watch: 'v4Watch' },
  { name: '単品の再生成のポーリング (pollRegenerate)', block: pollRegenerateCode, watch: 'regenerateWatch' },
  { name: '単品の再生成の終わり (finishRegenerate)', block: finishRegenerateCode, watch: 'regenerateWatch' },
  { name: '献立の改善のポーリング (pollImprove)', block: pollImproveCode, watch: 'improveWatch' },
  { name: '献立の改善の終わり (finishImprove)', block: finishImproveCode, watch: 'improveWatch' },
  { name: '献立の改善の Realtime', block: improveRealtimeCode, watch: 'improveWatch' },
  { name: '買い物リストのポーリング', block: shoppingListPollCode, watch: 'shoppingListWatch' },
  { name: '買い物リストの Realtime', block: shoppingListRealtimeCode, watch: 'shoppingListWatch' },
];

describe('ポーリングの tick・Realtime の処理は、監視の印が下りていれば何も置かない (#1657)', () => {
  it.each(WATCHED_BLOCKS)('$name: 最初の文で印を確かめる', ({ block, watch }) => {
    expect(firstStatement(block)).toBe(guardLine(watch));
  });

  it.each(WATCHED_BLOCKS)('$name: await のあと、何かを置く前に印を確かめる', ({ block, watch }) => {
    expect(awaitsWithoutGuard(block, watch)).toEqual([]);
  });

  it('awaitsWithoutGuard は、確かめの行を消した tick を見つける (検査そのものの確かめ)', () => {
    const withoutGuard = pollCode.replace(
      /(const res = await fetch\(`\/api\/ai\/menu\/weekly\/status\?requestId=\$\{requestId\}`\);\n)\s*if \(!watch\.active\) return;\n/,
      '$1',
    );
    expect(withoutGuard).not.toBe(pollCode);
    expect(awaitsWithoutGuard(withoutGuard, 'watch')).toEqual([
      'const res = await fetch(`/api/ai/menu/weekly/status?requestId=${requestId}`);',
    ]);
  });

  it('週の生成の Realtime の完了: 献立の読み込みが例外で終わった経路でも、表示を片づける前に印を確かめる', () => {
    const afterCatch = sliceBetween(realtimeHandlerCode, "console.error('❌ Failed to fetch meal plan:', fetchErr);", 'setIsGenerating(false);');
    expect(afterCatch).toContain(guardLine('watch'));
  });

  it('単品の再生成の完了: 献立の読み込みが例外で終わった経路でも、表示を片づける前に印を確かめる', () => {
    const afterCatch = sliceBetween(finishRegenerateCode, "console.error('❌ Failed to fetch meal plan after regenerate:', e);", 'setIsRegenerating(false);');
    expect(afterCatch).toContain(guardLine('regenerateWatch'));
  });

  it('買い物リストの Realtime の完了: 一覧の読み込みが例外で終わった経路でも、表示を置く前に印を確かめる', () => {
    const afterCatch = sliceBetween(shoppingListRealtimeCode, "console.error('❌ Failed to fetch shopping list:', fetchErr);", 'setSuccessMessage(');
    expect(afterCatch).toContain(guardLine('shoppingListWatch'));
  });

  it('週の生成のポーリングは、subscribeToRequestStatus が立てた印を受け取る (3 か所の始め方のすべて)', () => {
    const calls = subscribeCode.match(/startPolling\([^)]*\);/g) ?? [];
    const START_POLLING_CALL_COUNT = 3; // 最初・Realtime の接続の失敗・5 秒後の確認
    expect(calls).toHaveLength(START_POLLING_CALL_COUNT);
    for (const call of calls) expect(call).toBe('startPolling(targetDate, requestId, ultimateMode, watch);');
    // startPolling を呼ぶのは subscribeToRequestStatus だけ (印を持たない呼び出しを作らない)
    const allCalls = pageCode.match(/startPolling\(targetDate/g) ?? [];
    expect(allCalls).toHaveLength(START_POLLING_CALL_COUNT);
  });
});

describe('次の監視の開始・中止・アンマウントで、前の監視の印を下ろす (#1657)', () => {
  it.each([
    { name: 'V4 の生成', block: v4Code, ref: 'v4PollWatchRef', watch: 'v4Watch' },
    { name: '単品の再生成', block: regenerateCode, ref: 'regenerateWatchRef', watch: 'regenerateWatch' },
    { name: '献立の改善', block: improveCode, ref: 'improveWatchRef', watch: 'improveWatch' },
  ])('$name: 新しい印を置く前に、前の印を下ろす', ({ block, ref, watch }) => {
    const lowerAt = block.indexOf(`if (${ref}.current) ${ref}.current.active = false;`);
    const createAt = block.indexOf(`const ${watch} = { active: true };`);
    const assignAt = block.indexOf(`${ref}.current = ${watch};`);
    expect(lowerAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(assignAt).toBeGreaterThan(lowerAt);
    expect(assignAt).toBeGreaterThan(createAt);
  });

  it('V4 の生成のポーリングの印は、ポーリングを始める前に立つ (最初の tick から印を見られる)', () => {
    expect(v4Code.indexOf('v4PollWatchRef.current = v4Watch;')).toBeLessThan(v4Code.indexOf('v4PollingIntervalRef.current = setInterval('));
  });

  it('買い物リスト: 片づけ (cleanupShoppingListSubscription) で印を下ろし、監視の開始で新しい印を立てる', () => {
    expect(cleanupShoppingListCode).toContain('shoppingListWatchRef.current.active = false;');
    expect(cleanupShoppingListCode).toContain('shoppingListWatchRef.current = null;');
    const cleanupAt = shoppingListCode.indexOf('cleanupShoppingListSubscription();');
    const assignAt = shoppingListCode.indexOf('shoppingListWatchRef.current = shoppingListWatch;');
    expect(cleanupAt).toBeGreaterThanOrEqual(0);
    expect(assignAt).toBeGreaterThan(cleanupAt);
  });

  it.each(['v4PollWatchRef', 'improveWatchRef'])('中止 (handleCancelGeneration) で %s の印を下ろす', (ref) => {
    expect(cancelCode).toContain(`${ref}.current.active = false;`);
    expect(cancelCode).toContain(`${ref}.current = null;`);
  });

  it.each(['v4PollWatchRef', 'regenerateWatchRef', 'improveWatchRef'])('アンマウントで %s の印を下ろす', (ref) => {
    expect(unmountCode).toContain(`${ref}.current.active = false;`);
    expect(unmountCode).toContain(`${ref}.current = null;`);
  });

  it('アンマウントで単品の再生成のチャンネルも外す', () => {
    expect(unmountCode).toContain('supabaseRef.current.removeChannel(regenerateChannelRef.current);');
  });
});

describe('単品の再生成の Realtime は、週の生成の監視と別のチャンネルで持つ (#1657)', () => {
  it('subscribeToRegenerateStatus は、週の生成の監視 (cleanupRealtime・realtimeChannelRef) に触らない', () => {
    expect(regenerateCode).not.toContain('cleanupRealtime(');
    expect(regenerateCode).not.toContain('realtimeChannelRef');
    expect(regenerateCode).toContain('regenerateChannelRef.current = channel;');
    expect(regenerateCode).toContain('cleanupRegenerateRealtime();');
  });

  it('cleanupRegenerateRealtime は再生成のチャンネルだけを外す (週の生成の監視の印を下ろさない)', () => {
    const cleanupCode = blockAfter(pageCode, 'const cleanupRegenerateRealtime = useCallback(');
    expect(cleanupCode).toContain('removeChannel(regenerateChannelRef.current)');
    expect(cleanupCode).not.toContain('requestWatchRef');
    expect(cleanupCode).not.toContain('realtimeChannelRef');
  });

  it('生成中の行の確認 (checkPendingRequests) は、再生成の監視があるときも始めない (共用していたときと同じ)', () => {
    expect(pageCode).toContain('if (realtimeChannelRef.current || regenerateChannelRef.current) return;');
  });
});

describe("status:'not_found' でポーリングを止める (#1657)", () => {
  it('週の生成のポーリング: not_found は失敗と同じ分岐で、ポーリング・Realtime を止め、生成中の表示を片づけて失敗を出す', () => {
    const branch = sliceBetween(pollCode, "} else if (data.status === 'failed' || data.status === 'not_found') {", "type: 'GEN_FAIL'");
    expect(branch).toContain('cleanupPolling();');
    expect(branch).toContain('cleanupRealtime();');
    expect(branch).toContain('setIsGenerating(false);');
    expect(branch).toContain('setGenerationProgress(null);');
    expect(branch).toContain('setGeneratingMeal(null);');
  });

  it('V4 の生成のポーリング: not_found は失敗と同じ分岐で、ポーリングを止めて失敗を出す', () => {
    const branch = sliceBetween(v4TickCode, "} else if (status === 'failed' || status === 'not_found') {", "type: 'GEN_FAIL'");
    expect(branch).toContain('v4ResolvedRef.current = true;');
    expect(branch).toContain('clearInterval(v4PollingIntervalRef.current!);');
  });

  it('単品の再生成のポーリング: not_found で失敗として終える', () => {
    const branch = blockAfter(pollRegenerateCode, "if (data.status === 'not_found') {");
    expect(codeLines(branch)).toEqual(['{', "await finishRegenerate('failed');", 'return;', '}']);
  });

  it('献立の改善のポーリング: not_found で失敗として終える', () => {
    const branch = blockAfter(pollImproveCode, "if (status === 'not_found') {");
    expect(codeLines(branch)).toEqual(['{', "await finishImprove('failed');", 'return;', '}']);
  });
});
