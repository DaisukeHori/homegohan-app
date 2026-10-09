/**
 * T15 (#1154) 受け付けたあとに同意の判定で止めた失敗を、画面が「同意が必要です」の案内にする (読む側) — contract + 挙動テスト
 *
 * 献立の生成・買い物リストの作り直しは、受け付けたあとにサーバーが同意の判定で止めると、リクエストの行の失敗の欄
 * (weekly_menu_requests.error_message / shopping_list_requests.result.error) に人向けの文を書いて失敗にする
 * (書く側は tests/ai-consent-stored-failure.test.ts)。画面はその欄を受けたら、文を
 * handleStoredAiConsentFailure (Web: src/lib/ai/consent-required.ts / アプリ: apps/mobile/src/lib/ai-consent.ts) に通し、
 * 「同意が必要です」なら同意画面へ案内して、自分のエラー表示は出さない。
 * 失敗を表示する場所は画面ごとに書く作りなので、場所を足したときに通し忘れやすい (前の周の指摘の型)。そこで、
 *
 *   1. 構文木の検査 (Web とアプリの全部): 非同期のリクエストの状態を読むファイルの中で、失敗の欄を読む場所
 *      (.error_message / .errorMessage / .result.error。分割代入は、その変数を使う場所) は、次のどれか:
 *        (a) その場所を含む関数が、見分ける関数 (handleStoredAiConsentFailure) か、その関数を自分の中で直接呼ぶ
 *            同じファイルの関数 (finishImprove・handleFailed など。以下「通す関数」) を呼んでいる
 *        (b) その場所が、見分ける関数か通す関数の引数の中にある
 *        (c) その場所が、週の献立の画面の失敗パネルへ入る GEN_FAIL の引数の中にある
 *            (失敗パネルの文は useAiConsentGenerationFailure を通してから出す。ROUTED_FAILURE_DISPATCH と下の it で検査する)
 *        (d) 下の PASS_THROUGH に理由つきで載っている (値を呼び出し元へ渡すだけ。渡した先も検査する)
 *   2. 挙動: Web の見分ける関数と、週の献立の画面の失敗パネルの文 (useAiConsentGenerationFailure) が、
 *      「同意が必要です」の文のときだけ同意画面を出し、失敗パネルを出さずに失敗をクリアする
 * を確かめる。アプリの挙動は apps/mobile の jest (lib/ai-consent.test.ts・menus-weekly/use-v4-menu-generation.test.tsx) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { act, createElement, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  AI_CONSENT_REQUIRED_CODE,
  AI_CONSENT_REQUIRED_MESSAGE,
} from '../supabase/functions/_shared/ai-consent';
import { AI_CONSENT_REQUIRED_EVENT, handleStoredAiConsentFailure } from '../src/lib/ai/consent-required';
import {
  aiGenerationReducer,
  initialAiGenerationState,
  useAiConsentGenerationFailure,
  type AiGenerationAction,
  type AiGenerationState,
} from '../src/app/(main)/menus/weekly/_state';

// React の act を jsdom で使う
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = path.resolve(__dirname, '..');

/** 走査するディレクトリ (Web の画面・部品・フック と アプリの全部) */
const SCAN_DIRS = ['src/app/(main)', 'src/components', 'src/hooks', 'apps/mobile/app', 'apps/mobile/src'];

/** 非同期のリクエストの状態を読むファイルの目印 (コードの文字列の中にある) */
const SOURCE_MARKERS = ['weekly_menu_requests', 'shopping_list_requests', '/api/ai/menu/weekly/status', '/api/shopping-list/regenerate/status'];
/** 同じく目印になる呼び出し (生成のフックの進み具合の購読) */
const SOURCE_CALLS = ['subscribeToProgress'];

/** 非同期のリクエストの状態を読むファイル (足した・消したら、ここも直す) */
const READER_FILES = [
  'apps/mobile/app/menus/weekly/index.tsx',
  'apps/mobile/app/shopping-list/index.tsx',
  'apps/mobile/src/hooks/useV4MenuGeneration.ts',
  'apps/mobile/src/lib/realtime.ts',
  'src/app/(main)/menus/weekly/page.tsx',
  'src/components/AIChatBubble.tsx',
  'src/hooks/useV4MenuGeneration.ts',
];

/** 見分ける関数 */
const HANDLER = 'handleStoredAiConsentFailure';

/**
 * 失敗パネルへ入る生成の失敗 (GEN_FAIL) を出すファイル → その dispatch の名前。
 * 失敗パネルの文は useAiConsentGenerationFailure(aiGen.generationFailedError, dispatch) を通してから出すこと (下の it で検査する)
 */
const ROUTED_FAILURE_DISPATCH: Record<string, string> = {
  'src/app/(main)/menus/weekly/page.tsx': 'dispatchAiGen',
};

/**
 * 失敗の欄を読むが、値を呼び出し元へ渡すだけの関数 (ファイル::関数名) → 理由。
 * 渡した先は、それぞれの読む場所としてこの検査の対象になる (onError を渡す側は下の it で検査する)
 */
const PASS_THROUGH: Record<string, string> = {
  'src/hooks/useV4MenuGeneration.ts::subscribeToProgress':
    'Realtime の行を onProgress (errorMessage) と onError に渡すだけ。onProgress の受け取り側の .errorMessage は読む場所として検査し、' +
    'onError を渡す側 (useV4MenuGeneration({ onError })) は下の it で、見分けることを検査する',
  'src/hooks/useV4MenuGeneration.ts::getRequestStatus': '行の値を返すだけ (表示しない)。受け取り側の .errorMessage は読む場所として検査する',
  'apps/mobile/src/hooks/useV4MenuGeneration.ts::getRequestStatus':
    '行の値を返すだけ (表示しない)。受け取り側の .errorMessage は読む場所として検査する',
};

// ─────────────────────────────────────────────
// 構文木の道具
// ─────────────────────────────────────────────

function parse(file: string): ts.SourceFile {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node);
}

const NAMING_HOOKS = new Set(['useCallback', 'useMemo']);

/** 関数の名前。`function f() {}` / `const f = () => {}` / `const f = useCallback(() => {})` / `{ f: () => {} }`。無名なら null */
function nameOf(fn: FunctionLike): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name.getText();
  if (ts.isFunctionExpression(fn) && fn.name) return fn.name.getText();
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (
    parent &&
    ts.isCallExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    NAMING_HOOKS.has(parent.expression.text) &&
    parent.parent &&
    ts.isVariableDeclaration(parent.parent) &&
    ts.isIdentifier(parent.parent.name)
  ) {
    return parent.parent.name.text;
  }
  return null;
}

/** node を含む、いちばん内側の関数 (無名でもよい) */
function innermostFunction(node: ts.Node): FunctionLike | null {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (isFunctionLike(cur)) return cur;
  }
  return null;
}

/** node を含む、名前のあるいちばん内側の関数 */
function namedOwner(node: ts.Node): FunctionLike | null {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (isFunctionLike(cur) && nameOf(cur)) return cur;
  }
  return null;
}

/** 呼び出しの関数の名前 (f(...) / obj.f(...) / obj.f?.(...)) */
function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** fn の中 (中の別の関数の中は除く) で、names のどれかを呼んでいるか */
function callsAnyDirectly(fn: FunctionLike, names: Set<string>): boolean {
  let found = false;
  walk(fn, (node) => {
    if (ts.isCallExpression(node) && innermostFunction(node) === fn) {
      const name = calleeName(node);
      if (name && names.has(name)) found = true;
    }
  });
  return found;
}

/** 見分ける関数と、そのファイルで見分ける関数を自分の中で直接呼ぶ関数 (通す関数) の名前 */
function handlerNames(sf: ts.SourceFile): Set<string> {
  const names = new Set([HANDLER]);
  const handler = new Set([HANDLER]);
  walk(sf, (node) => {
    if (isFunctionLike(node) && nameOf(node) && callsAnyDirectly(node, handler)) names.add(nameOf(node)!);
  });
  return names;
}

/** dispatch({ type: 'GEN_FAIL', ... }) の呼び出しか */
function isFailureDispatch(call: ts.CallExpression, dispatchName: string): boolean {
  if (calleeName(call) !== dispatchName) return false;
  const action = call.arguments[0];
  if (!action || !ts.isObjectLiteralExpression(action)) return false;
  return action.properties.some(
    (prop) =>
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === 'type' &&
      ts.isStringLiteralLike(prop.initializer) &&
      prop.initializer.text === 'GEN_FAIL',
  );
}

function isInsideType(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isTypeNode(cur) || ts.isInterfaceDeclaration(cur) || ts.isTypeAliasDeclaration(cur)) return true;
  }
  return false;
}

const FAILURE_FIELDS = new Set(['error_message', 'errorMessage']);

/** 失敗の欄を読む場所か (.error_message / .errorMessage / .result.error / 分割代入の { error_message }) */
function isFailureRead(node: ts.Node): boolean {
  if (isInsideType(node)) return false;
  if (ts.isPropertyAccessExpression(node)) {
    if (FAILURE_FIELDS.has(node.name.text)) return true;
    return node.name.text === 'error' && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'result';
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const key = node.propertyName ?? node.name;
    return ts.isIdentifier(key) && FAILURE_FIELDS.has(key.text);
  }
  return false;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      out.push(...listFiles(rel));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

/** コード (コメントではない) の中に目印があるか */
function readsAsyncRequests(sf: ts.SourceFile): boolean {
  let found = false;
  walk(sf, (node) => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      SOURCE_MARKERS.some((marker) => node.text.includes(marker))
    ) {
      found = true;
    }
    if (ts.isCallExpression(node) && SOURCE_CALLS.includes(calleeName(node) ?? '')) found = true;
  });
  return found;
}

interface ReadSite {
  file: string;
  line: number;
  text: string;
  owner: string | null;
  handled: boolean;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

/** node が、ok を満たす呼び出しの引数の中にあるか (node を含む関数の外までは上がらない) */
function isInsideArgumentOf(node: ts.Node, ok: (call: ts.CallExpression) => boolean): boolean {
  for (let cur: ts.Node | undefined = node; cur && !isFunctionLike(cur); cur = cur.parent) {
    const parent: ts.Node | undefined = cur.parent;
    if (parent && ts.isCallExpression(parent) && parent.arguments.some((arg) => arg === cur) && ok(parent)) return true;
  }
  return false;
}

/** 分割代入で受けた変数を、同じ関数の中で使う場所 */
function referencesOf(binding: ts.BindingElement, fn: FunctionLike): ts.Identifier[] {
  if (!ts.isIdentifier(binding.name)) return [];
  const name = binding.name.text;
  const refs: ts.Identifier[] = [];
  walk(fn, (node) => {
    if (ts.isIdentifier(node) && node.text === name && node !== binding.name && !ts.isBindingElement(node.parent)) refs.push(node);
  });
  return refs;
}

function readSites(file: string, sf: ts.SourceFile = parse(file)): ReadSite[] {
  const names = handlerNames(sf);
  const routedDispatch = ROUTED_FAILURE_DISPATCH[file];
  const isHandledCall = (call: ts.CallExpression) =>
    names.has(calleeName(call) ?? '') || Boolean(routedDispatch && isFailureDispatch(call, routedDispatch));
  const usageHandled = (node: ts.Node) => isInsideArgumentOf(node, isHandledCall);
  const sites: ReadSite[] = [];
  walk(sf, (node) => {
    if (!isFailureRead(node)) return;
    const inner = innermostFunction(node);
    const owner = namedOwner(node);
    let handled = Boolean(inner && callsAnyDirectly(inner, names));
    if (!handled) {
      if (ts.isBindingElement(node)) {
        const refs = inner ? referencesOf(node, inner) : [];
        handled = refs.length > 0 && refs.every(usageHandled);
      } else {
        handled = usageHandled(node);
      }
    }
    sites.push({ file, line: lineOf(sf, node), text: node.getText().slice(0, 60), owner: owner ? nameOf(owner) : null, handled });
  });
  return sites;
}

const readerFiles = SCAN_DIRS.flatMap(listFiles).filter((file) => readsAsyncRequests(parse(file)));
const sites = readerFiles.flatMap((file) => readSites(file));
const describeSite = (s: ReadSite) => `${s.file} L${s.line} ${s.owner ?? '(無名)'}: ${s.text}`;

// ─────────────────────────────────────────────
// 1. 構文木の検査
// ─────────────────────────────────────────────

describe('読む側の構文木の検査: 失敗の欄を読む場所は、同意で止めた文を見分ける', () => {
  it('非同期のリクエストの状態を読むファイルの一覧が READER_FILES と一致する (足した・消したら、この一覧も直す)', () => {
    expect([...readerFiles].sort()).toEqual([...READER_FILES].sort());
  });

  it('走査が空振りしていない (Web とアプリの両方で、失敗の欄を読む場所を見つけている)', () => {
    expect(sites.filter((s) => s.file.startsWith('src/')).length).toBeGreaterThanOrEqual(10);
    expect(sites.filter((s) => s.file.startsWith('apps/mobile/')).length).toBeGreaterThanOrEqual(4);
  });

  it('失敗の欄を読む場所は、見分ける関数を通す (通さないものは PASS_THROUGH に理由つきで載っている)', () => {
    const unhandled = sites.filter((s) => !s.handled && !(s.owner && PASS_THROUGH[`${s.file}::${s.owner}`]));
    expect(
      unhandled.map(describeSite),
      `同意で止めた文を見分けていない。失敗を表示する前に ${HANDLER}(文) を呼び、true なら自分のエラー表示を出さないこと`,
    ).toEqual([]);
  });

  it('PASS_THROUGH が古くなっていない (載せた関数に、見分けずに読む場所がある)', () => {
    for (const [key, reason] of Object.entries(PASS_THROUGH)) {
      const [file, owner] = key.split('::');
      expect(reason.length, key).toBeGreaterThan(0);
      const matched = sites.filter((s) => s.file === file && s.owner === owner);
      expect(matched.length, `${key}: 失敗の欄を読む場所がもう無い。分類から外すこと`).toBeGreaterThanOrEqual(1);
      expect(matched.some((s) => !s.handled), `${key}: 自分で見分けるようになった。分類から外すこと`).toBe(true);
    }
  });

  it('失敗パネルへ入る GEN_FAIL を出すファイルは、失敗パネルの文を useAiConsentGenerationFailure を通してから出す', () => {
    for (const [file, dispatchName] of Object.entries(ROUTED_FAILURE_DISPATCH)) {
      const sf = parse(file);
      const routed: string[] = [];
      const directReads: number[] = [];
      let failureDispatches = 0;
      walk(sf, (node) => {
        if (ts.isCallExpression(node) && calleeName(node) === 'useAiConsentGenerationFailure') {
          routed.push(node.arguments.map((arg) => arg.getText()).join(', '));
        }
        if (ts.isCallExpression(node) && isFailureDispatch(node, dispatchName)) failureDispatches += 1;
        // 失敗パネルの文 (generationFailedError) を、通さずに state から直接読む場所
        if (
          ts.isPropertyAccessExpression(node) &&
          node.name.text === 'generationFailedError' &&
          !isInsideArgumentOf(node, (call) => calleeName(call) === 'useAiConsentGenerationFailure')
        ) {
          directReads.push(lineOf(sf, node));
        }
      });
      expect(failureDispatches, `${file}: GEN_FAIL を出す場所が見つからない (走査の空振り)`).toBeGreaterThanOrEqual(1);
      expect(routed, `${file}: useAiConsentGenerationFailure(aiGen.generationFailedError, ${dispatchName}) が無い`).toEqual([
        `aiGen.generationFailedError, ${dispatchName}`,
      ]);
      expect(directReads, `${file}: 失敗パネルの文を通さずに読んでいる`).toEqual([]);
    }
  });

  it('Web の useV4MenuGeneration に onError を渡す画面は、onError の中で見分ける (subscribeToProgress が保存された文を渡すため)', () => {
    const consumers: string[] = [];
    for (const file of readerFiles.filter((f) => f.startsWith('src/'))) {
      const sf = parse(file);
      const names = handlerNames(sf);
      const routedDispatch = ROUTED_FAILURE_DISPATCH[file];
      walk(sf, (node) => {
        if (!ts.isCallExpression(node) || calleeName(node) !== 'useV4MenuGeneration') return;
        const options = node.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options)) return;
        for (const prop of options.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== 'onError') continue;
          const fn = prop.initializer;
          consumers.push(file);
          expect(isFunctionLike(fn), `${file}: onError は関数を直接書く`).toBe(true);
          let routed = false;
          walk(fn, (inner) => {
            if (ts.isCallExpression(inner) && routedDispatch && isFailureDispatch(inner, routedDispatch)) routed = true;
          });
          expect(
            callsAnyDirectly(fn as FunctionLike, names) || routed,
            `${file} L${lineOf(sf, prop)}: onError が見分ける関数を呼ばず、失敗パネルへも渡していない`,
          ).toBe(true);
        }
      });
    }
    expect(consumers.sort()).toEqual(['src/app/(main)/menus/weekly/page.tsx', 'src/components/AIChatBubble.tsx']);
  });

  it('検査そのものの確かめ: 見分けずに失敗の文を出す書き方 (前の周の不具合の形) を見つける', () => {
    const source = `
      const sub = supabase.channel("x").on("postgres_changes", { table: "weekly_menu_requests" }, (payload) => {
        if (payload.new.status === "failed") setError(payload.new.error_message ?? "失敗しました");
      });
      const poll = async () => { const { status, error_message } = await (await fetch("/api/ai/menu/weekly/status")).json(); alert(error_message); };
      const ok = async () => { const res = await api.get("/api/ai/menu/weekly/status"); if (handleStoredAiConsentFailure(res.errorMessage)) return; setError(res.errorMessage); };
      const handleFailed = (msg) => { if (handleStoredAiConsentFailure(msg)) return; Alert.alert("x", msg); };
      const viaHelper = (data) => handleFailed(data.result?.error || "x");
      const wrapper = () => { handleFailed("x"); };
      const notDirect = (data) => { wrapper(); setError(data.errorMessage); };
    `;
    const file = 'example.tsx';
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found = readSites(file, sf);
    // 通す関数 (handleFailed) を呼ぶだけの関数 (wrapper) を呼んでも、見分けたことにはならない
    expect(found.filter((s) => !s.handled).map((s) => s.text)).toEqual(['payload.new.error_message', 'error_message', 'data.errorMessage']);
    expect(found.filter((s) => s.handled).map((s) => s.text)).toEqual(['res.errorMessage', 'res.errorMessage', 'data.result?.error']);
    expect(readsAsyncRequests(sf)).toBe(true);
  });
});

// ─────────────────────────────────────────────
// 2. 挙動 (Web)
// ─────────────────────────────────────────────

describe('Web: 受け付けたあとに同意で止めた失敗の扱い', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  function cleanup() {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
  }

  afterEach(cleanup);

  function listenConsentEvent() {
    const events: Event[] = [];
    const listener = (event: Event) => events.push(event);
    window.addEventListener(AI_CONSENT_REQUIRED_EVENT, listener);
    return { events, stop: () => window.removeEventListener(AI_CONSENT_REQUIRED_EVENT, listener) };
  }

  /** 週の献立の画面と同じ組み方 (useReducer(aiGenerationReducer) + useAiConsentGenerationFailure) で、生成中に失敗を 1 回出す */
  function renderFailure(error: string) {
    const seen: { state: AiGenerationState | null; panel: string | null; dispatch: ((action: AiGenerationAction) => void) | null } = {
      state: null,
      panel: null,
      dispatch: null,
    };
    function Harness() {
      const [state, dispatch] = useReducer(aiGenerationReducer, { ...initialAiGenerationState, isGenerating: true });
      const panel = useAiConsentGenerationFailure(state.generationFailedError, dispatch);
      seen.state = state;
      seen.panel = panel;
      seen.dispatch = dispatch;
      return createElement('div', { 'data-panel': panel ?? '' });
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(createElement(Harness)));
    act(() => seen.dispatch!({ type: 'GEN_FAIL', payload: { error, requestId: 'req-1' } }));
    return seen;
  }

  it('handleStoredAiConsentFailure: 「同意が必要です」の文なら同意画面を出して true、それ以外は何もしないで false', () => {
    const { events, stop } = listenConsentEvent();
    try {
      expect(handleStoredAiConsentFailure(AI_CONSENT_REQUIRED_MESSAGE)).toBe(true);
      expect(events).toHaveLength(1);
      for (const stored of [AI_CONSENT_CHECK_FAILED_MESSAGE, AI_CONSENT_REQUIRED_CODE, 'stale_request_timeout', '', null, undefined]) {
        expect(handleStoredAiConsentFailure(stored)).toBe(false);
      }
      expect(events).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('週の献立の画面: 「同意が必要です」の失敗は同意画面を 1 回出し、失敗パネルを出さずに失敗をクリアし、生成中の表示を消す', () => {
    const { events, stop } = listenConsentEvent();
    try {
      const seen = renderFailure(AI_CONSENT_REQUIRED_MESSAGE);
      expect(events).toHaveLength(1);
      expect(seen.panel).toBeNull();
      expect(seen.state?.generationFailedError).toBeNull();
      expect(seen.state?.generationFailedRequestId).toBeNull();
      expect(seen.state?.isGenerating).toBe(false);
      expect(container?.querySelector('[data-panel]')?.getAttribute('data-panel')).toBe('');
    } finally {
      stop();
    }
  });

  it('週の献立の画面: それ以外の失敗 (一時的に使えないを含む) は、これまでどおり失敗パネルに出し、同意画面は出さない', () => {
    const { events, stop } = listenConsentEvent();
    try {
      for (const error of [AI_CONSENT_CHECK_FAILED_MESSAGE, '生成に失敗しました']) {
        const seen = renderFailure(error);
        expect(seen.panel).toBe(error);
        expect(seen.state?.generationFailedError).toBe(error);
        expect(container?.querySelector('[data-panel]')?.getAttribute('data-panel')).toBe(error);
        cleanup();
      }
      expect(events).toHaveLength(0);
    } finally {
      stop();
    }
  });
});
