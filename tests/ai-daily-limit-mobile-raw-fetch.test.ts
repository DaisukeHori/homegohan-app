/**
 * #1149 (T40) アプリ (apps/mobile): getApi() を通らない生の fetch で AI の API を呼ぶ場所が、
 * 「今日の AI の利用回数の上限に達しました」(429 AI_DAILY_LIMIT) を固定の文にしているか — 見張りのテスト
 *
 * アプリは getApi() (apps/mobile/src/lib/api.ts の withFriendlyErrors) で 429 AI_DAILY_LIMIT を固定の文の
 * AiDailyLimitError に置き換える。生の fetch (ストリーミングで受ける AI 相談の送信など) にはこれが効かないので、
 * 失敗の応答から errorOfFailedResponse (apps/mobile/src/lib/failed-response.ts) で Error を作って投げる決まりにした
 * (R1 の指摘: AI 相談の 2 か所が `HTTP 429: {...JSON...}` をそのまま出し、1 食の作り直しは何も出さなかった)。
 * errorOfFailedResponse は 503 の緊急停止・メンテナンス中 (#1457) も固定の文にする。AI 相談を生の fetch で呼ぶファイルが
 * 503 を固定の文にしているかは tests/mobile-service-unavailable-raw-fetch.test.ts が別に見る (このテストは 429 の分類を見る)。
 *
 * このテストが確かめること:
 *   1. apps/mobile の app と src (テストを除く) の生の fetch の呼び出しを構文木で全部集め (コメントは見ない。
 *      同じ名前のローカルの関数 `const fetch = ...` の呼び出しは除く)、含む関数 (名前のある、いちばん内側の関数) ごとに
 *      下の RAW_FETCHES の分類と一致する (足した・消したら、ここで気づく)
 *   2. 分類で呼び先とした route.ts が、429 AI_DAILY_LIMIT を返す (aiDailyLimitResponse を呼ぶ) なら、その関数は
 *      errorOfFailedResponse を呼んでいる
 *   3. 分類の呼び先の URL の終わりの部分が、そのファイルに書かれている (分類が別の API を指したまま古くならない)
 *   4. (#1486) アプリの API を呼ぶ生の fetch の関数 (分類の route が null でないもの) は、すべて失敗の応答を
 *      errorOfFailedResponse か serviceUnavailableMessageOf で読む (メンテナンス中の 503 は、どの API でも返りうる。
 *      読まないと、英語の「DELETE failed: 503」や汎用の失敗の文になる)
 *
 * 限界 (見張りであって証明ではない):
 *   - 呼び先の route は人が分類する。3 はファイルに URL の終わりの部分の文字列があることしか見ないので、
 *     同じファイルが似た URL を別の関数で呼ぶと、取り違えを見逃しうる
 *   - 「429 を返すか」は route.ts の中で aiDailyLimitResponse を呼ぶかで見る。route が別の名前の関数で 429 を返すと見逃す
 *   - errorOfFailedResponse を呼んでいることは見るが、その Error を画面がどう出すかは見ない
 *     (画面の挙動は jest の apps/mobile/__tests__/ai/chat-daily-limit・ai/advisor-sheet-daily-limit・
 *     menus-weekly/regenerate-meal-daily-limit が確かめる)
 *   - fetch を包んだ自前の関数 (fetch を引数で受け取るなど) を通す呼び出しは数えない
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MOBILE_ROOT = 'apps/mobile';
const MOBILE_SOURCE_DIRS = ['app', 'src'];
const LIMIT_ERROR_FACTORY = 'errorOfFailedResponse';
const LIMIT_RESPONSE_BUILDER = 'aiDailyLimitResponse';
/** 失敗の応答を、止められた理由 (503 のメンテナンス中など) の固定の文にする関数 (apps/mobile/src/lib/failed-response.ts・service-unavailable.ts。#1486) */
const STOPPED_RESPONSE_READERS = ['errorOfFailedResponse', 'serviceUnavailableMessageOf'];

/**
 * 生の fetch を呼ぶ関数 (apps/mobile からの相対パス::関数名) → 呼び先の route.ts (リポジトリからの相対パス。
 * アプリの API でないものは null)・その呼び先が 429 AI_DAILY_LIMIT を返すか (returnsDailyLimit。2b が route.ts と突き合わせる)・
 * 分類の理由
 */
const RAW_FETCHES: Record<string, { route: string | null; returnsDailyLimit: boolean; reason: string }> = {
  'app/ai/[sessionId].tsx::send': {
    route: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts',
    returnsDailyLimit: true,
    reason: 'AI 相談の送信 (ストリーミング)。上限に達すると 429',
  },
  'src/components/ai/AIAdvisorSheet.tsx::sendMessage': {
    route: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts',
    returnsDailyLimit: true,
    reason: 'AI 相談シートの送信 (ストリーミング)。上限に達すると 429',
  },
  'src/components/ai/AIAdvisorSheet.tsx::archiveSession': {
    route: 'src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts',
    returnsDailyLimit: false,
    reason: '相談を閉じる。上限に達していれば要約を省いて 200 (aiSkipped: AI_DAILY_LIMIT) を返すので、429 にはならない',
  },
  'src/components/menu/RegenerateMealModal.tsx::submit': {
    route: 'src/app/api/ai/menu/meal/regenerate/route.ts',
    returnsDailyLimit: true,
    reason: '1 食の作り直し。上限に達すると 429',
  },
  'app/menus/weekly/index.tsx::fetchJapaneseHolidays': {
    route: null,
    returnsDailyLimit: false,
    reason: '祝日の一覧 (外部の公開データ)。アプリの API ではない',
  },
  'app/menus/weekly/index.tsx::toggleMealCompletion': {
    route: 'src/app/api/meal-plans/meals/[id]/route.ts',
    returnsDailyLimit: false,
    reason: '食事の完了の切り替え (PATCH)。画像の生成で上限に達しても 200 (aiSkipped) で、429 にはならない',
  },
  'app/menus/weekly/index.tsx::deleteMeal': {
    route: 'src/app/api/meal-plans/meals/[id]/route.ts',
    returnsDailyLimit: false,
    reason: '食事の削除 (DELETE)。AI を使わない',
  },
  'app/(tabs)/settings.tsx::handleExportJson': {
    route: 'src/app/api/account/export/route.ts',
    returnsDailyLimit: false,
    reason: 'アカウントのデータの書き出し。AI を使わない',
  },
  'app/(tabs)/settings.tsx::handleExportCsv': {
    route: 'src/app/api/export/meals/route.ts',
    returnsDailyLimit: false,
    reason: '食事の CSV の書き出し。AI を使わない',
  },
  'app/shopping-list/index.tsx::onPress': {
    route: 'src/app/api/shopping-list/route.ts',
    returnsDailyLimit: false,
    reason: '買い物リストの全削除 (DELETE。確認の Alert の「全削除」ボタンの onPress)。AI を使わない',
  },
  'src/components/menu/ShoppingListModal.tsx::onPress': {
    route: 'src/app/api/shopping-list/route.ts',
    returnsDailyLimit: false,
    reason: '買い物リストの全削除 (DELETE。確認の Alert の「全削除」ボタンの onPress)。AI を使わない',
  },
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

/** フックの引数に渡した関数を、代入先の変数の名前で呼ぶ (const f = useCallback(() => ...)) */
const NAMING_HOOKS = new Set(['useCallback', 'useMemo']);

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

/** node を含む、名前のあるいちばん内側の関数 */
function ownerOf(node: ts.Node): FunctionLike | null {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (isFunctionLike(cur) && nameOf(cur)) return cur;
  }
  return null;
}

/** その場所から見える範囲で、`fetch` という名前のローカルの変数・関数が宣言されているか (祝日の `const fetch = async () => ...` など) */
function isShadowedFetch(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    const statements = ts.isBlock(cur) || ts.isSourceFile(cur) ? cur.statements : null;
    if (!statements) continue;
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'fetch') return true;
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === 'fetch') return true;
        }
      }
    }
  }
  return false;
}

function callsFunction(root: ts.Node, name: string): boolean {
  let found = false;
  walk(root, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found = true;
  });
  return found;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      out.push(...listFiles(rel));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(rel);
    }
  }
  return out;
}

interface RawFetch {
  key: string;
  owner: FunctionLike | null;
  line: number;
}

function collectRawFetches(): RawFetch[] {
  const out: RawFetch[] = [];
  for (const dir of MOBILE_SOURCE_DIRS) {
    for (const file of listFiles(`${MOBILE_ROOT}/${dir}`)) {
      const sf = parse(file);
      walk(sf, (node) => {
        if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'fetch') return;
        if (isShadowedFetch(node)) return;
        const owner = ownerOf(node);
        const rel = file.slice(MOBILE_ROOT.length + 1);
        out.push({
          key: `${rel}::${owner ? nameOf(owner) : '(関数の外)'}`,
          owner,
          line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
      });
    }
  }
  return out;
}

/** route.ts が 429 AI_DAILY_LIMIT を返す (aiDailyLimitResponse を呼ぶ) か */
function returnsDailyLimit(routeFile: string): boolean {
  return callsFunction(parse(routeFile), LIMIT_RESPONSE_BUILDER);
}

/** src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts → '/messages' (最後の動的な部分より後ろ。無ければ全体) */
function urlTailOf(routeFile: string): string {
  const segments = path.dirname(routeFile).slice('src/app'.length).split('/').filter(Boolean);
  const lastDynamic = segments.map((s) => /^\[.*\]$/.test(s)).lastIndexOf(true);
  const tail = lastDynamic >= 0 ? segments.slice(lastDynamic + 1) : segments;
  return tail.length > 0 ? `/${tail.join('/')}` : `/${segments.slice(0, lastDynamic).join('/')}/`;
}

// ─────────────────────────────────────────────
// 検査
// ─────────────────────────────────────────────

describe('アプリの生の fetch と 429 AI_DAILY_LIMIT (#1149)', () => {
  const fetches = collectRawFetches();

  it('1. 生の fetch を呼ぶ関数の一覧が、分類 (RAW_FETCHES) と一致する', () => {
    const found = [...new Set(fetches.map((f) => f.key))].sort();
    expect(found).toEqual(Object.keys(RAW_FETCHES).sort());
  });

  it('2. 429 AI_DAILY_LIMIT を返す API を生の fetch で呼ぶ関数は、errorOfFailedResponse を呼ぶ', () => {
    const limitedKeys = Object.entries(RAW_FETCHES)
      .filter(([, entry]) => entry.returnsDailyLimit)
      .map(([key]) => key);
    // 分類が空回りしていない (上限で 429 を返す呼び先が実際にある)
    expect(limitedKeys.length).toBeGreaterThan(0);

    const missing = fetches
      .filter((f) => limitedKeys.includes(f.key))
      .filter((f) => !f.owner || !callsFunction(f.owner, LIMIT_ERROR_FACTORY))
      .map((f) => `${f.key} (${f.line} 行目)`);
    expect(missing).toEqual([]);
  });

  it('2b. 分類の returnsDailyLimit が、呼び先の route.ts (aiDailyLimitResponse を呼ぶか) と一致する (分類が古くならない)', () => {
    const mismatched = Object.entries(RAW_FETCHES)
      .filter(([, entry]) => (entry.route === null ? entry.returnsDailyLimit : returnsDailyLimit(entry.route) !== entry.returnsDailyLimit))
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });

  it('4. (#1486) アプリの API を生の fetch で呼ぶ関数は、すべて失敗の応答を errorOfFailedResponse / serviceUnavailableMessageOf で読む', () => {
    const appApiKeys = Object.entries(RAW_FETCHES)
      .filter(([, entry]) => entry.route !== null)
      .map(([key]) => key);
    // 分類が空回りしていない (アプリの API を呼ぶ生の fetch が実際にある。#1486 で直した 6 か所を含む)
    expect(appApiKeys).toEqual(
      expect.arrayContaining([
        'app/menus/weekly/index.tsx::deleteMeal',
        'app/menus/weekly/index.tsx::toggleMealCompletion',
        'app/(tabs)/settings.tsx::handleExportJson',
        'app/(tabs)/settings.tsx::handleExportCsv',
        'app/shopping-list/index.tsx::onPress',
        'src/components/menu/ShoppingListModal.tsx::onPress',
      ]),
    );

    const missing = fetches
      .filter((f) => appApiKeys.includes(f.key))
      .filter(({ owner }) => !owner || !STOPPED_RESPONSE_READERS.some((name) => callsFunction(owner, name)))
      .map((f) => `${f.key} (${f.line} 行目)`);
    expect(missing).toEqual([]);
  });

  it('3. 分類の呼び先の route.ts があり、その URL の終わりの部分がファイルに書かれている', () => {
    const problems: string[] = [];
    for (const [key, entry] of Object.entries(RAW_FETCHES)) {
      if (entry.route === null) continue;
      if (!fs.existsSync(path.join(ROOT, entry.route))) {
        problems.push(`${key}: ${entry.route} が無い`);
        continue;
      }
      const file = `${MOBILE_ROOT}/${key.split('::')[0]}`;
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const tail = urlTailOf(entry.route);
      if (!source.includes(tail)) problems.push(`${key}: ${tail} がファイルに無い`);
    }
    expect(problems).toEqual([]);
  });
});
