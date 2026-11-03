/**
 * #2201 U2: 書き込みの印を渡す受け手は、取り直しの応答を置く時点の番兵 (札の deferIfHeld) を見ることをソースで数える。
 *
 * 受け手の共通の hook (src/hooks/useAiConsultationDataRefetch.ts) は「取り直しを始めたあとに書き込みが始まったら、その取り直しの応答は
 * 置かない」を札の deferIfHeld で受け持つが、応答を置くのはページなので、置く場所で deferIfHeld を呼ばないと効かない。
 * 問題 (直す前): /pantry と /menus/weekly は書き込みの印 (useAiConsultationPendingWrites) を hook に渡していたのに、取り直しの応答を
 * 置く前に deferIfHeld を見ていなかった (献立表は取り直しの関数が札を受け取りもしなかった)。取り直しの応答を待つあいだに食材を削除する・
 * 買い物リストの品目をチェックすると、削除・チェックの前に読んだ応答が、削除した食材・外したチェックを画面に戻した。
 * /health/goals と栄養目標の再設定は真偽の ref の印を渡していて、取り直しの応答を待つあいだに始めて終えた書き込みを見分けられなかった。
 *
 * 忘れたら赤になるように、受け手 (useAiConsultationDataRefetch / useAiConsultationRefetchKey を呼ぶ src のファイル) の構文木で数える:
 *   1. hook に渡す書き込みの印 (options の writeInFlightRef) は、useAiConsultationPendingWrites で作った印 (始めた回数を数える) か、
 *      取り直しそのものが印を立てて書き込みを止めるページ (SELF_HELD_RECEIVERS) の真偽の ref のどちらか
 *   2. 数える印を渡す受け手は、取り直しの関数 (useAiConsultationDataRefetch の第 1 引数) が札 (第 1 引数) を受け取って使い
 *      (useAiConsultationRefetchKey なら戻り値の refetchTicket を受け取り)、取り直しの経路を書いたファイルで deferIfHeld を呼ぶ
 *      (または取得の流れ useAiConsultationFetchStream の begin に札を渡す。流れの place が deferIfHeld を見る)
 *   3. SELF_HELD_RECEIVERS の取り直しの関数は、その真偽の ref を true にする (取り直しの応答を待つあいだに書き込みが始まらない)
 * 取り直しの関数を別の hook が作る受け手 (ホームの useHomeData) は DELEGATED_RECEIVERS に書き、その hook のファイルで 1・2 を数える。
 *   4. 受け手 (書き込みの印を渡さない受け手も) と DELEGATED_RECEIVERS の hook のファイルで、札の deferIfHeld を直に呼ぶところは、
 *      同じ関数の中のそれより前で順序 (最後に始めた取得か) を見る: isLatest の呼び出しか、useEffect の後片付けの印 (cancelled)。
 *      別々の取得を何本も持つページは、受け手の hook の useAiConsultationFetchStream の place で順序と番兵をまとめて見る
 *      (ページに deferIfHeld も世代番号も書かない)
 *   問題 (直す前・R4): 献立表の冷蔵庫 (fetchPantry) と人数の設定 (fetchUserSettings) の取り直しは、応答を置く前に deferIfHeld だけを
 *   見て順序を見ていなかった。続けて来た 2 回の通知の取り直しや、開いたときの読み込みと取り直しの応答が逆の順に届くと、古い応答が
 *   新しい一覧・人数を上書きした (献立表は流れごとにページの世代番号の数を書き分けていて、この 2 つで書き忘れた)。
 *   5. 受け手 (書き込みの印を渡さない受け手も) と DELEGATED_RECEIVERS の hook のファイルで、取り直しの経路の関数 (取り直しの入口から
 *      名前で呼ぶ関数をたどった全部と、その中の関数) のうち、await (または .then / .catch に渡した関数) のあとに応答を置く setter
 *      (set で始まる名前の関数・store の getState().setX) を呼ぶ関数は、順序の見方 (isLatest・取得の流れの place・後片付けの印 cancelled・
 *      中断の signal.aborted) を関数の中に 1 つは持つ。取り直しの入口は、useAiConsultationDataRefetch の第 1 引数・
 *      useAiConsultationRefetchKey の refetchKey を依存に持つ useEffect の関数・DELEGATED_RECEIVERS の hook が返す取り直しの関数。
 *      取り直しそのものが await の前に立てた印 (同じ setter) を finally で下ろすところは応答ではないので数えない (家族・譲渡の承諾の画面)
 *   問題 (直す前・R5): ホームの栄養の分析 (useHomeData の fetchNutritionAnalysis) は、取り直しの経路 (readHomeData) から呼ばれるのに
 *   順序を 1 つも見ずに点数・課題・アドバイスと今日のアドバイスの帯を置いていた。続けて来た 2 回の通知の取り直しの応答が逆の順に届くと、
 *   古い分析とアドバイスが新しい表示を上書きし、古い応答が新しい読み取りの途中で読み込み中の印を下ろした (R4 の献立表と同じ型の残り)。
 *
 * 検査の限界: 取り直しの経路の「置く場所の全部」で deferIfHeld・順序を見ているかまでは数えない (4 は deferIfHeld を直に呼ぶところの
 * 前に順序の見方があるかを、関数の中の書いた位置で見るだけで、その見方がその置く場所を守る分岐かは見ない。5 は順序の見方を関数の中に
 * 1 つでも持つ関数を、置く場所ごとには数えない。ページごとの描画のテスト
 * tests/ai-consultation-refetch-reads-2195.test.tsx・tests/ai-consultation-weekly-refetch-2195.test.tsx・
 * tests/ai-consultation-home-refetch-2195.test.tsx が、書き込み・モーダルの途中に届いた応答・古い応答を置かないことを確かめる)。
 * 1〜3 は書き込みの印を渡さない受け手 (読むだけのページ) を数えない。
 * 5 は、取り直しの関数が state を変えて走らせる useEffect (献立表の aiConsultationRefetchRound で走る月のカレンダー・生成中の依頼の確認) と、
 * 取り直しの経路でない取得 (日を選んだとき・週を移ったとき) が取り直しと同じ値を置くかは見ない (取り直しと同じ値を置く別の取得は、
 * 取り直しと同じ取得の流れで始める。/health の選んだ日のパネル・献立表の表示中の週の献立。描画のテストが確かめる)。
 * 名前の同じ関数がファイルの中に何個かあれば、全部をたどる (多めに数える)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = 'src';
const RECEIVER_HOOK_FILE = 'src/hooks/useAiConsultationDataRefetch.ts';
const DATA_REFETCH_HOOK = 'useAiConsultationDataRefetch';
const REFETCH_KEY_HOOK = 'useAiConsultationRefetchKey';
const PENDING_WRITES_HOOK = 'useAiConsultationPendingWrites';
const FETCH_STREAM_HOOK = 'useAiConsultationFetchStream';
/** 取得の流れの、取得を始める関数 (札を渡すと、流れの place が応答を置く時点の番兵を見る) */
const STREAM_BEGIN = 'begin';
const WRITE_MARKER_OPTION = 'writeInFlightRef';
const REFETCH_TICKET_RESULT = 'refetchTicket';
const DEFER_IF_HELD = 'deferIfHeld';
/** 札の順序の見方 (最後に始めた取得か。札・流れの札の isLatest、ページが受け取った isLatest の関数) */
const ORDER_CHECK_CALL = 'isLatest';
/** useEffect の後片付けで前の回の応答を捨てる印 (useAiConsultationRefetchKey の受け手) */
const CLEANUP_FLAG = 'cancelled';
/** 取得の流れの札の、順序と番兵を見て応答を置く関数 */
const STREAM_PLACE = 'place';
/** 中断した読み取りの応答を捨てる印 (AbortController の signal.aborted。/comparison) */
const ABORT_FLAG = 'aborted';
/** 規則 5 の順序の見方 (関数の中にどれか 1 つでもあれば、その関数は応答を置く前に順序を見ている) */
const ORDER_TOKENS: ReadonlySet<string> = new Set([ORDER_CHECK_CALL, STREAM_PLACE, CLEANUP_FLAG, ABORT_FLAG]);
/** useAiConsultationRefetchKey の戻り値の、取り直すときに増える数 */
const REFETCH_KEY_RESULT = 'refetchKey';
/** 応答を画面に置く setter の名前 (React の state の setter・store の setter) */
const SETTER_NAME = /^set[A-Z]/;
/** store の今の状態を取る関数 (usePantryStore.getState().setFridgeItems の getState) */
const STORE_STATE_ACCESS = 'getState';
/** 応答を受け取る関数を渡す Promise のメソッド (渡した関数の中は await のあと) */
const PROMISE_CALLBACK_METHODS: ReadonlySet<string> = new Set(['then', 'catch']);
const SOURCE_FILE = /\.(ts|tsx)$/;

/**
 * 取り直しそのものが真偽の ref の印を立て、印が立っている間は書き込みを始めないページ (取り直しの応答を待つあいだに書き込みが始まらない
 * ので、応答を置く時点で書き込みを見分けなくてよい。印は書き込みと取り直しの両方を止める鍵で、数える印に置き換えると鍵でなくなる)
 */
const SELF_HELD_RECEIVERS: ReadonlyArray<{ file: string; marker: string }> = [
  { file: 'src/app/(main)/family/members/page.tsx', marker: 'writeInFlightRef' },
  { file: 'src/app/(main)/family/members/[id]/page.tsx', marker: 'busyRef' },
  { file: 'src/app/(main)/family/transfer-accept/[proposal_id]/page.tsx', marker: 'busyRef' },
  { file: 'src/app/(main)/org/transfer-accept/[proposal_id]/page.tsx', marker: 'busyRef' },
];

/** 取り直しの関数と書き込みの印を別の hook が作る受け手 (その hook のファイルで数える) */
const DELEGATED_RECEIVERS: ReadonlyArray<{ file: string; marker: string; refetch: string; definedIn: string }> = [
  { file: 'src/app/(main)/home/page.tsx', marker: 'aiConsultationWrites', refetch: 'refetch', definedIn: 'src/hooks/useHomeData.ts' },
];

/**
 * 検査が何も数えずに緑になるのを防ぐ下限 (2026-11-04 の実数: 数える印を渡す受け手 6 (/pantry・/menus/weekly・/home・/meals/[id]・
 * /health/goals・栄養目標の再設定)・取り直しが印を立てる受け手 4。受け手を減らしてこれを割ったら、実数を数え直して下げる)
 */
const MIN_COUNTED_MARKER_RECEIVERS = 6;

/**
 * 規則 5 が見た取り直しの経路の取得 (await のあとに何かをする関数) の数の下限 (検査が何もたどらずに緑になるのを防ぐ。
 * 2026-11-04 の実数。取り直しの経路を減らしてこれを割ったら、実数を数え直して下げる)
 */
const MIN_REFETCH_PATH_FETCHERS = 46;

interface ReceiverSource {
  file: string;
  source: string;
}

/** 受け手の検査の結果 */
interface PlacementGuardReport {
  violations: string[];
  countedMarkerReceivers: string[];
  selfHeldReceivers: string[];
  /** 規則 5 が見た取り直しの経路の取得 ('<ファイル>:<行>') */
  refetchPathFetchers: string[];
}

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

/** useAiConsultationFetchStream で作った取得の流れの名前 */
function fetchStreamNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  walk(sf, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      calleeName(node.initializer) === FETCH_STREAM_HOOK
    ) {
      names.add(node.name.text);
    }
  });
  return names;
}

/**
 * 取り直しの応答を置く時点の番兵を見ているか: X.deferIfHeld() / X?.deferIfHeld() を呼ぶか、取得の流れの begin に札 (引数) を渡す
 * (流れの place が deferIfHeld を見る)
 */
function seesHeldAtPlacement(sf: ts.SourceFile): boolean {
  const streams = fetchStreamNames(sf);
  let found = false;
  walk(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const { name, expression } = node.expression;
    if (name.text === DEFER_IF_HELD) found = true;
    if (name.text === STREAM_BEGIN && ts.isIdentifier(expression) && streams.has(expression.text) && node.arguments.length > 0) found = true;
  });
  return found;
}

/** node を囲む一番内側の関数 (無ければ null) */
function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionLike(current) && 'body' in current) return current as ts.FunctionLikeDeclaration;
  }
  return null;
}

/** 順序の見方か (isLatest の呼び出し・後片付けの印 cancelled を読むところ) */
function isOrderCheck(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) return callee.text === ORDER_CHECK_CALL;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text === ORDER_CHECK_CALL;
    return false;
  }
  return ts.isIdentifier(node) && node.text === CLEANUP_FLAG && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node);
}

/** 札の deferIfHeld を直に呼ぶところのうち、同じ関数の中のそれより前で順序を見ていないところ (行番号) */
function deferIfHeldWithoutOrderCheck(sf: ts.SourceFile): number[] {
  const lines: number[] = [];
  walk(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== DEFER_IF_HELD) return;
    const fn = enclosingFunction(node);
    const callStart = node.getStart(sf);
    let ordered = false;
    if (fn?.body !== undefined) {
      walk(fn.body, (inner) => {
        if (!ordered && inner.getStart(sf) < callStart && isOrderCheck(inner)) ordered = true;
      });
    }
    if (!ordered) lines.push(sf.getLineAndCharacterOfPosition(callStart).line + 1);
  });
  return lines;
}

/** options のオブジェクトの writeInFlightRef に渡した識別子の名前 (渡していなければ null) */
function writeMarkerName(options: ts.Expression | undefined): string | null {
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return null;
  for (const property of options.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === WRITE_MARKER_OPTION) return property.name.text;
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === WRITE_MARKER_OPTION) {
      return ts.isIdentifier(property.initializer) ? property.initializer.text : property.initializer.getText();
    }
  }
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

type MarkerKind = 'counted' | 'boolean' | 'unknown';

function markerKind(init: ts.Expression | undefined): MarkerKind {
  if (init === undefined || !ts.isCallExpression(init)) return 'unknown';
  const name = calleeName(init);
  if (name === PENDING_WRITES_HOOK) return 'counted';
  if (name === 'useRef' && init.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword) return 'boolean';
  return 'unknown';
}

type FunctionNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

function asFunction(node: ts.Node | undefined): FunctionNode | null {
  if (node === undefined) return null;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) return node;
  if (ts.isParenthesizedExpression(node)) return asFunction(node.expression);
  // useCallback(fn, deps) の fn
  if (ts.isCallExpression(node) && calleeName(node) === 'useCallback') return asFunction(node.arguments[0]);
  return null;
}

/** 取り直しの関数 (hook の第 1 引数。識別子ならその宣言の関数) */
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

/** 関数が第 1 引数 (札) を受け取り、本体で使うか */
function usesFirstParameter(fn: FunctionNode): boolean {
  const first = fn.parameters[0];
  if (first === undefined || !ts.isIdentifier(first.name) || fn.body === undefined) return false;
  const name = first.name.text;
  let used = false;
  walk(fn.body, (node) => {
    if (ts.isIdentifier(node) && node.text === name) used = true;
  });
  return used;
}

/** 関数の中で <marker>.current = true にするか */
function setsMarkerTrue(fn: FunctionNode, marker: string): boolean {
  let found = false;
  if (fn.body === undefined) return false;
  walk(fn.body, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.right.kind === ts.SyntaxKind.TrueKeyword &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'current' &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === marker
    ) {
      found = true;
    }
  });
  return found;
}

/** useAiConsultationRefetchKey の戻り値の分割代入で refetchTicket を受け取るか */
function receivesRefetchTicket(call: ts.CallExpression): boolean {
  const declaration = call.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isObjectBindingPattern(declaration.name)) return false;
  return declaration.name.elements.some((element) => {
    const property = element.propertyName ?? element.name;
    return ts.isIdentifier(property) && property.text === REFETCH_TICKET_RESULT;
  });
}

/** 返すオブジェクトの property (name) の関数 (取り直しの関数を作る hook の戻り値) */
function returnedPropertyFunction(sf: ts.SourceFile, name: string): FunctionNode | null {
  let found: FunctionNode | null = null;
  walk(sf, (node) => {
    if (found !== null) return;
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === name) found = asFunction(node.initializer);
  });
  return found;
}

/** 関数のノード (矢印関数・関数式・関数の宣言) か */
function isFunctionNode(node: ts.Node): node is FunctionNode {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
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

/** useAiConsultationRefetchKey の戻り値の refetchKey を受け取った名前 */
function refetchKeyNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const call of callsTo(sf, [REFETCH_KEY_HOOK])) {
    const declaration = call.parent;
    if (!ts.isVariableDeclaration(declaration) || !ts.isObjectBindingPattern(declaration.name)) continue;
    for (const element of declaration.name.elements) {
      const property = element.propertyName ?? element.name;
      if (ts.isIdentifier(property) && property.text === REFETCH_KEY_RESULT && ts.isIdentifier(element.name)) names.add(element.name.text);
    }
  }
  return names;
}

/**
 * 取り直しの経路の入口の関数 (規則 5): useAiConsultationDataRefetch の第 1 引数・useAiConsultationRefetchKey の refetchKey を
 * 依存に持つ useEffect の関数・delegatedRefetch (DELEGATED_RECEIVERS の hook が返す取り直しの関数の名前) の関数
 */
function refetchEntryFunctions(sf: ts.SourceFile, delegatedRefetch: string | null): FunctionNode[] {
  const entries: FunctionNode[] = [];
  for (const call of callsTo(sf, [DATA_REFETCH_HOOK])) {
    const fn = resolveFunction(sf, call.arguments[0]);
    if (fn !== null) entries.push(fn);
  }
  const keyNames = refetchKeyNames(sf);
  for (const call of callsTo(sf, ['useEffect'])) {
    const deps = call.arguments[1];
    if (deps === undefined || !ts.isArrayLiteralExpression(deps)) continue;
    if (!deps.elements.some((dep) => ts.isIdentifier(dep) && keyNames.has(dep.text))) continue;
    const fn = asFunction(call.arguments[0]);
    if (fn !== null) entries.push(fn);
  }
  if (delegatedRefetch !== null) {
    const fn = returnedPropertyFunction(sf, delegatedRefetch);
    if (fn !== null) entries.push(fn);
  }
  return entries;
}

/** 入口から、名前で呼ぶ関数をたどった全部の関数 (たどった関数の中の関数も含む) */
function refetchPathFunctions(sf: ts.SourceFile, entries: readonly FunctionNode[]): Set<FunctionNode> {
  const named = namedFunctions(sf);
  const reached = new Set<FunctionNode>();
  const queue: FunctionNode[] = [];
  const reach = (fn: FunctionNode) => {
    if (reached.has(fn)) return;
    reached.add(fn);
    queue.push(fn);
  };
  entries.forEach(reach);
  while (queue.length > 0) {
    const fn = queue.pop();
    if (fn?.body === undefined) continue;
    walk(fn.body, (node) => {
      if (isFunctionNode(node)) reach(node);
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (name !== null) (named.get(name) ?? []).forEach(reach);
      }
    });
  }
  return reached;
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

/** Promise の then / catch に渡した関数か (中は応答が届いたあと) */
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

/** 応答を置く setter の呼び出しなら、その名前 (setX(...)・X.getState().setY(...)) */
function setterCallName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return SETTER_NAME.test(callee.text) ? callee.text : null;
  if (
    ts.isPropertyAccessExpression(callee) &&
    SETTER_NAME.test(callee.name.text) &&
    ts.isCallExpression(callee.expression) &&
    ts.isPropertyAccessExpression(callee.expression.expression) &&
    callee.expression.expression.name.text === STORE_STATE_ACCESS
  ) {
    return callee.name.text;
  }
  return null;
}

/** node が fn の中の try の finally の中か */
function inFinallyOf(node: ts.Node, fn: FunctionNode): boolean {
  for (let current: ts.Node = node; current !== fn && current.parent !== undefined; current = current.parent) {
    if (ts.isTryStatement(current.parent) && current.parent.finallyBlock === current) return true;
  }
  return false;
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

/**
 * 規則 5: 取り直しの経路の関数のうち、応答が届いたあと (最初の await のあと・then / catch に渡した関数の中) に setter を呼ぶのに、
 * 順序の見方 (ORDER_TOKENS) を関数の中に 1 つも持たない関数。fetchers に、見た取得 (応答が届いたあとに何かをする関数) を足す
 */
function placementsWithoutOrder(file: string, sf: ts.SourceFile, delegatedRefetch: string | null, fetchers: string[]): string[] {
  const violations: string[] = [];
  for (const fn of refetchPathFunctions(sf, refetchEntryFunctions(sf, delegatedRefetch))) {
    let settledFrom = isPromiseCallback(fn) ? fn.getStart(sf) : -1;
    walkOwnBody(fn, (node) => {
      if (settledFrom < 0 && ts.isAwaitExpression(node)) settledFrom = node.getStart(sf);
    });
    if (settledFrom < 0) continue;
    const line = sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1;
    fetchers.push(`${file}:${line}`);
    let ordered = false;
    if (fn.body !== undefined) {
      walk(fn.body, (node) => {
        if (ts.isIdentifier(node) && ORDER_TOKENS.has(node.text)) ordered = true;
      });
    }
    if (ordered) continue;
    // 取り直しそのものが応答を待つ前に立てた印 (同じ setter) を finally で下ろすところは、応答を置くところではない
    const raisedBeforeSettled = new Set<string>();
    const placedSetters: string[] = [];
    walkOwnBody(fn, (node) => {
      if (!ts.isCallExpression(node)) return;
      const name = setterCallName(node);
      if (name === null) return;
      const start = node.getStart(sf);
      if (start < settledFrom) raisedBeforeSettled.add(name);
      else if (!(raisedBeforeSettled.has(name) && inFinallyOf(node, fn))) {
        placedSetters.push(`${name} (${sf.getLineAndCharacterOfPosition(start).line + 1} 行)`);
      }
    });
    if (placedSetters.length > 0) {
      violations.push(
        `${file}:${line}: 取り直しの経路の取得 ${functionLabel(fn)} が、応答が届いたあとに ${placedSetters.join('・')} で応答を置くのに、順序 (${[...ORDER_TOKENS].join('・')}) を 1 つも見ていない (最後に始めた取得の応答だけを置く。useAiConsultationFetchStream の place か isLatest で見る)`,
      );
    }
  }
  return violations;
}

/** 受け手のソースを数える (sources は検査する全部のファイル。DELEGATED_RECEIVERS の definedIn もこの中から引く) */
function checkPlacementGuards(
  sources: readonly ReceiverSource[],
  selfHeld: typeof SELF_HELD_RECEIVERS,
  delegated: typeof DELEGATED_RECEIVERS,
): PlacementGuardReport {
  const violations: string[] = [];
  const countedMarkerReceivers: string[] = [];
  const selfHeldReceivers: string[] = [];
  const refetchPathFetchers: string[] = [];
  const byFile = new Map(sources.map((s) => [s.file, s.source]));

  for (const { file, source } of sources) {
    if (file === RECEIVER_HOOK_FILE) continue;
    const sf = parse(file, source);
    for (const line of deferIfHeldWithoutOrderCheck(sf)) {
      violations.push(
        `${file}:${line}: 取り直しの応答を置く前に ${DEFER_IF_HELD} だけを見て、順序 (${ORDER_CHECK_CALL}・後片付けの ${CLEANUP_FLAG}) を見ていない (取得を何本も持つページは useAiConsultationFetchStream の place を使う)`,
      );
    }
    const delegatedRefetch = delegated.find((d) => d.definedIn === file)?.refetch ?? null;
    violations.push(...placementsWithoutOrder(file, sf, delegatedRefetch, refetchPathFetchers));
    for (const call of callsTo(sf, [DATA_REFETCH_HOOK, REFETCH_KEY_HOOK])) {
      const hook = calleeName(call);
      const options = hook === DATA_REFETCH_HOOK ? call.arguments[1] : call.arguments[0];
      const marker = writeMarkerName(options);
      if (marker === null) continue;
      const at = `${file}: ${hook} の ${WRITE_MARKER_OPTION} (${marker})`;
      const declaration = declarationOf(sf, marker);
      const delegation = delegated.find((d) => d.file === file && d.marker === marker);

      if (delegation) {
        const definedSource = byFile.get(delegation.definedIn);
        if (definedSource === undefined) {
          violations.push(`${at}: 書き込みの印を作る ${delegation.definedIn} が無い`);
          continue;
        }
        const definedSf = parse(delegation.definedIn, definedSource);
        const definedMarker = declarationOf(definedSf, marker);
        if (markerKind(definedMarker?.init) !== 'counted') {
          violations.push(`${at}: ${delegation.definedIn} の印が ${PENDING_WRITES_HOOK} で作ったものでない`);
          continue;
        }
        const refetch = returnedPropertyFunction(definedSf, delegation.refetch);
        if (refetch === null || !usesFirstParameter(refetch)) {
          violations.push(`${at}: ${delegation.definedIn} の取り直しの関数 (${delegation.refetch}) が札を受け取って使っていない`);
        }
        if (!seesHeldAtPlacement(definedSf)) {
          violations.push(`${at}: ${delegation.definedIn} が取り直しの応答を置く前に ${DEFER_IF_HELD} を見ていない`);
        }
        countedMarkerReceivers.push(file);
        continue;
      }

      const kind = markerKind(declaration?.init);
      if (kind === 'counted') {
        countedMarkerReceivers.push(file);
        if (hook === DATA_REFETCH_HOOK) {
          const refetch = resolveFunction(sf, call.arguments[0]);
          if (refetch === null) violations.push(`${at}: 取り直しの関数をたどれない`);
          else if (!usesFirstParameter(refetch)) violations.push(`${at}: 取り直しの関数が札 (第 1 引数) を受け取って使っていない`);
        } else if (!receivesRefetchTicket(call)) {
          violations.push(`${at}: 戻り値の ${REFETCH_TICKET_RESULT} を受け取っていない`);
        }
        if (!seesHeldAtPlacement(sf)) violations.push(`${at}: 取り直しの応答を置く前に ${DEFER_IF_HELD} を見ていない`);
        continue;
      }

      if (kind === 'boolean') {
        const entry = selfHeld.find((s) => s.file === file && s.marker === marker);
        if (!entry) {
          violations.push(
            `${at}: 真偽の ref の印は、取り直しの応答を待つあいだに始めて終えた書き込みを見分けられない (${PENDING_WRITES_HOOK} で作る)`,
          );
          continue;
        }
        const refetch = hook === DATA_REFETCH_HOOK ? resolveFunction(sf, call.arguments[0]) : null;
        if (refetch === null || !setsMarkerTrue(refetch, marker)) {
          violations.push(`${at}: 取り直しの関数が ${marker}.current = true にしない (取り直しの応答を待つあいだに書き込みが始まりうる)`);
          continue;
        }
        selfHeldReceivers.push(file);
        continue;
      }

      violations.push(`${at}: 印の作り方を見分けられない (${PENDING_WRITES_HOOK} で作る)`);
    }
  }

  for (const entry of selfHeld) {
    if (!selfHeldReceivers.includes(entry.file)) {
      violations.push(`SELF_HELD_RECEIVERS の ${entry.file} (${entry.marker}) が、真偽の ref の印を渡す受け手として見つからない (一覧を直す)`);
    }
  }
  return { violations, countedMarkerReceivers, selfHeldReceivers, refetchPathFetchers };
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

/** 受け手 (hook を呼ぶファイル) と、取り直しの関数を作る hook のファイル */
function receiverSources(): ReceiverSource[] {
  const delegatedFiles = new Set(DELEGATED_RECEIVERS.map((d) => d.definedIn));
  return listSourceFiles(SRC_ROOT)
    .map((file) => ({ file, source: fs.readFileSync(path.join(ROOT, file), 'utf8') }))
    .filter(({ file, source }) => delegatedFiles.has(file) || source.includes(`${DATA_REFETCH_HOOK}(`) || source.includes(`${REFETCH_KEY_HOOK}(`));
}

describe('書き込みの印を渡す受け手は、取り直しの応答を置く前に札の deferIfHeld を見る (#2201 U2)', () => {
  it('受け手のソース', () => {
    const report = checkPlacementGuards(receiverSources(), SELF_HELD_RECEIVERS, DELEGATED_RECEIVERS);
    expect(report.violations).toEqual([]);
    expect(new Set(report.countedMarkerReceivers).size, '数える印を渡す受け手が見つからない (検査が空振りしている)').toBeGreaterThanOrEqual(
      MIN_COUNTED_MARKER_RECEIVERS,
    );
    expect(new Set(report.selfHeldReceivers).size).toBe(SELF_HELD_RECEIVERS.length);
    expect(report.refetchPathFetchers.length, '取り直しの経路の取得をたどれていない (規則 5 が空振りしている)').toBeGreaterThanOrEqual(
      MIN_REFETCH_PATH_FETCHERS,
    );
  });

  describe('見分けの空振りを防ぐ (直す前の /pantry・/menus/weekly・/health/goals の形を赤にする)', () => {
    const header = `import { ${DATA_REFETCH_HOOK}, ${PENDING_WRITES_HOOK}, ${REFETCH_KEY_HOOK} } from '@/hooks/useAiConsultationDataRefetch';`;
    const check = (source: string, selfHeld: typeof SELF_HELD_RECEIVERS = []) =>
      checkPlacementGuards([{ file: 'src/app/(main)/x/page.tsx', source: `${header}\n${source}` }], selfHeld, []).violations;

    it('数える印を渡しても deferIfHeld を見ない (直す前の /pantry)', () => {
      expect(
        check(`function Page() {
          const pendingWrites = ${PENDING_WRITES_HOOK}();
          const fetchItems = useCallback(async (ticket) => { const res = await fetch('/x'); if (ticket.isLatest()) setItems(await res.json()); }, []);
          ${DATA_REFETCH_HOOK}(fetchItems, { writeInFlightRef: pendingWrites });
        }`),
      ).toEqual([expect.stringContaining(DEFER_IF_HELD)]);
    });

    it('取り直しの関数が札を受け取らない (直す前の /menus/weekly)', () => {
      const violations = check(`function Page() {
        const pendingWrites = ${PENDING_WRITES_HOOK}();
        const refetchAfterAiConsultation = useCallback(() => { void refreshMealPlan(); }, [refreshMealPlan]);
        ${DATA_REFETCH_HOOK}(refetchAfterAiConsultation, { writeInFlightRef: pendingWrites });
      }`);
      expect(violations).toEqual([expect.stringContaining('札 (第 1 引数)'), expect.stringContaining(DEFER_IF_HELD)]);
    });

    it('真偽の ref の印 (直す前の /health/goals・栄養目標の再設定)', () => {
      expect(
        check(`function Page() {
          const writeInFlightRef = useRef(false);
          const { beginFetch } = ${DATA_REFETCH_HOOK}((ticket) => fetchGoals(ticket), { writeInFlightRef });
          const x = (ticket) => ticket.isLatest() && ticket.deferIfHeld();
        }`),
      ).toEqual([expect.stringContaining('真偽の ref')]);
    });

    it('取り直しが印を立てるページでも、取り直しの関数が印を立てなければ赤', () => {
      const selfHeld = [{ file: 'src/app/(main)/x/page.tsx', marker: 'writeInFlightRef' }];
      expect(
        check(
          `function Page() {
            const writeInFlightRef = useRef(false);
            const refetchAfterAiConsultation = async (ticket) => { await load(ticket); };
            ${DATA_REFETCH_HOOK}(refetchAfterAiConsultation, { writeInFlightRef });
          }`,
          selfHeld,
        ),
      ).toEqual([expect.stringContaining('.current = true'), expect.stringContaining('SELF_HELD_RECEIVERS')]);
    });

    it('useAiConsultationRefetchKey に数える印を渡して refetchTicket を受け取らない', () => {
      expect(
        check(`function Page() {
          const pendingWrites = ${PENDING_WRITES_HOOK}();
          const { refetchKey } = ${REFETCH_KEY_HOOK}({ writeInFlightRef: pendingWrites });
        }`),
      ).toEqual([expect.stringContaining(REFETCH_TICKET_RESULT), expect.stringContaining(DEFER_IF_HELD)]);
    });

    it('deferIfHeld だけを見て順序を見ない (R4 の直す前の献立表の fetchPantry・fetchUserSettings)', () => {
      const violations = check(`function Page() {
        const pendingWrites = ${PENDING_WRITES_HOOK}();
        const fetchPantry = useCallback(async (refetchTicket = null) => {
          const res = await fetch('/api/pantry');
          if (res.ok) {
            const data = await res.json();
            if (refetchTicket?.deferIfHeld()) return;
            setFridgeItems(data.items);
          }
        }, []);
        ${DATA_REFETCH_HOOK}((ticket) => { void fetchPantry(ticket); }, { writeInFlightRef: pendingWrites });
      }`);
      // 規則 4 (deferIfHeld の前に順序を見ない) と規則 5 (取り直しの経路の取得が順序を 1 つも見ない) の両方が赤にする
      expect(violations).toEqual([expect.stringMatching(/:8: .*順序/), expect.stringMatching(/:4: 取り直しの経路の取得 fetchPantry /)]);
    });

    it('順序の見方が deferIfHeld より後にあっても赤 (応答を置く前に順序を見ていない)', () => {
      expect(
        check(`function Page() {
          const load = async (ticket) => {
            const res = await fetch('/x');
            if (ticket.deferIfHeld()) return;
            if (!ticket.isLatest()) return;
            setItems(await res.json());
          };
          ${DATA_REFETCH_HOOK}(load);
        }`),
      ).toEqual([expect.stringContaining('順序')]);
    });

    it('書き込みの印を渡さない受け手 (useAiConsultationRefetchKey) でも、後片付けの印 (cancelled) を見る前に deferIfHeld を見たら赤', () => {
      const source = `function Page() {
        const { refetchKey, refetchTicket } = ${REFETCH_KEY_HOOK}();
        useEffect(() => {
          let cancelled = false;
          const ticket = refetchTicket();
          const load = async () => {
            const res = await fetch('/x');
            ORDER_GUARD
            setItems(await res.json());
          };
          void load();
          return () => { cancelled = true; };
        }, [refetchKey]);
      }`;
      expect(check(source.replaceAll('ORDER_GUARD', 'if (ticket?.deferIfHeld()) return;'))).toEqual([
        expect.stringMatching(/:9: 取り直しの応答を置く前に/),
        expect.stringMatching(/:7: 取り直しの経路の取得 load /),
      ]);
      expect(check(source.replaceAll('ORDER_GUARD', 'if (cancelled) return; if (ticket?.deferIfHeld()) return;'))).toEqual([]);
    });

    it('取得の流れの begin に札を渡さない (取り直しの経路で応答を置く時点の番兵を見ない) は赤、渡して place で置く形は赤にしない', () => {
      const source = `function Page() {
        const pendingWrites = ${PENDING_WRITES_HOOK}();
        const pantryStream = ${FETCH_STREAM_HOOK}();
        const fetchPantry = useCallback(async (refetchTicket = null) => {
          const order = pantryStream.begin(BEGIN_ARGS);
          const res = await fetch('/api/pantry');
          order.place(() => setFridgeItems(res.items));
        }, [pantryStream]);
        ${DATA_REFETCH_HOOK}((ticket) => { void fetchPantry(ticket); }, { writeInFlightRef: pendingWrites });
      }`;
      expect(check(source.replaceAll('BEGIN_ARGS', ''))).toEqual([expect.stringContaining(DEFER_IF_HELD)]);
      expect(check(source.replaceAll('BEGIN_ARGS', 'refetchTicket'))).toEqual([]);
    });

    it('直した形は赤にしない', () => {
      expect(
        check(`function Page() {
          const pendingWrites = ${PENDING_WRITES_HOOK}();
          const fetchItems = useCallback(async (ticket, mode) => {
            const res = await fetch('/x');
            if (!ticket.isLatest()) return;
            if (mode === 'refetch' && ticket.deferIfHeld()) return;
            setItems(await res.json());
          }, []);
          ${DATA_REFETCH_HOOK}((ticket) => fetchItems(ticket, refetchReadMode()), { writeInFlightRef: pendingWrites });
        }`),
      ).toEqual([]);
    });
  });

  describe('規則 5: 取り直しの経路の取得は、応答を置くのに順序を見る (R5 の直す前のホームの栄養の分析の形を赤にする)', () => {
    const PAGE_FILE = 'src/app/(main)/x/page.tsx';
    const HOOK_FILE = 'src/hooks/useX.ts';
    const header = `import { ${DATA_REFETCH_HOOK}, ${FETCH_STREAM_HOOK} } from '@/hooks/useAiConsultationDataRefetch';`;
    const checkPage = (source: string) => checkPlacementGuards([{ file: PAGE_FILE, source: `${header}\n${source}` }], [], []).violations;

    it('取り直しの関数を作る hook の、取り直しの経路から呼ぶ取得が順序を 1 つも見ない (直す前の useHomeData の fetchNutritionAnalysis) は赤', () => {
      const source = `export const useX = () => {
        const homeStream = ${FETCH_STREAM_HOOK}();
        const adviceStream = ${FETCH_STREAM_HOOK}();
        const fetchAdvice = async () => {
          ADVICE_BEGIN
          const res = await fetch('/api/advice');
          ADVICE_ORDER
          if (res.ok) setAdvice(await res.json());
        };
        const fetchHome = async (ticket) => {
          const order = homeStream.begin(ticket);
          const res = await fetch('/api/home');
          order.place(() => setHome(res));
          fetchAdvice();
        };
        return { refetch: (ticket) => fetchHome(ticket) };
      };`;
      const delegatedHook = [{ file: PAGE_FILE, marker: 'writes', refetch: 'refetch', definedIn: HOOK_FILE }];
      const run = (adviceBegin: string, adviceOrder: string) =>
        checkPlacementGuards(
          [{ file: HOOK_FILE, source: source.replaceAll('ADVICE_BEGIN', adviceBegin).replaceAll('ADVICE_ORDER', adviceOrder) }],
          [],
          delegatedHook,
        ).violations;
      expect(run('', '')).toEqual([expect.stringMatching(/useX\.ts:4: 取り直しの経路の取得 fetchAdvice が、.*setAdvice \(8 行\)/)]);
      // 直した形: 自分の取得の流れで始め、応答を待ったあとに最後に始めた読み取りかを見る
      expect(run('const order = adviceStream.begin();', 'if (!order.isLatest()) return;')).toEqual([]);
    });

    it('then に渡した関数の中で応答を置くのに順序を見ない取り直しは赤', () => {
      expect(
        checkPage(`function Page() {
          const load = useCallback((ticket) => {
            fetch('/x').then((res) => res.json()).then((data) => setItems(data));
          }, []);
          ${DATA_REFETCH_HOOK}(load);
        }`),
      ).toEqual([expect.stringMatching(/:4: 取り直しの経路の取得 無名の関数 が、.*setItems \(4 行\)/)]);
    });

    it('取り直しそのものが応答を待つ前に立てた印を finally で下ろすところは数えない (家族・譲渡の承諾の画面)。それ以外の setter は赤', () => {
      const source = `function Page() {
        const refetchAfterAiConsultation = async (ticket) => {
          setAiRefetching(true);
          try {
            await load(ticket);
          } finally {
            FINALLY
          }
        };
        ${DATA_REFETCH_HOOK}(refetchAfterAiConsultation);
      }`;
      expect(checkPage(source.replaceAll('FINALLY', 'setAiRefetching(false);'))).toEqual([]);
      expect(checkPage(source.replaceAll('FINALLY', 'setAiRefetching(false); setItems([]);'))).toEqual([
        expect.stringMatching(/:3: 取り直しの経路の取得 refetchAfterAiConsultation が、応答が届いたあとに setItems \(8 行\) で/),
      ]);
    });
  });
});
