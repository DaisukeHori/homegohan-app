/**
 * #2206 G1: 受け手 (useAiConsultationReceiver を呼ぶ src のファイル) の構文木で数える。
 *   P1 置くのは place の中だけ / P2 書き込みは窓の中だけ / P3 Supabase の読み取りは error を受け取る (旧 6) /
 *   P4 捨てる入れ物に後から書かない (旧 8) / P5 旧 API を使わない / P6 受け手ごとの数の表
 * 検査の限界: P1 は字面の位置 (place の第 2 引数の関数の中か) を見る。条件の読み方は見ない。apply の中で ref を見て置かない分岐
 * (別の週・期間へ移ったあと) が正しいかは描画のテストが確かめる。P1 は「await のあと」をその関数の中の位置で見るので、await のあとに
 * 呼んだ関数の中の同期の setter は数えない (その関数の中に await があれば、その後ろは数える)。READ_PATH_BOUNDARIES の関数の中は見ない
 * (生成の監視。描画のテスト tests/ai-consultation-weekly-refetch-2195.test.tsx が確かめる)。P1 は読み取りの経路の外 (根から名前でたどれない
 * 関数) で GET の応答を直に置く呼び出しを見ない (経路に入れるのは配線。描画のテストの S-31・S-32 の it が確かめる)。P2 は beginWrite の変数がその関数の
 * finally 節か .finally(…) で呼ばれることまでを見て、窓が書き込みを囲むか (早い return の前に endWrite を呼んでいないか) は見ない。
 * .then でつないだ書き込みは数える (旧 7 と違う)。受け手の外のファイルの関数の中の送信は数えない (§9.1)
 *
 * 設計書の正本は docs/design/cross/26-ai-consultation-refetch-receivers.md (§6.10・§7.7・§9.1〜§9.3)。
 * 段 A〜E (受け手を旧の hook から新しい hook へ移す間) の決まり (§16 の段 A):
 *   - 受け手は「新しい hook を使うファイル」なので、段 A では 0 件 (P1〜P6 は見分けの空振りを防ぐ it が受け持つ)
 *   - P5 は移行済みの受け手 (= 受け手) だけを見る。src/hooks・src/lib/ai にも広げるのは段 F
 *   - READ_PATH_BOUNDARIES・READ_ONLY_SENDS・WRITE_WINDOW_EXEMPTIONS の「一覧の行が当てはまる関数・送信を持たないなら赤」は、
 *     移行済みの受け手に掛かる行だけを検査する (file を持つ行はそのファイルが受け手になってから。READ_ONLY_SENDS の行は、§9.1 で
 *     その行き先を持つ受け手 (READ_ONLY_SEND_OWNERS) が 1 つでも受け手になってから)。全行を検査するのは段 F
 *   - RECEIVER_EXPECTATIONS は段ごとの見出しの下に、その段の受け手の行を足す (並行する段の取り込みで同じ行を触らない)
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

applyHeavyUnitTestTimeout();

const ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = 'src';
const SOURCE_FILE = /\.(ts|tsx)$/;

const RECEIVER_HOOK_FILE = 'src/hooks/useAiConsultationReceiver.ts';
const RECEIVER_HOOK = 'useAiConsultationReceiver';
const READ_METHOD = 'read';
const BEGIN_WRITE_METHOD = 'beginWrite';
const PLACE_METHOD = 'place';
/**
 * 置く呼び出し: set で始まる識別子の呼び出し (タイマーを除く)・store の setter (<store>.getState().setX(…))・router の移動・reducer の dispatch。
 * ほかのメソッドの .setX(…) (Date の setDate / setHours・localStorage.setItem・supabase.auth.setSession) は数えない (今の番兵の規則 5 と同じ見分け)
 */
const PLACING_CALLEE = /^(set[A-Z]|dispatch[A-Z]|dispatch$)/;
/** store の今の状態を取る関数 (usePantryStore.getState().setFridgeItems の getState。この呼び出しの結果の .setX だけを置く呼び出しに数える) */
const STORE_STATE_ACCESS = 'getState';
/** store の setter の名前 (set で始まる。PLACING_CALLEE のうち store の .setX に当てる部分) */
const STORE_SETTER_NAME = /^set[A-Z]/;
const NON_PLACING_SET_FUNCTIONS: ReadonlySet<string> = new Set(['setTimeout', 'setInterval']);
/** router の移動を呼ぶ変数の名前 (useRouter() の戻り値。受け手は router と書く) */
const ROUTER_OBJECT = 'router';
const ROUTER_MOVES: ReadonlySet<string> = new Set(['replace', 'push']);
const PROMISE_CALLBACK_METHODS: ReadonlySet<string> = new Set(['then', 'catch', 'finally']);
/** 窓を閉じてよい Promise のメソッド (`.finally(endWrite)` / `.finally(() => { endWrite(); })`) */
const WINDOW_CLOSING_PROMISE_METHOD = 'finally';
/** 書き込み: method が GET でない fetch / aiFetch・Supabase の書き込み・rpc */
const SEND_FUNCTIONS: ReadonlySet<string> = new Set(['fetch', 'aiFetch']);
const SUPABASE_WRITE_METHODS: ReadonlySet<string> = new Set(['insert', 'update', 'upsert', 'delete']);
const SUPABASE_RPC_METHOD = 'rpc';
const HTTP_READ_METHOD = 'GET';
/** fetch などの options の、HTTP の method の項目 */
const HTTP_METHOD_OPTION = 'method';
/** Supabase の問い合わせを始めるメソッド (supabase.from(...)・supabase.rpc(...)) */
const SUPABASE_QUERY_METHODS: ReadonlySet<string> = new Set(['from', 'rpc']);
/** X.from(...) のうち Supabase の問い合わせでないもの (Array.from) の X */
const NON_SUPABASE_FROM_RECEIVERS: ReadonlySet<string> = new Set(['Array']);
/** Supabase の読み取りの結果のうち、読めた値の項目 (分割代入で受け取る名前) と、失敗の項目 (P3) */
const SUPABASE_RESULT_VALUE_FIELDS: ReadonlySet<string> = new Set(['data', 'count']);
const SUPABASE_RESULT_ERROR_FIELD = 'error';
/** 取り直しが捨てる入れ物を捨てるメソッドと、入れ物に書くメソッド (X.current.clear()・X.current.set / add。P4) */
const CONTAINER_DISCARD_METHOD = 'clear';
const CONTAINER_WRITE_METHODS: ReadonlySet<string> = new Set(['set', 'add']);
/** ref の今の値 (X.current) */
const REF_CURRENT = 'current';

/** P1 のたどりが入らない関数 (生成の監視の入口。§9.2 の B-1〜B-3)。一覧の関数がファイルに無い・たどりで届かないなら赤 */
const READ_PATH_BOUNDARIES: ReadonlyArray<{ file: string; fn: string; reason: string }> = [
  {
    file: 'src/app/(main)/menus/weekly/page.tsx',
    fn: 'checkPendingRequests',
    reason: '生成中の依頼を見つけて生成中の印・進み具合・監視を始める入口。データを置き換えない。番兵で止めると進み具合が出なくなる',
  },
  {
    file: 'src/app/(main)/menus/weekly/page.tsx',
    fn: 'resumePendingGeneration',
    reason: '生成中の印と段 (究極 / 通常) を立てる (#1609・#1629)。生成の監視の入口',
  },
  {
    file: 'src/app/(main)/menus/weekly/page.tsx',
    fn: 'subscribeToRequestStatus',
    reason: '生成の監視 (Realtime・ポーリング) の入口。完了の献立は reloadWeekAfterCompletion の読み取りが place で置く',
  },
];
/** P2 が書き込みに数えない送信の行き先 (どの受け手の読み取りが置く値も変えない。§9.2 の R-A〜R-D)。どの受け手にも無い行は赤 */
const READ_ONLY_SENDS: ReadonlyArray<{ url: string; reason: string }> = [
  { url: '/api/ai/hint', reason: 'AI の助言を読むだけ (route は DB に書かない)' },
  { url: '/api/ai/analyze-fridge', reason: '冷蔵庫の写真を AI が読むだけ (route は DB に書かない。保存は別の送信で窓の中)' },
  { url: '/api/ai/nutrition/feedback', reason: '書くのは自分の控え nutrition_feedback_cache だけで、受け手の読み取りはこの表を読まない' },
  { url: '/api/auth/session-sync', reason: '認証の cookie を同期するだけ' },
];
/** P2 の例外 (関数と行き先の組。§9.2 の E-1) */
const WRITE_WINDOW_EXEMPTIONS: ReadonlyArray<{ file: string; fn: string; url: string; reason: string }> = [
  {
    file: 'src/app/(main)/menus/weekly/page.tsx',
    fn: 'checkPendingRequests',
    url: '/api/ai/menu/weekly/cleanup',
    reason: '止まった生成の依頼の掃除 (#1494)。画面の値を変える書き込みでなく、取り直しと重なっても戻る表示が無い',
  },
];
/**
 * 段 A〜E だけで使う: READ_ONLY_SENDS の行き先を持つ受け手 (§9.1。R-A・R-C は献立表、R-B は /pantry と献立表、R-D は useHomeData.ts)。
 * READ_ONLY_SENDS の行の古さは、ここに書いた受け手が 1 つでも受け手 (新しい hook を使うファイル) になってから検査する。段 F で消し、全行を検査する
 */
const READ_ONLY_SEND_OWNERS: Readonly<Record<string, readonly string[]>> = {
  '/api/ai/hint': ['src/app/(main)/menus/weekly/page.tsx'],
  '/api/ai/analyze-fridge': ['src/app/(main)/pantry/page.tsx', 'src/app/(main)/menus/weekly/page.tsx'],
  '/api/ai/nutrition/feedback': ['src/app/(main)/menus/weekly/page.tsx'],
  '/api/auth/session-sync': ['src/hooks/useHomeData.ts'],
};
/** P5: 受け手と src/hooks・src/lib/ai に無い識別子 (段 F で有効。段 A〜E は移行済みの受け手だけ) */
const LEGACY_IDENTIFIERS: readonly string[] = [
  'useAiConsultationDataRefetch', 'useAiConsultationRefetchKey', 'useAiConsultationRefetchRun', 'useAiConsultationLoading',
  'useAiConsultationPendingWrites', 'useAiConsultationFetchStream', 'isLatest', 'deferIfHeld', 'beginFetch', 'refetchKey',
  'notifyWriteSettled', 'writeInFlightRef',
];
/**
 * P6: 受け手ごとの数の表 (§9.3 が正本。段ごとに自分の段の行を足す。段 A は空、段 F で 21 行)。
 * minPlaceCalls = §9 の鍵の欄の数 (置く鍵 + 読み込み中だけの鍵。place の呼び出しの下限)・writes = §9.1 のそのファイルの書き込みの数 (P2 が数えた数と等しい)。
 * 表に無い受け手のファイル・表にあって受け手でないファイルは赤。読み取りの経路の根は各ファイル 1 つ以上
 */
const RECEIVER_EXPECTATIONS: Readonly<Record<string, { readonly minPlaceCalls: number; readonly writes: number }>> = {
  // 段 B の例: 'src/app/(main)/pantry/page.tsx': { minPlaceCalls: 1, writes: 4 },

  // 段 B

  // 段 C

  // 段 D
  'src/hooks/useHomeData.ts': { minPlaceCalls: 18, writes: 5 },

  // 段 E
};

interface ReceiverSource {
  file: string;
  source: string;
}

/** 番兵の閉じた一覧 (見分けの空振りを防ぐ it が差し替える) */
interface GuardLists {
  boundaries: typeof READ_PATH_BOUNDARIES;
  readOnlySends: typeof READ_ONLY_SENDS;
  exemptions: typeof WRITE_WINDOW_EXEMPTIONS;
  readOnlySendOwners: typeof READ_ONLY_SEND_OWNERS;
}

const CANONICAL_LISTS: GuardLists = {
  boundaries: READ_PATH_BOUNDARIES,
  readOnlySends: READ_ONLY_SENDS,
  exemptions: WRITE_WINDOW_EXEMPTIONS,
  readOnlySendOwners: READ_ONLY_SEND_OWNERS,
};

/** 受け手のファイルごとに数えたもの (P6) */
interface ReceiverCounts {
  /** 読み取りの経路の根 (useAiConsultationReceiver の第 1 引数・<receiver>.read の第 2 引数) */
  roots: number;
  /** <x>.place(key, apply) の呼び出し */
  placeCalls: number;
  /** P2 が数えた書き込み (READ_ONLY_SENDS・WRITE_WINDOW_EXEMPTIONS に当たる送信を除く) */
  writes: number;
}

interface ReceiverGuardReport {
  /** P1〜P5 の違反 ('<ファイル>:<行>: …') */
  violations: string[];
  /** 一覧 (READ_PATH_BOUNDARIES・READ_ONLY_SENDS・WRITE_WINDOW_EXEMPTIONS) の古さの違反 (移行済みの受け手に掛かる行だけ) */
  listViolations: string[];
  /** 受け手のファイル → 数 */
  counts: Map<string, ReceiverCounts>;
  /** P3 が見た Supabase の読み取り ('<ファイル>:<行>') */
  supabaseReads: string[];
  /** P4 が見た、読み取りの経路が捨てる入れ物 ('<ファイル>:<名前>') */
  discardedContainers: string[];
}

type FunctionNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function calleeName(call: ts.CallExpression): string | null {
  return ts.isIdentifier(call.expression) ? call.expression.text : null;
}

function callsTo(root: ts.Node, names: readonly string[]): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  walk(root, (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== null && names.includes(name)) calls.push(node);
    }
  });
  return calls;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** 関数のノード (矢印関数・関数式・関数の宣言) か */
function isFunctionNode(node: ts.Node): node is FunctionNode {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
}

function asFunction(node: ts.Node | undefined): FunctionNode | null {
  if (node === undefined) return null;
  if (isFunctionNode(node)) return node;
  if (ts.isParenthesizedExpression(node)) return asFunction(node.expression);
  // useCallback(fn, deps) の fn
  if (ts.isCallExpression(node) && calleeName(node) === 'useCallback') return asFunction(node.arguments[0]);
  return null;
}

/** 名前の変数の宣言の初期値 (分割代入で受け取った名前は、分割代入の元の式) */
function declarationOf(sf: ts.SourceFile, name: string): { init: ts.Expression | undefined; destructured: boolean } | null {
  let result: { init: ts.Expression | undefined; destructured: boolean } | null = null;
  walk(sf, (node) => {
    if (result !== null) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      result = { init: node.initializer, destructured: false };
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const declaration = node.parent.parent;
      result = { init: ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined, destructured: true };
    }
  });
  return result;
}

/** 関数の式 (関数のリテラルか、関数を入れた名前 → その宣言の関数) */
function resolveFunction(sf: ts.SourceFile, expression: ts.Expression | undefined): FunctionNode | null {
  if (expression === undefined) return null;
  const direct = asFunction(expression);
  if (direct !== null) return direct;
  if (!ts.isIdentifier(expression)) return null;
  let declared: FunctionNode | null = null;
  walk(sf, (node) => {
    if (declared !== null) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === expression.text) declared = node;
  });
  if (declared !== null) return declared;
  const declaration = declarationOf(sf, expression.text);
  return declaration && !declaration.destructured ? asFunction(declaration.init) : null;
}

/** 名前で呼べる関数 (関数の宣言・関数を入れた const・useCallback(fn) を入れた const)。同じ名前が何個かあれば全部 */
function namedFunctions(sf: ts.SourceFile): Map<string, FunctionNode[]> {
  const named = new Map<string, FunctionNode[]>();
  const add = (name: string, fn: FunctionNode) => named.set(name, [...(named.get(name) ?? []), fn]);
  walk(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) add(node.name.text, node);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const fn = asFunction(node.initializer);
      if (fn !== null) add(node.name.text, fn);
    }
  });
  return named;
}

/** 関数の本体を、中の関数に入らずに歩く */
function walkOwnBody(fn: FunctionNode, visit: (node: ts.Node) => void) {
  const go = (node: ts.Node) => {
    if (node !== fn && isFunctionNode(node)) return;
    visit(node);
    node.forEachChild(go);
  };
  if (fn.body !== undefined) go(fn.body);
}

/** Promise の then / catch / finally に渡した関数か (中は応答が届いたあと) */
function isPromiseCallback(fn: FunctionNode): boolean {
  const call = fn.parent;
  return (
    call !== undefined &&
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    PROMISE_CALLBACK_METHODS.has(call.expression.name.text) &&
    call.arguments.some((argument) => argument === fn)
  );
}

/** 関数の中で、応答が届いたあと (then / catch / finally に渡した関数なら全部・それ以外は最初の await から) の位置 (無ければ -1) */
function settledFromOf(sf: ts.SourceFile, fn: FunctionNode): number {
  let settledFrom = isPromiseCallback(fn) ? fn.getStart(sf) : -1;
  walkOwnBody(fn, (node) => {
    if (settledFrom < 0 && ts.isAwaitExpression(node)) settledFrom = node.getStart(sf);
  });
  return settledFrom;
}

/** 関数の名前 (const の名前・関数の宣言の名前。無ければ「無名の関数」) */
function functionLabel(fn: FunctionNode): string {
  if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) return fn.name.text;
  for (let current: ts.Node | undefined = fn.parent; current !== undefined; current = current.parent) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (isFunctionNode(current) || ts.isSourceFile(current)) break;
  }
  return '無名の関数';
}

/** node を囲む関数 (内側から順に) */
function enclosingFunctions(node: ts.Node): FunctionNode[] {
  const out: FunctionNode[] = [];
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (isFunctionNode(current)) out.push(current);
  }
  return out;
}

/** fn が <x>.place(key, apply) の apply (第 2 引数) か */
function isPlaceApply(fn: FunctionNode): boolean {
  const call = fn.parent;
  return (
    call !== undefined &&
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === PLACE_METHOD &&
    call.arguments[1] === fn
  );
}

/** 置く呼び出しなら、その名前 (setX(…)・dispatchX(…)・<store>.getState().setX(…)・router.replace / push(…))。違えば null */
function placingCallName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    if (NON_PLACING_SET_FUNCTIONS.has(callee.text)) return null;
    return PLACING_CALLEE.test(callee.text) ? callee.text : null;
  }
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const { name, expression } = callee;
  if (ts.isIdentifier(expression) && expression.text === ROUTER_OBJECT && ROUTER_MOVES.has(name.text)) {
    return `${ROUTER_OBJECT}.${name.text}`;
  }
  if (
    STORE_SETTER_NAME.test(name.text) &&
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === STORE_STATE_ACCESS
  ) {
    return `${STORE_STATE_ACCESS}().${name.text}`;
  }
  return null;
}

/** 受け手の変数の名前 (const <名前> = useAiConsultationReceiver(…))。分割代入した受け手は違反に足す */
function receiverNames(file: string, sf: ts.SourceFile, violations: string[]): Set<string> {
  const names = new Set<string>();
  walk(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
    if (ts.isCallExpression(node.initializer) && calleeName(node.initializer) === RECEIVER_HOOK) {
      if (ts.isIdentifier(node.name)) names.add(node.name.text);
      else {
        violations.push(
          `${file}:${lineOf(sf, node)}: ${RECEIVER_HOOK} の戻り値を分割代入している (読み取りの経路をたどれない。const receiver = ${RECEIVER_HOOK}(…) と書き、receiver.${READ_METHOD}( / receiver.${BEGIN_WRITE_METHOD}( をそのまま呼ぶ)`,
        );
      }
    }
  });
  walk(sf, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      !ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isIdentifier(node.initializer) &&
      names.has(node.initializer.text)
    ) {
      violations.push(
        `${file}:${lineOf(sf, node)}: 受け手 (${node.initializer.text}) を分割代入している (読み取りの経路をたどれない。receiver.${READ_METHOD}( / receiver.${BEGIN_WRITE_METHOD}( をそのまま呼ぶ)`,
      );
    }
  });
  return names;
}

/** call が <受け手>.<method>(…) か */
function isReceiverMethodCall(call: ts.CallExpression, receivers: ReadonlySet<string>, method: string): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === method &&
    ts.isIdentifier(call.expression.expression) &&
    receivers.has(call.expression.expression.text)
  );
}

/** 読み取りの経路の根 (useAiConsultationReceiver の第 1 引数 / <receiver>.read の第 2 引数)。たどれない根は違反に足す */
function readPathRoots(file: string, sf: ts.SourceFile, receivers: ReadonlySet<string>, violations: string[]): FunctionNode[] {
  const roots: FunctionNode[] = [];
  const add = (call: ts.CallExpression, argument: ts.Expression | undefined, label: string) => {
    const fn = resolveFunction(sf, argument);
    if (fn === null) {
      violations.push(`${file}:${lineOf(sf, call)}: ${label} の読み取りの関数をたどれない (関数のリテラルか、同じファイルで宣言した関数の名前を渡す)`);
      return;
    }
    roots.push(fn);
  };
  for (const call of callsTo(sf, [RECEIVER_HOOK])) add(call, call.arguments[0], `${RECEIVER_HOOK} の第 1 引数`);
  walk(sf, (node) => {
    if (ts.isCallExpression(node) && isReceiverMethodCall(node, receivers, READ_METHOD)) {
      add(node, node.arguments[1], `${READ_METHOD} の第 2 引数`);
    }
  });
  return roots;
}

/**
 * 根から、名前で呼ぶ関数をたどった全部の関数 (たどった関数の中の関数も含む)。boundaryNames の関数には入らない (呼んだ名前は reachedBoundaries に足す)
 */
function readPathFunctions(
  sf: ts.SourceFile,
  roots: readonly FunctionNode[],
  boundaryNames: ReadonlySet<string>,
  reachedBoundaries: Set<string>,
): Set<FunctionNode> {
  const named = namedFunctions(sf);
  const reached = new Set<FunctionNode>();
  const queue: FunctionNode[] = [];
  const reach = (fn: FunctionNode) => {
    if (reached.has(fn)) return;
    reached.add(fn);
    queue.push(fn);
  };
  roots.forEach(reach);
  while (queue.length > 0) {
    const fn = queue.pop();
    if (fn?.body === undefined) continue;
    walk(fn.body, (node) => {
      if (isFunctionNode(node)) reach(node);
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (name === null) return;
        if (boundaryNames.has(name)) {
          reachedBoundaries.add(name);
          return;
        }
        (named.get(name) ?? []).forEach(reach);
      }
    });
  }
  return reached;
}

/**
 * P1: 読み取りの経路の関数の中で、応答が届いたあと (await のあと・then / catch / finally に渡した関数の中) に出てくる置く呼び出しが、
 * place の第 2 引数の関数の中に無いところ。中の関数 (place の apply を除く) の中の呼び出しも、その位置で見る
 */
function placementsOutsidePlace(file: string, sf: ts.SourceFile, pathFunctions: ReadonlySet<FunctionNode>): string[] {
  const seen = new Set<ts.CallExpression>();
  const violations: string[] = [];
  for (const fn of pathFunctions) {
    const settledFrom = settledFromOf(sf, fn);
    if (settledFrom < 0 || fn.body === undefined) continue;
    const go = (node: ts.Node) => {
      if (isFunctionNode(node) && isPlaceApply(node)) return;
      if (ts.isCallExpression(node) && node.getStart(sf) >= settledFrom && !seen.has(node)) {
        const name = placingCallName(node);
        if (name !== null) {
          seen.add(node);
          violations.push(
            `${file}:${lineOf(sf, node)}: 読み取りの経路の ${functionLabel(fn)} が、応答が届いたあとに ${name} を ${PLACE_METHOD} の外で呼ぶ (応答は <read>.${PLACE_METHOD}(key, apply) の apply の中で置く。順序・番兵・読み込み中の印は ${PLACE_METHOD} が見る)`,
          );
        }
      }
      node.forEachChild(go);
    };
    go(fn.body);
  }
  return violations;
}

/** 式の中に Supabase の問い合わせ (X.from(...)・X.rpc(...)) があるか。式の中の名前が問い合わせを入れた const なら、その初期値も見る */
function containsSupabaseQuery(sf: ts.SourceFile, expression: ts.Node, seen: Set<string> = new Set()): boolean {
  let found = false;
  walk(expression, (node) => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { name, expression: receiver } = node.expression;
      if (SUPABASE_QUERY_METHODS.has(name.text) && !(ts.isIdentifier(receiver) && NON_SUPABASE_FROM_RECEIVERS.has(receiver.text))) found = true;
    } else if (ts.isIdentifier(node) && !seen.has(node.text)) {
      seen.add(node.text);
      const declaration = declarationOf(sf, node.text);
      if (declaration && !declaration.destructured && declaration.init !== undefined && containsSupabaseQuery(sf, declaration.init, seen)) {
        found = true;
      }
    }
  });
  return found;
}

/** 分割代入の形の中のオブジェクトの形 ({ data, error } と、配列の形 [{ data }, …] の中のもの) */
function objectBindingPatternsOf(name: ts.BindingName): ts.ObjectBindingPattern[] {
  if (ts.isObjectBindingPattern(name)) return [name];
  if (ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap((element) => (ts.isBindingElement(element) ? objectBindingPatternsOf(element.name) : []));
  }
  return [];
}

/** 分割代入の要素の、元のオブジェクトの項目の名前 */
function bindingPropertyName(element: ts.BindingElement): string | null {
  const property = element.propertyName ?? element.name;
  return ts.isIdentifier(property) ? property.text : null;
}

/** node の中に、応答を置くところ (置く呼び出し・place) があるか */
function containsPlacement(node: ts.Node): boolean {
  let found = false;
  walk(node, (inner) => {
    if (found || !ts.isCallExpression(inner)) return;
    if (placingCallName(inner) !== null) found = true;
    else if (ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === PLACE_METHOD) found = true;
  });
  return found;
}

/** node の中で name (の識別子) を読むか */
function mentions(node: ts.Node, name: string): boolean {
  let found = false;
  walk(node, (inner) => {
    if (ts.isIdentifier(inner) && inner.text === name) found = true;
  });
  return found;
}

/**
 * name を読むところ (ref) が、name を条件で見る if で守られているか: if の条件の中か、条件が name を読み、応答を置くところを持つ
 * then の中 (読めなかったとき (null) は、その応答を置かない)。fn の外へは上がらない
 */
function guardedByNameCondition(ref: ts.Node, fn: FunctionNode, name: string): boolean {
  for (let child: ts.Node = ref, current = ref.parent; current !== undefined && child !== fn; child = current, current = current.parent) {
    if (!ts.isIfStatement(current)) continue;
    if (child === current.expression) return true;
    if (child === current.thenStatement && mentions(current.expression, name) && containsPlacement(current.thenStatement)) return true;
  }
  return false;
}

/** fn の中で name を読むところが全部 (分割代入そのものを除く)、name を条件で見る if で守られているか */
function readsOnlyUnderNameCondition(fn: FunctionNode, name: string, binding: ts.Node): boolean {
  let guarded = true;
  if (fn.body === undefined) return true;
  walk(fn.body, (node) => {
    if (!guarded || !ts.isIdentifier(node) || node.text !== name || node === binding) return;
    // obj.name・{ name: … } の name は、その変数を読むところではない
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;
    if ((ts.isPropertyAssignment(node.parent) || ts.isBindingElement(node.parent)) && node.parent.propertyName === node) return;
    if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
    if (!guardedByNameCondition(node, fn, name)) guarded = false;
  });
  return guarded;
}

/**
 * P3 (旧 6): 読み取りの経路の関数が Supabase の読み取りの結果を分割代入で受け取り、data / count を受け取るのに error を受け取らず、
 * 受け取った値を条件で守らずに読むところ。reads に、見た読み取り ('<ファイル>:<行>') を足す
 */
function supabaseReadsWithoutError(file: string, sf: ts.SourceFile, pathFunctions: ReadonlySet<FunctionNode>, reads: string[]): string[] {
  const violations: string[] = [];
  for (const fn of pathFunctions) {
    walkOwnBody(fn, (node) => {
      if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
      let initializer: ts.Expression = node.initializer;
      while (ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
      if (!ts.isAwaitExpression(initializer) || !containsSupabaseQuery(sf, initializer.expression)) return;
      for (const pattern of objectBindingPatternsOf(node.name)) {
        const values = pattern.elements.filter((element) => {
          const property = bindingPropertyName(element);
          return property !== null && SUPABASE_RESULT_VALUE_FIELDS.has(property) && ts.isIdentifier(element.name);
        });
        if (values.length === 0) continue;
        const line = lineOf(sf, pattern);
        reads.push(`${file}:${line}`);
        if (pattern.elements.some((element) => bindingPropertyName(element) === SUPABASE_RESULT_ERROR_FIELD)) continue;
        const unguarded = values
          .map((element) => element.name)
          .filter((name): name is ts.Identifier => ts.isIdentifier(name))
          .filter((name) => !readsOnlyUnderNameCondition(fn, name.text, name))
          .map((name) => name.text);
        if (unguarded.length > 0) {
          violations.push(
            `${file}:${line}: 読み取りの経路の ${functionLabel(fn)} が Supabase の読み取りの ${unguarded.join('・')} を受け取るのに ${SUPABASE_RESULT_ERROR_FIELD} を受け取らない (読み取りの失敗を「無い」と同じに扱い、取り直しで今の表示を空・0 で上書きする。${SUPABASE_RESULT_ERROR_FIELD} を受け取り、取り直しの失敗では置かない)`,
          );
        }
      }
    });
  }
  return violations;
}

/** call が X.current.<method>(...) なら X の名前 (そうでなければ null) */
function refContainerCall(call: ts.CallExpression, methods: ReadonlySet<string>): string | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !methods.has(callee.name.text)) return null;
  const current = callee.expression;
  if (!ts.isPropertyAccessExpression(current) || current.name.text !== REF_CURRENT || !ts.isIdentifier(current.expression)) return null;
  return current.expression.text;
}

/**
 * P4 (旧 8): 読み取りの経路の関数が X.current.clear() で捨てる入れ物に、応答が届いたあとで X.current.set / add で書くところ。
 * containers に、見た入れ物 ('<ファイル>:<名前>') を足す
 */
function writesAfterDiscard(file: string, sf: ts.SourceFile, pathFunctions: ReadonlySet<FunctionNode>, containers: string[]): string[] {
  const discarded = new Set<string>();
  const discardMethods: ReadonlySet<string> = new Set([CONTAINER_DISCARD_METHOD]);
  for (const fn of pathFunctions) {
    walkOwnBody(fn, (node) => {
      if (!ts.isCallExpression(node)) return;
      const name = refContainerCall(node, discardMethods);
      if (name !== null) discarded.add(name);
    });
  }
  containers.push(...[...discarded].map((name) => `${file}:${name}`));
  if (discarded.size === 0) return [];
  const violations: string[] = [];
  walk(sf, (node) => {
    if (!isFunctionNode(node)) return;
    const settledFrom = settledFromOf(sf, node);
    if (settledFrom < 0) return;
    walkOwnBody(node, (inner) => {
      if (!ts.isCallExpression(inner) || inner.getStart(sf) < settledFrom) return;
      const name = refContainerCall(inner, CONTAINER_WRITE_METHODS);
      if (name === null || !discarded.has(name)) return;
      violations.push(
        `${file}:${lineOf(sf, inner)}: 読み取りの経路が ${name}.${REF_CURRENT}.${CONTAINER_DISCARD_METHOD}() で捨てる入れ物に、${functionLabel(node)} が応答の届いたあとで書く (捨てる前に読み始めた応答が古い値を書き戻す。読み始める前に取った書き込み口で書く)`,
      );
    });
  });
  return violations;
}

/** 送信の行き先 (第 1 引数の文字列か、テンプレートの先頭の文字列)。読めなければ null */
function destinationOf(call: ts.CallExpression): string | null {
  const first = call.arguments[0];
  if (first === undefined) return null;
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
  if (ts.isTemplateExpression(first)) return first.head.text;
  return null;
}

/** fetch / aiFetch の options の method が GET でないリテラルか */
function hasNonReadMethod(call: ts.CallExpression): boolean {
  const options = call.arguments[1];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === HTTP_METHOD_OPTION &&
      ts.isStringLiteralLike(property.initializer) &&
      property.initializer.text.toUpperCase() !== HTTP_READ_METHOD,
  );
}

/** 書き込みの呼び出しなら、その見出し ('POST <行き先>'・'.upsert'・'.rpc')。違えば null */
function writeCallLabel(sf: ts.SourceFile, call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee) && SEND_FUNCTIONS.has(callee.text)) {
    return hasNonReadMethod(call) ? `${callee.text}(${destinationOf(call) ?? '…'})` : null;
  }
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (callee.name.text === SUPABASE_RPC_METHOD) return `.${SUPABASE_RPC_METHOD}`;
  if (SUPABASE_WRITE_METHODS.has(callee.name.text) && containsSupabaseQuery(sf, callee.expression)) return `.${callee.name.text}`;
  return null;
}

/** fn の本体 (中の関数に入らない) で const <v> = <受け手>.beginWrite() と宣言した名前 */
function beginWriteVariables(fn: FunctionNode, receivers: ReadonlySet<string>): ts.VariableDeclaration[] {
  const out: ts.VariableDeclaration[] = [];
  walkOwnBody(fn, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      isReceiverMethodCall(node.initializer, receivers, BEGIN_WRITE_METHOD)
    ) {
      out.push(node);
    }
  });
  return out;
}

/** call が <name>() か */
function isCallOf(node: ts.Node, name: string): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name && node.arguments.length === 0;
}

/** fn が <name> の窓を閉じるか: finally 節の中の <name>()、または .finally(<name>) / .finally(() => { <name>(); }) */
function closesWindow(fn: FunctionNode, name: string): boolean {
  let closed = false;
  walkOwnBody(fn, (node) => {
    if (closed) return;
    if (ts.isTryStatement(node) && node.finallyBlock !== undefined) {
      walk(node.finallyBlock, (inner) => {
        if (isCallOf(inner, name)) closed = true;
      });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === WINDOW_CLOSING_PROMISE_METHOD
    ) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isIdentifier(argument) && argument.text === name) closed = true;
      const callback = asFunction(argument);
      if (callback?.body !== undefined) {
        walk(callback.body, (inner) => {
          if (isCallOf(inner, name)) closed = true;
        });
      }
    }
  });
  return closed;
}

/** 書き込みを囲む窓があるか (その関数か囲む関数に beginWrite の変数があり、同じ関数で閉じる) */
function insideWriteWindow(call: ts.CallExpression, receivers: ReadonlySet<string>): boolean {
  return enclosingFunctions(call).some((fn) =>
    beginWriteVariables(fn, receivers).some((declaration) => ts.isIdentifier(declaration.name) && closesWindow(fn, declaration.name.text)),
  );
}

/**
 * P2: 受け手の全部の関数の書き込みは窓の中。READ_ONLY_SENDS の行き先・WRITE_WINDOW_EXEMPTIONS の (file, fn, url) は数えない。
 * beginWrite の変数をその関数で閉じない窓も違反。数えた書き込みの数を返す
 */
function writesOutsideWindow(
  file: string,
  sf: ts.SourceFile,
  receivers: ReadonlySet<string>,
  lists: GuardLists,
  violations: string[],
  readOnlyMatches: Set<string>,
  exemptionMatches: Set<string>,
): number {
  let writes = 0;
  walk(sf, (node) => {
    if (!isFunctionNode(node)) return;
    for (const declaration of beginWriteVariables(node, receivers)) {
      if (!ts.isIdentifier(declaration.name) || closesWindow(node, declaration.name.text)) continue;
      violations.push(
        `${file}:${lineOf(sf, declaration)}: ${functionLabel(node)} が ${BEGIN_WRITE_METHOD} の ${declaration.name.text} を同じ関数の finally 節 (または .${WINDOW_CLOSING_PROMISE_METHOD}(…)) で呼ばない (書き込みの窓が閉じない)`,
      );
    }
  });
  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const label = writeCallLabel(sf, node);
    if (label === null) return;
    const destination = destinationOf(node);
    if (destination !== null) {
      const readOnly = lists.readOnlySends.find((send) => destination.startsWith(send.url));
      if (readOnly !== undefined) {
        readOnlyMatches.add(readOnly.url);
        return;
      }
      const owners = new Set(enclosingFunctions(node).map(functionLabel));
      const exemption = lists.exemptions.find(
        (row) => row.file === file && owners.has(row.fn) && destination.startsWith(row.url),
      );
      if (exemption !== undefined) {
        exemptionMatches.add(`${exemption.file}#${exemption.fn}#${exemption.url}`);
        return;
      }
    }
    writes += 1;
    if (insideWriteWindow(node, receivers)) return;
    const fn = enclosingFunctions(node)[0];
    violations.push(
      `${file}:${lineOf(sf, node)}: ${fn === undefined ? 'ファイルの直下' : functionLabel(fn)} の書き込み ${label} が ${BEGIN_WRITE_METHOD} の窓の外 (const endWrite = receiver.${BEGIN_WRITE_METHOD}(); … finally { endWrite(); } で囲む)`,
    );
  });
  return writes;
}

/** P5: 旧 API の識別子 */
function legacyIdentifiers(file: string, sf: ts.SourceFile): string[] {
  const violations: string[] = [];
  const legacy = new Set(LEGACY_IDENTIFIERS);
  walk(sf, (node) => {
    if (ts.isIdentifier(node) && legacy.has(node.text)) {
      violations.push(`${file}:${lineOf(sf, node)}: 旧 API の ${node.text} が残っている (${RECEIVER_HOOK} の read / place / beginWrite / isLoading に移す)`);
    }
  });
  return violations;
}

/** place の呼び出し (<x>.place(key, apply)) の数 */
function placeCallCount(sf: ts.SourceFile): number {
  let count = 0;
  walk(sf, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === PLACE_METHOD &&
      node.arguments.length >= 2
    ) {
      count += 1;
    }
  });
  return count;
}

/** src の中の受け手か (useAiConsultationReceiver を呼ぶファイル。hook のファイル自身は除く) */
function isReceiverSource({ file, source }: ReceiverSource): boolean {
  return file !== RECEIVER_HOOK_FILE && source.includes(`${RECEIVER_HOOK}(`);
}

/** 受け手のソースを数える (sources は検査する受け手のファイル。受け手でないファイルは見ない) */
function checkReceivers(sources: readonly ReceiverSource[], lists: GuardLists = CANONICAL_LISTS): ReceiverGuardReport {
  const violations: string[] = [];
  const listViolations: string[] = [];
  const counts = new Map<string, ReceiverCounts>();
  const supabaseReads: string[] = [];
  const discardedContainers: string[] = [];
  const readOnlyMatches = new Set<string>();
  const exemptionMatches = new Set<string>();
  const receiverFiles = new Set<string>();
  const boundaryHits = new Map<string, Set<string>>();
  const fileFunctions = new Map<string, Map<string, FunctionNode[]>>();

  for (const entry of sources) {
    if (!isReceiverSource(entry)) continue;
    const { file, source } = entry;
    receiverFiles.add(file);
    const sf = parse(file, source);
    fileFunctions.set(file, namedFunctions(sf));
    const receivers = receiverNames(file, sf, violations);
    const roots = readPathRoots(file, sf, receivers, violations);
    const boundaryNames = new Set(lists.boundaries.filter((row) => row.file === file).map((row) => row.fn));
    const reachedBoundaries = new Set<string>();
    boundaryHits.set(file, reachedBoundaries);
    const pathFunctions = readPathFunctions(sf, roots, boundaryNames, reachedBoundaries);
    violations.push(...placementsOutsidePlace(file, sf, pathFunctions));
    violations.push(...supabaseReadsWithoutError(file, sf, pathFunctions, supabaseReads));
    violations.push(...writesAfterDiscard(file, sf, pathFunctions, discardedContainers));
    const writes = writesOutsideWindow(file, sf, receivers, lists, violations, readOnlyMatches, exemptionMatches);
    violations.push(...legacyIdentifiers(file, sf));
    counts.set(file, { roots: roots.length, placeCalls: placeCallCount(sf), writes });
  }

  // 一覧の古さ (段 A〜E は移行済みの受け手に掛かる行だけ。§16 の段 A)
  for (const row of lists.boundaries) {
    if (!receiverFiles.has(row.file)) continue;
    if (!(fileFunctions.get(row.file)?.has(row.fn) ?? false)) {
      listViolations.push(`READ_PATH_BOUNDARIES の ${row.file} の ${row.fn} がファイルに無い (一覧を直す)`);
    } else if (!(boundaryHits.get(row.file)?.has(row.fn) ?? false)) {
      listViolations.push(`READ_PATH_BOUNDARIES の ${row.file} の ${row.fn} が読み取りの経路からたどれない (一覧を直す)`);
    }
  }
  for (const row of lists.readOnlySends) {
    const owners = lists.readOnlySendOwners[row.url] ?? [];
    if (!owners.some((owner) => receiverFiles.has(owner))) continue;
    if (!readOnlyMatches.has(row.url)) listViolations.push(`READ_ONLY_SENDS の ${row.url} に当たる送信が受け手に無い (一覧を直す)`);
  }
  for (const row of lists.exemptions) {
    if (!receiverFiles.has(row.file)) continue;
    if (!exemptionMatches.has(`${row.file}#${row.fn}#${row.url}`)) {
      listViolations.push(`WRITE_WINDOW_EXEMPTIONS の ${row.file} の ${row.fn} (${row.url}) に当たる書き込みが無い (一覧を直す)`);
    }
  }
  return { violations, listViolations, counts, supabaseReads, discardedContainers };
}

/** P6: 受け手のファイルの集合と数が表のとおりか (違反の一覧) */
function expectationViolations(
  counts: ReadonlyMap<string, ReceiverCounts>,
  expectations: typeof RECEIVER_EXPECTATIONS,
): string[] {
  const violations: string[] = [];
  for (const file of counts.keys()) {
    if (!Object.prototype.hasOwnProperty.call(expectations, file)) {
      violations.push(`${file}: ${RECEIVER_HOOK} を呼ぶのに RECEIVER_EXPECTATIONS に無い (自分の段の見出しの下に行を足す)`);
    }
  }
  for (const [file, expected] of Object.entries(expectations)) {
    const actual = counts.get(file);
    if (actual === undefined) {
      violations.push(`${file}: RECEIVER_EXPECTATIONS にあるのに ${RECEIVER_HOOK} を呼ばない (表を直す)`);
      continue;
    }
    if (actual.roots < 1) violations.push(`${file}: 読み取りの経路の根が無い`);
    if (actual.placeCalls < expected.minPlaceCalls) {
      violations.push(`${file}: ${PLACE_METHOD} の呼び出しが ${actual.placeCalls} (鍵の欄の数 ${expected.minPlaceCalls} より少ない)`);
    }
    if (actual.writes !== expected.writes) {
      violations.push(`${file}: 書き込みが ${actual.writes} (表は ${expected.writes}。§9.1 と実数を突き合わせる)`);
    }
  }
  return violations;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(rel));
    else if (SOURCE_FILE.test(entry.name)) out.push(rel);
  }
  return out;
}

/** src の受け手 (useAiConsultationReceiver を呼ぶファイル) */
function receiverSources(): ReceiverSource[] {
  return listSourceFiles(SRC_ROOT)
    .map((file) => ({ file, source: fs.readFileSync(path.join(ROOT, file), 'utf8') }))
    .filter(isReceiverSource);
}

describe('受け手は place の中だけで置き、書き込みは窓の中だけ (#2206 G1)', () => {
  const sources = receiverSources();
  const report = checkReceivers(sources);

  it('受け手のソース (P1〜P4 の違反が無い)', () => {
    // 名前の書き間違いで受け手を 1 つも見つけられないまま緑にならないように、hook のファイルが同じ名前を export することを先に見る
    const hookSource = fs.readFileSync(path.join(ROOT, RECEIVER_HOOK_FILE), 'utf8');
    expect(hookSource).toContain(`export function ${RECEIVER_HOOK}(`);
    expect(report.violations).toEqual([]);
  });

  it('P6: 受け手のファイルの集合が RECEIVER_EXPECTATIONS と同じで、ファイルごとに根・place・書き込みの数が表のとおり', () => {
    expect([...report.counts.keys()].sort()).toEqual(sources.map((s) => s.file).sort());
    expect(expectationViolations(report.counts, RECEIVER_EXPECTATIONS)).toEqual([]);
  });

  it('READ_PATH_BOUNDARIES・READ_ONLY_SENDS・WRITE_WINDOW_EXEMPTIONS の行は、どれも当てはまる関数・送信を持つ (古い一覧は赤)', () => {
    // 段 A〜E は移行済みの受け手に掛かる行だけを検査する (§16 の段 A)。READ_ONLY_SEND_OWNERS は READ_ONLY_SENDS の全行の行き先を持つ
    expect(READ_ONLY_SENDS.map((row) => row.url).filter((url) => (READ_ONLY_SEND_OWNERS[url] ?? []).length === 0)).toEqual([]);
    expect(Object.keys(READ_ONLY_SEND_OWNERS).sort()).toEqual(READ_ONLY_SENDS.map((row) => row.url).sort());
    expect(report.listViolations).toEqual([]);
  });

  describe('見分けの空振りを防ぐ (直す前の形を赤にする)', () => {
    const PAGE_FILE = 'src/app/(main)/x/page.tsx';
    const HOOK_FILE = 'src/hooks/useX.ts';
    const header = `import { ${RECEIVER_HOOK} } from '@/hooks/useAiConsultationReceiver';`;
    /** 空の一覧 (各 it が足す) */
    const EMPTY_LISTS: GuardLists = { boundaries: [], readOnlySends: [], exemptions: [], readOnlySendOwners: {} };
    const check = (source: string, lists: GuardLists = EMPTY_LISTS, file: string = PAGE_FILE) =>
      checkReceivers([{ file, source: `${header}\n${source}` }], lists);

    it('await のあとに place の外で setter を呼ぶ (直す前の /home の setUser) は赤', () => {
      const report = check(`export const useX = () => {
        const fetchUser = async (read) => {
          const res = await fetch('/api/user');
          setUser(await res.json());
        };
        const receiver = ${RECEIVER_HOOK}(fetchUser);
        return receiver;
      };`, EMPTY_LISTS, HOOK_FILE);
      expect(report.violations).toEqual([expect.stringMatching(/useX\.ts:5: 読み取りの経路の fetchUser が、応答が届いたあとに setUser を place の外で呼ぶ/)]);
    });

    it('router.replace を place の外で呼ぶ (直す前の家族の画面) は赤', () => {
      const source = `function Page() {
        const router = useRouter();
        const readDashboard = useCallback(async (read) => {
          const res = await fetch('/api/family');
          const body = await res.json();
          MOVE
        }, [router]);
        const receiver = ${RECEIVER_HOOK}(readDashboard);
        useEffect(() => { void receiver.read({ loadingKeys: ['dashboard'] }, readDashboard); }, [receiver, readDashboard]);
      }`;
      expect(check(source.replaceAll('MOVE', "if (!body.family_id) router.replace('/family/setup');")).violations).toEqual([
        expect.stringMatching(/page\.tsx:7: .* router\.replace を place の外で呼ぶ/),
      ]);
      expect(check(source.replaceAll('MOVE', "if (!body.family_id) read.place('dashboard', () => router.replace('/family/setup'));")).violations).toEqual([]);
    });

    it('then に渡した関数の中で place の外に置くのは赤', () => {
      const source = `function Page() {
        const load = useCallback((read) => {
          fetch('/x').then((res) => res.json()).then((data) => PLACE);
        }, []);
        const receiver = ${RECEIVER_HOOK}(load);
      }`;
      expect(check(source.replaceAll('PLACE', 'setItems(data)')).violations).toEqual([
        expect.stringMatching(/page\.tsx:4: 読み取りの経路の 無名の関数 が、応答が届いたあとに setItems を place の外で呼ぶ/),
      ]);
      expect(check(source.replaceAll('PLACE', "read.place('items', () => setItems(data))")).violations).toEqual([]);
    });

    it('await のあとの Date の setDate・localStorage.setItem・supabase.auth.setSession は赤にしない。store の getState().setX は赤', () => {
      const source = `function Page() {
        const load = useCallback(async (read) => {
          const res = await fetch('/x');
          const day = new Date();
          day.setDate(1);
          localStorage.setItem('k', 'v');
          await supabase.auth.setSession(res.session);
          STORE
        }, []);
        const receiver = ${RECEIVER_HOOK}(load);
      }`;
      expect(check(source.replaceAll('STORE', '')).violations).toEqual([]);
      expect(check(source.replaceAll('STORE', 'usePantryStore.getState().setFridgeItems([]);')).violations).toEqual([
        expect.stringMatching(/page\.tsx:9: .* getState\(\)\.setFridgeItems を place の外で呼ぶ/),
      ]);
      // dispatch も置く呼び出し (reducer の dispatch)
      expect(check(source.replaceAll('STORE', "dispatchWeekView({ type: 'MERGE' });")).violations).toEqual([
        expect.stringMatching(/page\.tsx:9: .* dispatchWeekView を place の外で呼ぶ/),
      ]);
    });

    it('await の前の同期の setter (setError(null) など) は赤にしない', () => {
      expect(
        check(`function Page() {
          const load = useCallback(async (read) => {
            setError(null);
            setTimeout(() => undefined, 0);
            const res = await fetch('/x');
            read.place('items', () => setItems(res));
          }, []);
          const receiver = ${RECEIVER_HOOK}(load);
        }`).violations,
      ).toEqual([]);
    });

    it('書き込みの関数 (読み取りの経路でない) の楽観的な setter は赤にしない', () => {
      expect(
        check(`function Page() {
          const load = useCallback(async (read) => {
            const res = await fetch('/x');
            read.place('items', () => setItems(res));
          }, []);
          const receiver = ${RECEIVER_HOOK}(load);
          const remove = async (id) => {
            const endWrite = receiver.beginWrite();
            try {
              setItems((items) => items.filter((item) => item.id !== id));
              await fetch('/x/' + id, { method: 'DELETE' });
              setDeleted(id);
            } finally {
              endWrite();
            }
          };
        }`).violations,
      ).toEqual([]);
    });

    it('GET でない fetch を窓の外で await する (直す前の /profile の handleSave) は赤', () => {
      const source = `function Page() {
        const receiver = ${RECEIVER_HOOK}(async (read) => { const res = await fetch('/api/profile'); read.place('profile', () => setProfile(res)); });
        const handleSave = async () => {
          BEGIN
          try {
            await fetch('/api/profile', { method: 'PUT', body: '{}' });
            await fetch('/api/profile', { method: 'GET' });
          } finally {
            END
          }
        };
      }`;
      const outside = check(source.replaceAll('BEGIN', '').replaceAll('END', ''));
      expect(outside.violations).toEqual([expect.stringMatching(/page\.tsx:7: handleSave の書き込み fetch\(\/api\/profile\) が beginWrite の窓の外/)]);
      expect(outside.counts.get(PAGE_FILE)?.writes).toBe(1);
      expect(check(source.replaceAll('BEGIN', 'const endWrite = receiver.beginWrite();').replaceAll('END', 'endWrite();')).violations).toEqual([]);
    });

    it('Supabase の rpc / upsert を窓の外で await する (直す前の useHomeData の submitPerformanceCheckin) は赤', () => {
      const report = check(`export const useX = () => {
        const receiver = ${RECEIVER_HOOK}(async (read) => { const { data, error } = await supabase.from('a').select('*'); if (!error) read.place('a', () => setA(data)); });
        const submitPerformanceCheckin = async (checkin) => {
          await supabase.from('daily_performance_checkins').upsert(checkin);
          await supabase.rpc('recalc', { id: checkin.id });
          const cache = new Map();
          cache.delete('k');
        };
        return receiver;
      };`, EMPTY_LISTS, HOOK_FILE);
      expect(report.violations).toEqual([
        expect.stringMatching(/useX\.ts:5: submitPerformanceCheckin の書き込み \.upsert が beginWrite の窓の外/),
        expect.stringMatching(/useX\.ts:6: submitPerformanceCheckin の書き込み \.rpc が beginWrite の窓の外/),
      ]);
      // Map の delete は Supabase の書き込みではない
      expect(report.counts.get(HOOK_FILE)?.writes).toBe(2);
    });

    it('beginWrite を呼んでも finally で終えない関数は赤', () => {
      const source = `function Page() {
        const receiver = ${RECEIVER_HOOK}(async (read) => undefined);
        const save = async () => {
          const endWrite = receiver.beginWrite();
          CLOSE
        };
      }`;
      const notClosed = check(source.replaceAll('CLOSE', "await fetch('/x', { method: 'POST' }); endWrite();")).violations;
      expect(notClosed).toEqual([
        expect.stringMatching(/page\.tsx:5: save が beginWrite の endWrite を同じ関数の finally 節/),
        expect.stringMatching(/page\.tsx:6: save の書き込み fetch\(\/x\) が beginWrite の窓の外/),
      ]);
      expect(check(source.replaceAll('CLOSE', "try { await fetch('/x', { method: 'POST' }); } finally { endWrite(); }")).violations).toEqual([]);
    });

    it('例外に書いた書き込みは赤にせず、例外に当てはまる行が無ければ赤', () => {
      const exemption = { file: PAGE_FILE, fn: 'checkPendingRequests', url: '/api/ai/menu/weekly/cleanup', reason: '検査の例' };
      const lists: GuardLists = { ...EMPTY_LISTS, exemptions: [exemption] };
      const source = `function Page() {
        const receiver = ${RECEIVER_HOOK}(async (read) => undefined);
        const checkPendingRequests = useCallback(async (targetDate) => {
          SEND
        }, []);
      }`;
      const exempted = check(source.replaceAll('SEND', "await fetch('/api/ai/menu/weekly/cleanup', { method: 'POST' });"), lists);
      expect(exempted.violations).toEqual([]);
      expect(exempted.listViolations).toEqual([]);
      expect(exempted.counts.get(PAGE_FILE)?.writes).toBe(0);
      // 同じ送信でも、例外の関数の外なら赤
      const otherFunction = check(
        source.replaceAll('checkPendingRequests', 'otherFunction').replaceAll('SEND', "await fetch('/api/ai/menu/weekly/cleanup', { method: 'POST' });"),
        lists,
      );
      expect(otherFunction.violations).toEqual([expect.stringContaining('otherFunction の書き込み')]);
      expect(otherFunction.listViolations).toEqual([expect.stringContaining('WRITE_WINDOW_EXEMPTIONS の src/app/(main)/x/page.tsx の checkPendingRequests')]);
      // 例外の行の受け手が移行していない (受け手でない) なら、行の古さは段 A〜E では検査しない
      expect(checkReceivers([{ file: 'src/app/(main)/y/page.tsx', source: 'export default function Y() { return null; }' }], lists).listViolations).toEqual([]);
    });

    it('.finally(endWrite) と .finally(() => { endWrite(); }) で閉じる窓は赤にしない', () => {
      const source = `function Page() {
        const receiver = ${RECEIVER_HOOK}(async (read) => undefined);
        const save = () => {
          const endWrite = receiver.beginWrite();
          void fetch('/x', { method: 'POST' }).then((res) => res.json()).CLOSE;
        };
      }`;
      expect(check(source.replaceAll('CLOSE', 'finally(endWrite)')).violations).toEqual([]);
      expect(check(source.replaceAll('CLOSE', 'finally(() => { endWrite(); })')).violations).toEqual([]);
      // then で閉じても窓は閉じない
      expect(check(source.replaceAll('CLOSE', 'then(() => { endWrite(); })')).violations).toEqual([
        expect.stringContaining('save が beginWrite の endWrite を'),
        expect.stringContaining('save の書き込み fetch(/x) が beginWrite の窓の外'),
      ]);
    });

    it('READ_ONLY_SENDS の行き先への POST は窓の外でも赤にしない。ほかの行き先の POST は赤', () => {
      const lists: GuardLists = {
        ...EMPTY_LISTS,
        readOnlySends: [{ url: '/api/ai/hint', reason: '検査の例' }],
        readOnlySendOwners: { '/api/ai/hint': [PAGE_FILE] },
      };
      const source = `function Page() {
        const receiver = ${RECEIVER_HOOK}(async (read) => undefined);
        const askHint = async (id) => {
          await aiFetch(\`DESTINATION\${id}\`, { method: 'POST' });
        };
      }`;
      const readOnly = check(source.replaceAll('DESTINATION', '/api/ai/hint?meal='), lists);
      expect(readOnly.violations).toEqual([]);
      expect(readOnly.listViolations).toEqual([]);
      expect(readOnly.counts.get(PAGE_FILE)?.writes).toBe(0);
      const other = check(source.replaceAll('DESTINATION', '/api/meals/'), lists);
      expect(other.violations).toEqual([expect.stringMatching(/page\.tsx:5: askHint の書き込み aiFetch\(\/api\/meals\/\) が beginWrite の窓の外/)]);
      // 一覧の行き先を持つ受け手が移行したのに、その行き先への送信が無ければ赤 (古い一覧)
      expect(other.listViolations).toEqual([expect.stringContaining('READ_ONLY_SENDS の /api/ai/hint に当たる送信が受け手に無い')]);
    });

    it('READ_PATH_BOUNDARIES の関数の中の await のあとの setter は赤にしない。境の外の同じ形は赤', () => {
      const lists: GuardLists = {
        ...EMPTY_LISTS,
        boundaries: [{ file: PAGE_FILE, fn: 'checkPendingRequests', reason: '検査の例' }],
      };
      const source = `function Page() {
        const checkPendingRequests = useCallback(async (targetDate) => {
          const res = await fetch('/api/ai/menu/weekly/pending');
          setIsGenerating(true);
        }, []);
        const refetchAfterAiConsultation = useCallback(async (read) => {
          void checkPendingRequests(weekStartKeyRef.current);
          const res = await fetch('/api/meal-plans');
          read.place('plan', () => setCurrentPlan(res));
        }, [checkPendingRequests]);
        const receiver = ${RECEIVER_HOOK}(refetchAfterAiConsultation);
      }`;
      const bounded = check(source, lists);
      expect(bounded.violations).toEqual([]);
      expect(bounded.listViolations).toEqual([]);
      expect(check(source).violations).toEqual([expect.stringMatching(/page\.tsx:5: 読み取りの経路の checkPendingRequests が、応答が届いたあとに setIsGenerating を place の外で呼ぶ/)]);
      // 一覧の関数がたどりで届かない・ファイルに無いなら赤 (古い一覧)
      const unreached = check(source.replace('void checkPendingRequests(weekStartKeyRef.current);', ''), lists);
      expect(unreached.listViolations).toEqual([expect.stringContaining('checkPendingRequests が読み取りの経路からたどれない')]);
      const missing = check(source, { ...lists, boundaries: [{ file: PAGE_FILE, fn: 'resumePendingGeneration', reason: '検査の例' }] });
      expect(missing.listViolations).toEqual([expect.stringContaining('resumePendingGeneration がファイルに無い')]);
    });

    it('receiver を分割代入した受け手 (const { read } = …) は赤 (経路をたどれない)', () => {
      expect(
        check(`function Page() {
          const { read, beginWrite } = ${RECEIVER_HOOK}(async (r) => undefined);
        }`).violations,
      ).toEqual([expect.stringMatching(/page\.tsx:3: useAiConsultationReceiver の戻り値を分割代入している/)]);
      expect(
        check(`function Page() {
          const receiver = ${RECEIVER_HOOK}(async (r) => undefined);
          const { read } = receiver;
        }`).violations,
      ).toEqual([expect.stringMatching(/page\.tsx:4: 受け手 \(receiver\) を分割代入している/)]);
    });

    it('旧 API の識別子が受け手に残っていれば赤', () => {
      const report = check(`function Page() {
        const receiver = ${RECEIVER_HOOK}(async (read) => undefined);
        const pendingWrites = useAiConsultationPendingWrites();
        const ok = (ticket) => ticket.isLatest();
      }`);
      expect(report.violations).toEqual([
        expect.stringMatching(/page\.tsx:4: 旧 API の useAiConsultationPendingWrites/),
        expect.stringMatching(/page\.tsx:5: 旧 API の isLatest/),
      ]);
    });

    it('直した形は赤にしない', () => {
      const report = check(`function Page() {
        const fetchItems = useCallback(async (read) => {
          try {
            const res = await fetch('/api/pantry');
            if (!res.ok) {
              if (read.mode === 'mount') read.place('items', () => setError('読み込めませんでした'));
              return;
            }
            const data = await res.json();
            read.place('items', () => setItems(data.items ?? []));
          } catch (e) {
            if (read.mode === 'mount') read.place('items', () => setError('読み込めませんでした'));
          }
        }, []);
        const receiver = ${RECEIVER_HOOK}(fetchItems, { initialLoadingKeys: ['items'] });
        useEffect(() => { void receiver.read({ loadingKeys: ['items'] }, fetchItems); }, [receiver, fetchItems]);
        const loading = receiver.isLoading('items');
        const remove = async (id) => {
          const endWrite = receiver.beginWrite();
          try {
            await fetch('/api/pantry/' + id, { method: 'DELETE' });
            await receiver.read({}, fetchItems);
          } finally {
            endWrite();
          }
        };
      }`);
      expect(report.violations).toEqual([]);
      // 根は useAiConsultationReceiver の第 1 引数と、read の第 2 引数 2 つ
      expect(report.counts.get(PAGE_FILE)).toEqual({ roots: 3, placeCalls: 3, writes: 1 });
    });

    it('P3: 読み取りの経路の Supabase の読み取りが data を受け取って error を受け取らなければ赤 (旧 6)', () => {
      const source = `function Page() {
        const load = useCallback(async (read) => {
          const { RESULT } = await supabase.from('user_badges').select('*');
          read.place('badges', () => setBadges(data ?? []));
        }, []);
        const receiver = ${RECEIVER_HOOK}(load);
      }`;
      const report = check(source.replaceAll('RESULT', 'data'));
      expect(report.violations).toEqual([expect.stringMatching(/page\.tsx:4: 読み取りの経路の load が Supabase の読み取りの data を受け取るのに error を受け取らない/)]);
      expect(report.supabaseReads).toEqual([`${PAGE_FILE}:4`]);
      expect(check(source.replaceAll('RESULT', 'data, error')).violations).toEqual([]);
    });

    it('P4: 読み取りの経路が clear() で捨てる入れ物に、応答が届いたあとで書けば赤 (旧 8)', () => {
      const source = `function Page() {
        const fetchedMonthsRef = useRef(new Set());
        const readMonth = async (read, month) => {
          WRITE_BEFORE
          const res = await fetch('/api/meal-dates?month=' + month);
          WRITE_AFTER
          read.place('mealDates:' + month, () => dispatchWeekView({ type: 'REPLACE_RANGE' }));
        };
        const refetchAfterAiConsultation = useCallback(async (read) => {
          fetchedMonthsRef.current.clear();
          await readMonth(read, '2026-11');
        }, []);
        const receiver = ${RECEIVER_HOOK}(refetchAfterAiConsultation);
      }`;
      const after = check(source.replaceAll('WRITE_BEFORE', '').replaceAll('WRITE_AFTER', 'fetchedMonthsRef.current.add(month);'));
      expect(after.violations).toEqual([expect.stringMatching(/page\.tsx:7: 読み取りの経路が fetchedMonthsRef\.current\.clear\(\) で捨てる入れ物に、readMonth が応答の届いたあとで書く/)]);
      expect(after.discardedContainers).toEqual([`${PAGE_FILE}:fetchedMonthsRef`]);
      expect(check(source.replaceAll('WRITE_BEFORE', 'fetchedMonthsRef.current.add(month);').replaceAll('WRITE_AFTER', '')).violations).toEqual([]);
    });

    it('P6: 表に無い受け手・表にあって受け手でないファイル・数の食い違いは赤', () => {
      const report = check(`function Page() {
        const load = useCallback(async (read) => {
          const res = await fetch('/x');
          read.place('items', () => setItems(res));
        }, []);
        const receiver = ${RECEIVER_HOOK}(load);
        const save = async () => {
          const endWrite = receiver.beginWrite();
          try { await fetch('/x', { method: 'POST' }); } finally { endWrite(); }
        };
      }`);
      expect(report.counts.get(PAGE_FILE)).toEqual({ roots: 1, placeCalls: 1, writes: 1 });
      expect(expectationViolations(report.counts, { [PAGE_FILE]: { minPlaceCalls: 1, writes: 1 } })).toEqual([]);
      expect(expectationViolations(report.counts, {})).toEqual([expect.stringContaining('RECEIVER_EXPECTATIONS に無い')]);
      expect(expectationViolations(report.counts, { [PAGE_FILE]: { minPlaceCalls: 2, writes: 0 } })).toEqual([
        expect.stringContaining('place の呼び出しが 1 (鍵の欄の数 2 より少ない)'),
        expect.stringContaining('書き込みが 1 (表は 0'),
      ]);
      expect(expectationViolations(new Map(), { [PAGE_FILE]: { minPlaceCalls: 1, writes: 0 } })).toEqual([
        expect.stringContaining('RECEIVER_EXPECTATIONS にあるのに useAiConsultationReceiver を呼ばない'),
      ]);
    });
  });
});
