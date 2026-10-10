/**
 * T15 (#1154) 外国の AI 事業者への提供の同意画面: AI の入口の contract テスト
 *
 * 未同意の利用者のデータは、サーバーが AI へ送る手前で止める (403 AI_CONSENT_REQUIRED。src/lib/ai/consent-guard.ts)。
 * 画面は、止められる前に同意画面を出し (useAiConsent の ensureAiConsent)、「同意しない」なら操作をやめる。
 * それでも止められたとき (状況が古い・別のタブで撤回したなど) は、aiFetch が全画面共通の同意画面 (AiConsentRequiredHost) を出す。
 * 画面ごとにフックを呼ぶ作りなので、入口を足したり直したりしたときに、呼び忘れ・描画し忘れが起きやすい。
 * そこで、AI の入口になっている画面のソースを TypeScript の構文木で読み (コメントや文字列の中は見ない)、次を確かめる。
 *
 *   1. useAiConsent() を呼び、ensureAiConsent と consentModal の両方を受け取っている
 *   2. consentModal を JSX で描画している
 *   3. 決めた関数が、AI の操作の前に ensureAiConsent() を呼んでいる
 *   4. AI の API (/api/ai/... と /api/shopping-list/regenerate) の呼び出しは、(a) 同じ関数の中で先に ensureAiConsent() を
 *      呼んでいる、または (b) 下の分類 (delegated / notSending / automatic) に理由つきで載っている
 *   5. 利用者の操作で AI に送る呼び出し (確認済み・delegated) は aiFetch を使う (止められたら同意画面を出すため)。
 *      画面を開くと自動で送る呼び出し (automatic) は fetch を使う (同意画面を勝手に出さない)
 *   6. ensureAiConsent() の戻り値が 'declined' なら AI に送らない (戻り値を比べている)。比べない呼び出しは理由つきで載せる
 *   7. 分類が古くならないこと (載せた関数が無くなった・AI の呼び出しが無くなったら失敗する)
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

interface EntryPoint {
  file: string;
  /** ensureAiConsent() を自分で呼んでいなければならない関数の名前 */
  mustEnsure: string[];
  /** この画面が fetch('/api/ai/...') を直接呼ばない (呼び出しを props で受け取る) なら false */
  directAiFetch?: boolean;
  /** AI の API を呼ぶが、同意の確認は呼び出し元の関数が先にしている関数 → 理由 (呼び出し元が確認していることも検査する) */
  delegated?: Record<string, string>;
  /** AI の API を呼ぶが、AI に新しいデータを送らない関数 (状態の確認・履歴・後始末など) → 理由 */
  notSending?: Record<string, string>;
  /** 画面を開くと自動で AI に送る処理 (利用者の操作で始まらない) → 理由 */
  automatic?: Record<string, string>;
  /** ensureAiConsent() の戻り値を見ない (「同意しない」でも続ける) 関数 → 理由 (続けても AI へは送られないこと) */
  continuesOnDecline?: Record<string, string>;
}

const ENTRY_POINTS: EntryPoint[] = [
  {
    // 食事の写真の解析 (食事・冷蔵庫・健康診断・体重計の写真)
    file: 'src/app/(main)/meals/new/page.tsx',
    mustEnsure: ['analyzeResolvedMode', 'analyzeByMode'],
    delegated: {
      analyzePhoto: 'analyzeResolvedMode が先に確認する',
      classifyPhoto: 'analyzeByMode が先に確認する (種類の判別も写真を送る)',
      analyzeFridge: 'analyzeResolvedMode が先に確認する',
      analyzeHealthCheckup: 'analyzeResolvedMode が先に確認する',
      analyzeWeightScale: 'analyzeResolvedMode が先に確認する',
    },
  },
  {
    // 健康診断・血液検査の画像の読み取り (OCR) と、保存時の AI コメントの作成
    file: 'src/app/(main)/health/checkups/new/page.tsx',
    // handleSave: 保存すると、サーバーが数値を AI に送って個別レビューを作る (画像を使わず手入力した人もここで確認を受ける)
    mustEnsure: ['handleUploadAndAnalyze', 'handleSave'],
    continuesOnDecline: {
      handleSave:
        '「同意しない」でも記録は保存する。サーバー (POST /api/health/checkups) は同意が無ければ AI のレビューを作らずに保存だけする',
    },
  },
  {
    // 冷蔵庫・パントリーの写真
    file: 'src/app/(main)/pantry/page.tsx',
    mustEnsure: ['handlePhotoSelect'],
  },
  {
    // 献立のリクエスト (冷蔵庫の写真の解析と、生成の依頼)
    file: 'src/app/(main)/menus/weekly/request/page.tsx',
    mustEnsure: ['handleImageUpload', 'handleSubmit'],
  },
  {
    // 週間献立: 写真の解析・献立の生成・再生成・改善・画像の生成
    file: 'src/app/(main)/menus/weekly/page.tsx',
    mustEnsure: [
      'handleFridgePhotoSelected',
      'handleGenerateWeekly',
      'handleGenerateSingleMeal',
      'handleRegenerateMeal',
      'analyzePhotoWithAI',
      'generateMealImage',
      'handleImprove',
      'regenerateShoppingList',
    ],
    notSending: {
      restoreGeneration: '生成の進み具合を確認するだけ (status)',
      checkPendingRequests: '途中の生成の確認と後始末だけ (pending / status / cleanup)',
      fetchPlan: '途中の生成の確認だけ (pending)',
      handleCancelGeneration: '生成の追跡を止めたことをサーバーに知らせるだけ (status)',
      handleV4Generate: 'V4GenerateModal の runGenerate が確認してから呼ぶ。ここの fetch は生成の進み具合の確認だけ (status)',
      poll: '生成の進み具合の確認だけ (status)',
      pollRegenerate: '再生成の進み具合の確認だけ (status)',
      pollImprove: '献立の改善 (handleImprove が確認してから依頼する) の進み具合の確認だけ (status)',
    },
    automatic: {
      fetchAiHint: '献立が読み込まれると自動でヒントを頼む (#1327 以降、サーバーは AI を呼ばず定型のヒントを返す)',
      fetchNutritionFeedback:
        '栄養の詳細を開くと自動で AI に栄養士のコメントを頼む。同意が無ければサーバーが 403 で止め、画面は同意画面を出さずに案内の一文だけを出す',
    },
  },
  {
    // AI 相談 (チャット)
    file: 'src/components/AIChatBubble.tsx',
    mustEnsure: ['sendMessage', 'generateDayMenu', 'executeAction'],
    notSending: {
      fetchSessions: '相談の一覧を読むだけ',
      fetchMessages: '相談の履歴を読むだけ',
      createNewSession: '空の相談の枠を作るだけ (AI には送らない。最初のメッセージは sendMessage が確認してから送る)',
      rejectAction: 'AI の返事に付いた提案を断るだけ (DELETE。何も送らない)',
      toggleImportant: '重要マークを付け外しするだけ',
      closeSession: '相談を閉じるだけ (すでに確認を済ませた相談の要約)',
    },
  },
  {
    // 献立の生成 (V4)
    file: 'src/components/ai-assistant/V4GenerateModal.tsx',
    mustEnsure: ['runGenerate'],
    // 生成の API は onGenerate (props) で呼び出し元が呼ぶ。この画面は呼ぶ前に確認する
    directAiFetch: false,
  },
];

// ─────────────────────────────────────────────
// 構文木の道具
// ─────────────────────────────────────────────

function parse(file: string): ts.SourceFile {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** 関数の名前。`function f() {}` / `const f = () => {}` / `{ f: () => {} }` / `f() {}` のどれか。無名なら null */
function nameOf(fn: FunctionLike): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name.getText();
  if (ts.isFunctionExpression(fn) && fn.name) return fn.name.getText();
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  // const f = useCallback(async () => {...}, [...])
  if (
    parent &&
    ts.isCallExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === 'useCallback' &&
    parent.parent &&
    ts.isVariableDeclaration(parent.parent) &&
    ts.isIdentifier(parent.parent.name)
  ) {
    return parent.parent.name.text;
  }
  return null;
}

/** node を含む関数を、内側から外側へ順に返す */
function enclosingFunctions(node: ts.Node): FunctionLike[] {
  const out: FunctionLike[] = [];
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (isFunctionLike(cur)) out.push(cur);
  }
  return out;
}

/** 名前のある、いちばん内側の関数の名前 (無名の関数の中なら、その外側の名前のある関数) */
function ownerName(node: ts.Node): string | null {
  for (const fn of enclosingFunctions(node)) {
    const name = nameOf(fn);
    if (name) return name;
  }
  return null;
}

function isCallTo(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
}

function callsIn(root: ts.Node, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  walk(root, (node) => {
    if (isCallTo(node, name)) out.push(node);
  });
  return out;
}

/**
 * node より前 (ソースの位置) に、fn 自身の本体で ensureAiConsent() を呼んでいるか。
 * fn の中の別の関数 (兄弟の handler など) の中の呼び出しは数えない。
 * 数えると、コンポーネントのどこかで 1 回呼んでいるだけで、確認していない別の関数まで「確認済み」に見えてしまう。
 */
function ensuresBefore(fn: FunctionLike, node: ts.Node): boolean {
  return callsIn(fn, 'ensureAiConsent').some(
    (call) => enclosingFunctions(call)[0] === fn && call.getStart() < node.getStart(),
  );
}

/** node の外側の関数のどれかが、node より前に ensureAiConsent() を呼んでいるか */
function isGuarded(node: ts.Node): boolean {
  return enclosingFunctions(node).some((fn) => ensuresBefore(fn, node));
}

interface AiFetchSite {
  owner: string | null;
  url: string;
  guarded: boolean;
  line: number;
  /** aiFetch (止められたら同意画面を出す) で呼んでいるか */
  viaAiFetch: boolean;
}

/** AI へ送る API の URL か (/api/ai/... と、買い物リストの作り直し。作り直しの進み具合 (/status) は AI へ送らない) */
function isAiUrl(url: string): boolean {
  return url.startsWith('/api/ai/') || url === '/api/shopping-list/regenerate';
}

/** AI の API の fetch / aiFetch の呼び出しを全部集める (文字列・テンプレートで URL が書かれているもの) */
function aiFetchSites(sf: ts.SourceFile): AiFetchSite[] {
  const sites: AiFetchSite[] = [];
  walk(sf, (node) => {
    const viaAiFetch = isCallTo(node, 'aiFetch');
    if (!(viaAiFetch || isCallTo(node, 'fetch')) || node.arguments.length === 0) return;
    const arg = node.arguments[0];
    if (!ts.isStringLiteralLike(arg) && !ts.isTemplateExpression(arg)) return;
    const url = arg.getText().slice(1, -1).split('?')[0];
    if (!isAiUrl(url)) return;
    sites.push({
      owner: ownerName(node),
      url,
      guarded: isGuarded(node),
      line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      viaAiFetch,
    });
  });
  return sites;
}

function findFunctions(sf: ts.SourceFile, name: string): FunctionLike[] {
  const out: FunctionLike[] = [];
  walk(sf, (node) => {
    if (isFunctionLike(node) && nameOf(node) === name) out.push(node);
  });
  return out;
}

// ─────────────────────────────────────────────
// テスト
// ─────────────────────────────────────────────

describe.each(ENTRY_POINTS)('AI の入口の同意画面: $file', (entry) => {
  const sf = parse(entry.file);
  const classified = {
    delegated: entry.delegated ?? {},
    notSending: entry.notSending ?? {},
    automatic: entry.automatic ?? {},
  };

  it('useAiConsent を import し、ensureAiConsent と consentModal の両方を受け取っている', () => {
    const importsHook = sf.statements.some(
      (s) =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === '@/hooks/useAiConsent' &&
        (s.importClause?.namedBindings &&
          ts.isNamedImports(s.importClause.namedBindings) &&
          s.importClause.namedBindings.elements.some((e) => e.name.text === 'useAiConsent')),
    );
    expect(importsHook, 'import { useAiConsent } from "@/hooks/useAiConsent" が無い').toBe(true);

    const destructured: string[] = [];
    walk(sf, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        isCallTo(node.initializer, 'useAiConsent')
      ) {
        for (const element of node.name.elements) destructured.push(element.name.getText());
      }
    });
    expect(destructured).toEqual(expect.arrayContaining(['ensureAiConsent', 'consentModal']));
  });

  it('consentModal を JSX で描画している (描画し忘れると、同意の画面が出ないまま 1 秒待たせてしまう)', () => {
    let rendered = 0;
    walk(sf, (node) => {
      if (ts.isJsxExpression(node) && node.expression && ts.isIdentifier(node.expression) && node.expression.text === 'consentModal') {
        rendered += 1;
      }
    });
    expect(rendered, '{consentModal} が JSX に無い').toBeGreaterThanOrEqual(1);
  });

  it.each(entry.mustEnsure)('%s は AI の操作の前に ensureAiConsent() を呼ぶ', (name) => {
    const fns = findFunctions(sf, name);
    expect(fns.length, `関数 ${name} が見つからない`).toBeGreaterThanOrEqual(1);
    for (const fn of fns) {
      expect(callsIn(fn, 'ensureAiConsent').length, `${name} が ensureAiConsent() を呼んでいない`).toBeGreaterThanOrEqual(1);
    }
  });

  it('AI の API の呼び出しは、先に確認しているか、理由つきで分類されている', () => {
    const sites = aiFetchSites(sf);
    if (entry.directAiFetch === false) {
      expect(sites, '直接の AI の呼び出しは無いはず (directAiFetch: false)').toEqual([]);
      return;
    }
    expect(sites.length, 'AI の呼び出しが 1 つも見つからない (走査が壊れている?)').toBeGreaterThanOrEqual(1);

    const classifiedNames = new Set([
      ...Object.keys(classified.delegated),
      ...Object.keys(classified.notSending),
      ...Object.keys(classified.automatic),
    ]);
    const unclassified = sites.filter((s) => !s.guarded && !(s.owner && classifiedNames.has(s.owner)));
    expect(
      unclassified.map((s) => `L${s.line} ${s.owner ?? '(無名)'}: ${s.url}`),
      '確認していない AI の呼び出しがある。useAiConsent の ensureAiConsent() を先に呼ぶか、このテストの分類に理由つきで載せること',
    ).toEqual([]);
  });

  it('利用者の操作で AI に送る呼び出しは aiFetch、画面を開くと自動で送る呼び出しは fetch を使う', () => {
    const sites = aiFetchSites(sf);
    const isIn = (kind: Record<string, string>, owner: string | null) =>
      owner !== null && Object.prototype.hasOwnProperty.call(kind, owner);
    const sending = sites.filter(
      (s) => (s.guarded || isIn(classified.delegated, s.owner)) && !isIn(classified.notSending, s.owner),
    );
    expect(
      sending.filter((s) => !s.viaAiFetch).map((s) => `L${s.line} ${s.owner ?? '(無名)'}: ${s.url}`),
      '利用者の操作で AI に送る呼び出しが fetch のまま。止められたときに同意画面が出ないので aiFetch にすること',
    ).toEqual([]);
    const automatic = sites.filter(
      (s) => s.owner !== null && Object.prototype.hasOwnProperty.call(classified.automatic, s.owner),
    );
    expect(
      automatic.filter((s) => s.viaAiFetch).map((s) => `L${s.line} ${s.owner}: ${s.url}`),
      '画面を開くと自動で送る呼び出しが aiFetch になっている (同意画面を勝手に出してしまう)',
    ).toEqual([]);
  });

  it('ensureAiConsent() の戻り値が "declined" なら AI に送らない (戻り値を比べている)', () => {
    const continues = entry.continuesOnDecline ?? {};
    const notCompared: string[] = [];
    walk(sf, (node) => {
      if (!isCallTo(node, 'ensureAiConsent')) return;
      let cur: ts.Node = node.parent;
      if (cur && ts.isAwaitExpression(cur)) cur = cur.parent;
      if (cur && ts.isParenthesizedExpression(cur)) cur = cur.parent;
      const compared =
        cur &&
        ts.isBinaryExpression(cur) &&
        cur.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        ts.isStringLiteralLike(cur.right) &&
        cur.right.text === 'declined';
      const owner = ownerName(node);
      if (!compared && !(owner && Object.prototype.hasOwnProperty.call(continues, owner))) {
        notCompared.push(`L${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${owner ?? '(無名)'}`);
      }
    });
    expect(
      notCompared,
      'ensureAiConsent() の戻り値を見ていない。「同意しない」なら送らないよう、=== "declined" で比べて処理をやめること',
    ).toEqual([]);
    for (const name of Object.keys(continues)) {
      expect(findFunctions(sf, name).length, `continuesOnDecline: 関数 ${name} が見つからない`).toBeGreaterThanOrEqual(1);
    }
  });

  it('分類 (delegated / notSending / automatic) が古くなっていない', () => {
    const sites = aiFetchSites(sf);
    for (const kind of ['delegated', 'notSending', 'automatic'] as const) {
      for (const name of Object.keys(classified[kind])) {
        expect(findFunctions(sf, name).length, `${kind}: 関数 ${name} が見つからない`).toBeGreaterThanOrEqual(1);
        expect(
          sites.some((s) => s.owner === name),
          `${kind}: ${name} に AI の API の呼び出しが無い。分類から外すこと`,
        ).toBe(true);
      }
    }
  });

  it('delegated の関数は、確認してから呼ぶ関数だけが呼んでいる', () => {
    for (const name of Object.keys(classified.delegated)) {
      const calls = callsIn(sf, name).filter((call) => {
        // 自分自身の定義の中の呼び出し (再帰) は数えない
        return !enclosingFunctions(call).some((fn) => nameOf(fn) === name);
      });
      // fetch の呼び出しを持つ関数が、props などから呼ばれる (JSX の onClick={...} など) 場合は、参照も数える
      const references: ts.Node[] = [];
      walk(sf, (node) => {
        if (
          ts.isIdentifier(node) &&
          node.text === name &&
          !(node.parent && isFunctionLike(node.parent) && nameOf(node.parent) === name) &&
          !(node.parent && ts.isVariableDeclaration(node.parent) && node.parent.name === node)
        ) {
          references.push(node);
        }
      });
      expect(references.length, `${name} を呼ぶところが無い`).toBeGreaterThanOrEqual(1);
      for (const call of calls) {
        expect(isGuarded(call), `${name} を、確認する前に呼んでいる (L${sf.getLineAndCharacterOfPosition(call.getStart()).line + 1})`).toBe(true);
      }
    }
  });
});
