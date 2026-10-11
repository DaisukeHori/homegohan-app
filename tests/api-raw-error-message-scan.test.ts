// @vitest-environment node
/**
 * #1172 API の JSON 本文に、DB の生のエラー文 (error.message) を入れていないことのソース走査 (ratchet) テスト
 *
 * 問題:
 *   route が `NextResponse.json({ error: error.message }, { status: 500 })` と書くと、DB (Supabase / PostgREST) が返した
 *   生のエラー文 (テーブル名・列名・制約名・接続先) がそのままブラウザ・モバイルに返る。攻撃の手がかりになる。
 *   CLAUDE.md の方針は「500 の本文は汎用メッセージだけにし、詳細は構造化ログに残す」。
 *   共通ヘルパー internalError() (src/lib/api/errors.ts) がこの 2 つを一度に行う。
 *
 * このテストは「ratchet (歯止め)」:
 *   既に生のエラー文を返している route が多数あるため (段階的に直している)、現在の違反を ALLOWLIST に
 *   「ファイル → 件数」で明示し、そこから増やさない・減らしたらリストも減らす、を強制する。
 *     1. 許可リストに無いファイル、または許可より多い件数 -> 失敗 (新しい違反。internalError() を使う)
 *     2. 許可リストより少ない件数 (0 件を含む) -> 失敗 (直したのでリストを更新する。0 件になった行は消す)
 *     3. 許可リストのファイルが存在しない -> 失敗 (消す)
 *   「直したら必ずリストが縮む」ので、リストが空になれば #1172 は完了。
 *
 * 何を違反として数えるか (TypeScript の構文木で解析するので、コメントや文字列の中は見ない):
 *   `NextResponse.json(body, init)` / `Response.json(body, init)` の本文 (body) に、エラー由来の `.message` が入っているもの。
 *   1 回の呼び出しを 1 件と数える (本文に何か所入っていても 1 件)。
 *     - 直接: `{ error: error.message }` / `{ error: err.message }` / `{ message: insertError.message }` /
 *             `{ error: { code: 'X', message: result.error.message } }` / `error?.message ?? 'x'` / `'失敗: ' + e.message`
 *     - 変数経由: `const message = error instanceof Error ? error.message : 'Unknown error'` のあと `{ error: message }`
 *             (同じ関数の中で、本文より前に宣言された const / let を最大 3 段までたどる。`const { message } = error` も同じ)
 *   「エラー由来」の判定は名前で行う: `e` / `err` / `error` / `exception` / `ex`、または `Error` / `Err` で終わる名前
 *   (`insertError` / `rpcError` / `uploadError`)、または `.error` / `.xxxError` のプロパティ (`result.error` / `parsed.error`)。
 *
 * 数えないもの:
 *   - ステータスが 4xx だと分かる応答 (リテラルの 400〜499、`code === 'X' ? 403 : 400` のような分岐でも全て 4xx)。
 *     AuthError / ForbiddenError の文面 (401 / 403) や zod の検証メッセージ (400) のように、こちらが書いた文面を返す経路のため。
 *   - ステータスを変数で渡している (`{ status }`) など、4xx と分からないものは「違反」として数える (安全側)。
 *   - 4xx であっても DB のエラー文をそのまま返すのは良くないが、このテストでは見ない (レビューで見る)。
 *
 * 見ないもの (検出できない書き方。レビューで見る):
 *   `String(error)` / `JSON.stringify(error)` / `{ error }` (エラーのオブジェクトごと) / 別の関数に message を渡して
 *   その中で JSON にする / 後から代入する `let message; message = error.message` / `error['message']`。
 *
 * 直し方: route では `return internalError('GET /api/xxx', error, { userId: user.id, table: 'xxx' })`
 *   (src/lib/api/errors.ts)。本文は汎用メッセージだけになり、元のエラーは構造化ログ (app_logs) に残る。
 *   運営 API のように `error.message` を読むクライアントには `{ shape: 'nested' }` を渡す。
 *
 * 走査の対象は src/app/api 配下の全ファイル (テストを除く)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'src/app/api';

/**
 * 生のエラー文を JSON 本文に入れている現在の違反: ファイル -> 件数 (#1172 の後続の段で直すもの)。
 * 直したら件数を減らし、0 件になったら行を消す。足してはいけない (新しい違反は internalError() で書く)。
 *
 * 名前で判定しているため、中には DB のエラーではなく、こちらが投げた独自のエラー (例: InvalidVariantsError,
 * ImpersonationError) の文面を返しているだけのものも混ざる。後続の段で 1 件ずつ見て、
 * 直す (internalError() に替える) か、固定の文面にして件数を減らす。
 */
const ALLOWLIST: Record<string, number> = {
  'src/app/api/admin/sales/leads/[id]/activities/route.ts': 2,
  'src/app/api/admin/sales/leads/route.ts': 2,
  'src/app/api/admin/support/tickets/[id]/messages/route.ts': 2,
  'src/app/api/admin/support/tickets/route.ts': 2,
  'src/app/api/ai/analyze-fridge/route.ts': 1,
  'src/app/api/ai/analyze-health-checkup/route.ts': 1,
  'src/app/api/ai/analyze-meal-photo/route.ts': 1,
  'src/app/api/ai/analyze-weight-scale/route.ts': 1,
  'src/app/api/ai/classify-photo/route.ts': 1,
  'src/app/api/ai/consultation/actions/[actionId]/execute/route.ts': 2,
  'src/app/api/ai/consultation/important-messages/route.ts': 1,
  'src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts': 1,
  'src/app/api/ai/consultation/sessions/[sessionId]/messages/[messageId]/important/route.ts': 1,
  'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts': 1,
  'src/app/api/ai/consultation/sessions/route.ts': 2,
  'src/app/api/ai/image/generate/route.ts': 2,
  'src/app/api/ai/menu/day/regenerate/route.ts': 1,
  'src/app/api/ai/menu/meal/generate/route.ts': 1,
  'src/app/api/ai/menu/meal/pending/route.ts': 1,
  'src/app/api/ai/menu/meal/regenerate/route.ts': 1,
  'src/app/api/ai/menu/v4/generate/route.ts': 1,
  'src/app/api/ai/menu/v5/generate/route.ts': 3,
  'src/app/api/ai/menu/weekly/cleanup/route.ts': 3,
  'src/app/api/ai/menu/weekly/pending/route.ts': 1,
  'src/app/api/ai/menu/weekly/status/route.ts': 2,
  'src/app/api/ai/nutrition-analysis/route.ts': 1,
  'src/app/api/ai/nutrition/feedback/route.ts': 2,
  'src/app/api/ai/nutrition/route.ts': 4,
  'src/app/api/auth/session-sync/route.ts': 1,
  'src/app/api/badges/route.ts': 1,
  'src/app/api/catalog/products/[id]/route.ts': 1,
  'src/app/api/catalog/products/route.ts': 1,
  'src/app/api/comparison/rankings/route.ts': 1,
  'src/app/api/cron/process-menu-queue/route.ts': 2,
  'src/app/api/e2e/reset-onboarding/route.ts': 2,
  'src/app/api/experiments/[key]/assignment/route.ts': 1,
  'src/app/api/export/meals/route.ts': 1,
  'src/app/api/favorites/route.ts': 1,
  'src/app/api/handson-tour/complete/route.ts': 1,
  'src/app/api/meal-plans/add-from-photo/route.ts': 1,
  'src/app/api/meal-plans/meals/[id]/route.ts': 2,
  'src/app/api/meal-plans/meals/reorder/route.ts': 1,
  'src/app/api/meal-plans/meals/route.ts': 1,
  'src/app/api/meal-plans/route.ts': 2,
  'src/app/api/meals/[id]/route.ts': 6,
  'src/app/api/meals/route.ts': 3,
  'src/app/api/menu-plans/add/route.ts': 2,
  'src/app/api/notification-preferences/route.ts': 2,
  'src/app/api/nutrition-targets/calculate/route.ts': 1,
  'src/app/api/nutrition/targets/route.ts': 2,
  'src/app/api/onboarding/complete/route.ts': 4,
  'src/app/api/onboarding/progress/route.ts': 2,
  'src/app/api/onboarding/status/route.ts': 4,
  'src/app/api/operator/membership/audit/route.ts': 2,
  'src/app/api/operator/membership/families/inactive/route.ts': 2,
  'src/app/api/operator/membership/orgs/inactive/route.ts': 2,
  'src/app/api/org/invites/[id]/accept/route.ts': 1,
  'src/app/api/org/invites/[id]/reject/route.ts': 1,
  'src/app/api/org/invites/[id]/revoke/route.ts': 1,
  'src/app/api/org/leave/route.ts': 1,
  'src/app/api/org/members/[user_id]/remove/route.ts': 1,
  'src/app/api/org/owner-transfer/[id]/decline/route.ts': 1,
  'src/app/api/org/owner-transfer/propose/route.ts': 1,
  'src/app/api/pantry/[id]/route.ts': 3,
  'src/app/api/pantry/from-photo/route.ts': 1,
  'src/app/api/pantry/route.ts': 2,
  'src/app/api/performance/analyze/route.ts': 4,
  'src/app/api/performance/checkins/route.ts': 6,
  'src/app/api/performance/plans/route.ts': 6,
  'src/app/api/performance/sports/route.ts': 2,
  'src/app/api/recipes/[id]/comments/route.ts': 2,
  'src/app/api/recipes/[id]/like/route.ts': 2,
  'src/app/api/recipes/[id]/route.ts': 3,
  'src/app/api/recipes/route.ts': 1,
  'src/app/api/shopping-list/[id]/route.ts': 2,
  'src/app/api/shopping-list/route.ts': 3,
  'src/app/api/super-admin/admins/route.ts': 2,
  'src/app/api/super-admin/audit-logs/route.ts': 2,
  'src/app/api/super-admin/coupons/[id]/apply/route.ts': 1,
  'src/app/api/super-admin/coupons/[id]/redemptions/route.ts': 1,
  'src/app/api/super-admin/coupons/[id]/route.ts': 2,
  'src/app/api/super-admin/coupons/route.ts': 2,
  'src/app/api/super-admin/db-stats/route.ts': 1,
  'src/app/api/super-admin/experiments/[id]/results/route.ts': 2,
  'src/app/api/super-admin/experiments/[id]/route.ts': 4,
  'src/app/api/super-admin/experiments/route.ts': 4,
  'src/app/api/super-admin/feature-packages/[id]/route.ts': 2,
  'src/app/api/super-admin/feature-packages/route.ts': 2,
  'src/app/api/super-admin/flags/[key]/route.ts': 4,
  'src/app/api/super-admin/flags/route.ts': 4,
  'src/app/api/super-admin/infra/alerts/route.ts': 2,
  'src/app/api/super-admin/infra/metrics/route.ts': 2,
  'src/app/api/super-admin/plans/[id]/route.ts': 2,
  'src/app/api/super-admin/plans/route.ts': 2,
  'src/app/api/super-admin/settings/route.ts': 2,
};

// ─────────────────────────────────────────────
// ソース解析
// ─────────────────────────────────────────────
interface Finding {
  line: number;
  text: string;
}

const JSON_RESPONSE_OBJECTS = new Set(['NextResponse', 'Response']);
/** エラーを受ける変数の名前: e / err / error / exception / ex、または Error / Err で終わる名前 */
const ERROR_NAME = /^(?:e|err|error|exception|ex)$|(?:Error|Err)$/;
/** 変数をたどる段数の上限 (const a = e.message; const b = a; ... の連鎖) */
const MAX_RESOLVE_DEPTH = 3;

/** 括弧・非 null アサーション・型アサーションを外す */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** エラーを受けている値か: `error` / `insertError` / `result.error` / `state.insertError` */
function isErrorLike(expr: ts.Expression): boolean {
  const inner = unwrap(expr);
  if (ts.isIdentifier(inner)) return ERROR_NAME.test(inner.text);
  if (ts.isPropertyAccessExpression(inner)) return ERROR_NAME.test(inner.name.text);
  return false;
}

/** `error.message` / `err?.message` / `(e as Error).message` / `result.error.message` */
function isRawMessageAccess(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'message' && isErrorLike(node.expression);
}

/** 識別子が「値としての参照」か。プロパティ名・オブジェクトリテラルのキー・宣言の名前は参照ではない */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (ts.isBindingElement(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)) {
    if (parent.name === id) return false;
  }
  if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false;
  return true;
}

function statementsOf(node: ts.Node): readonly ts.Statement[] | undefined {
  if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) return node.statements;
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
  return undefined;
}

/**
 * 識別子が、直前までに宣言された変数で、その値が生のエラー文由来か。
 * いちばん内側のスコープで最初に見つかった宣言で決める (外側の同名の変数は影になる)。
 */
function identifierHoldsRawMessage(id: ts.Identifier, depth: number): boolean {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    const statements = statementsOf(scope);
    if (!statements) continue;

    let decided: boolean | undefined;
    for (const statement of statements) {
      if (statement.end > id.getStart()) break;
      if (!ts.isVariableStatement(statement)) continue;

      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === id.text) {
          decided = declaration.initializer ? expressionHasRawMessage(declaration.initializer, depth) : false;
        } else if (ts.isObjectBindingPattern(declaration.name) && declaration.initializer) {
          // const { message } = error / const { message: msg } = err
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name) || element.name.text !== id.text) continue;
            const property = element.propertyName ?? element.name;
            const propertyName = ts.isIdentifier(property) || ts.isStringLiteral(property) ? property.text : '';
            decided = propertyName === 'message' && isErrorLike(declaration.initializer);
          }
        }
      }
    }
    if (decided !== undefined) return decided;
  }
  return false;
}

/** 式の中に、生のエラー文 (直接、または変数経由) が入っているか */
function expressionHasRawMessage(root: ts.Node, depth = 0): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isTypeNode(node)) return;
    if (isRawMessageAccess(node)) {
      found = true;
      return;
    }
    if (
      ts.isIdentifier(node) &&
      depth < MAX_RESOLVE_DEPTH &&
      isValueReference(node) &&
      identifierHoldsRawMessage(node, depth + 1)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function isJsonResponseCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'json' &&
    ts.isIdentifier(node.expression.expression) &&
    JSON_RESPONSE_OBJECTS.has(node.expression.expression.text)
  );
}

/** 数値リテラル、またはその分岐 (`a ? 403 : 400`)。分からなければ null */
function numericValues(expr: ts.Expression): number[] | null {
  const inner = unwrap(expr);
  if (ts.isNumericLiteral(inner)) return [Number(inner.text)];
  if (ts.isConditionalExpression(inner)) {
    const whenTrue = numericValues(inner.whenTrue);
    const whenFalse = numericValues(inner.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  return null;
}

/** 第 2 引数 (init) から取りうるステータスを取り出す。指定が無ければ 200。分からなければ null */
function resolveStatuses(init: ts.Expression | undefined): number[] | null {
  if (!init) return [200];
  const literal = unwrap(init);
  if (!ts.isObjectLiteralExpression(literal)) return null;

  let hasSpread = false;
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      hasSpread = true;
    } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'status') {
      return null;
    } else if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === 'status'
    ) {
      return numericValues(property.initializer);
    }
  }
  return hasSpread ? null : [200];
}

/** 全ての取りうるステータスが 4xx と分かる (こちらが書いた検証メッセージなどを返す経路) */
function isClientErrorOnly(statuses: number[] | null): boolean {
  return statuses !== null && statuses.length > 0 && statuses.every((status) => status >= 400 && status < 500);
}

/** ソースの中で、生のエラー文を JSON 本文に入れている応答 (NextResponse.json など) を探す */
function findRawErrorMessageResponses(source: string, fileName = 'route.ts'): Finding[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const findings: Finding[] = [];

  const visit = (node: ts.Node): void => {
    if (isJsonResponseCall(node)) {
      const [body, init] = node.arguments;
      if (body && expressionHasRawMessage(body) && !isClientErrorOnly(resolveStatuses(init))) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        findings.push({ line: line + 1, text: node.getText(sf).replace(/\s+/g, ' ').slice(0, 140) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return findings;
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** ファイル (リポジトリ直下からの相対パス) -> 違反 */
const scanned = new Map<string, Finding[]>();
for (const file of collectSourceFiles(path.join(ROOT, SCAN_ROOT)).sort()) {
  const relative = path.relative(ROOT, file).split(path.sep).join('/');
  scanned.set(relative, findRawErrorMessageResponses(fs.readFileSync(file, 'utf-8'), relative));
}

const describeFindings = (findings: Finding[]) => findings.map((f) => `    L${f.line}: ${f.text}`).join('\n');
const totalFindings = [...scanned.values()].reduce((sum, findings) => sum + findings.length, 0);

// ─────────────────────────────────────────────
// リポジトリのソースに対する contract
// ─────────────────────────────────────────────
describe('API の JSON 本文に生のエラー文を入れない (#1172): src/app/api のソース', () => {
  it('走査が機能している: 多数の route を読み、既知の違反 (直接・変数経由) を検出している', () => {
    // 走査が壊れて何も見つけられなくなったときに、下の contract が空振りで通ってしまわないようにする
    expect(scanned.size).toBeGreaterThan(150);
    expect(totalFindings).toBeGreaterThan(50);

    // 直接 (`{ error: error.message }`)。#1172 の後続の段で直すまでは残っている
    expect(scanned.get('src/app/api/meals/route.ts')?.length ?? 0).toBeGreaterThan(0);
    // 変数経由 (`const message = error instanceof Error ? error.message : ...` のあと `{ error: message }`)
    expect(scanned.get('src/app/api/nutrition/targets/route.ts')?.length ?? 0).toBeGreaterThan(0);
  });

  it('許可リストに無い違反が増えていない (新しい route は internalError() で 500 を返す)', () => {
    const unexpected: string[] = [];
    for (const [file, findings] of scanned) {
      const allowed = ALLOWLIST[file] ?? 0;
      if (findings.length > allowed) {
        unexpected.push(`${file}: ${findings.length} 件 (許可リストでは ${allowed} 件)\n${describeFindings(findings)}`);
      }
    }

    expect(
      unexpected,
      'JSON 本文に error.message を入れないこと。500 は internalError(routeName, error, ctx) ' +
        "(src/lib/api/errors.ts) で返す (運営 API は { shape: 'nested' })。" +
        'どうしても直せない既存の違反だけ、ALLOWLIST の件数を直すこと:\n' +
        unexpected.join('\n'),
    ).toEqual([]);
  });

  it('許可リストが古くなっていない (直したらリストの件数を減らし、0 件になったら行を消す)', () => {
    const stale: string[] = [];
    for (const [file, allowed] of Object.entries(ALLOWLIST)) {
      const findings = scanned.get(file);
      if (!findings) {
        stale.push(`${file}: ファイルが無い。許可リストから消すこと`);
      } else if (findings.length < allowed) {
        stale.push(
          findings.length === 0
            ? `${file}: もう違反が無い。許可リストの行を消すこと`
            : `${file}: 違反は ${findings.length} 件に減った。許可リストを ${findings.length} にすること (今は ${allowed})`,
        );
      }
    }

    expect(stale, '直したので、ALLOWLIST を実際の件数に合わせて縮めること:\n' + stale.join('\n')).toEqual([]);
  });

  it('許可リストの件数は 1 以上の整数', () => {
    for (const [file, allowed] of Object.entries(ALLOWLIST)) {
      expect(Number.isInteger(allowed) && allowed >= 1, `${file}: ${allowed}`).toBe(true);
    }
  });

  it('#1172 第 1 段で直した /api/health/** と /api/profile は、違反が無く、許可リストにも載っていない', () => {
    const stageOne = [...scanned.keys()].filter(
      (file) => file.startsWith('src/app/api/health/') || file === 'src/app/api/profile/route.ts',
    );

    expect(stageOne).toContain('src/app/api/health/goals/route.ts');
    expect(stageOne).toContain('src/app/api/profile/route.ts');
    for (const file of stageOne) {
      expect(scanned.get(file), `${file} に生のエラー文を返す箇所が残っている`).toEqual([]);
      expect(ALLOWLIST[file], `${file} は直したので許可リストに載せない`).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────
// 走査ロジック自体の確認 (合成ソースで検出できること / 誤検出しないこと)
// ─────────────────────────────────────────────
describe('API の JSON 本文に生のエラー文を入れない (#1172): ソース解析のロジック', () => {
  const count = (source: string) => findRawErrorMessageResponses(source).length;

  describe('検出する', () => {
    it.each([
      ['{ error: error.message } (500)', `return NextResponse.json({ error: error.message }, { status: 500 });`],
      ['{ error: err.message }', `return NextResponse.json({ error: err.message }, { status: 500 });`],
      ['{ error: e.message }', `return NextResponse.json({ error: e.message }, { status: 500 });`],
      ['insertError / rpcError など *Error の名前', `return NextResponse.json({ error: insertError.message }, { status: 500 });`],
      ['result.error.message (プロパティ)', `return NextResponse.json({ error: result.error.message }, { status: 500 });`],
      ['state.insertError.message', `return NextResponse.json({ error: state.insertError.message }, { status: 500 });`],
      [
        '{ message: error.message } (運営 API の入れ子)',
        `return NextResponse.json({ error: { code: 'OP_DB_ERROR', message: error.message } }, { status: 500 });`,
      ],
      ['error?.message ?? 既定値', `return NextResponse.json({ error: error?.message ?? 'Unknown error' }, { status: 500 });`],
      ['error.message || 既定値', `return NextResponse.json({ error: error.message || 'failed' }, { status: 500 });`],
      ['文字列の連結', `return NextResponse.json({ error: 'failed: ' + aiError.message }, { status: 500 });`],
      ['テンプレート文字列', 'return NextResponse.json({ error: `failed: ${error.message}` }, { status: 500 });'],
      ['型アサーション越し', `return NextResponse.json({ error: (error as Error).message }, { status: 500 });`],
      ['非 null アサーション越し', `return NextResponse.json({ error: error!.message }, { status: 500 });`],
      ['details にだけ入れた場合', `return NextResponse.json({ error: '失敗', details: error.message }, { status: 500 });`],
      ['配列の中', `return NextResponse.json({ errors: [error.message] }, { status: 500 });`],
      ['Response.json (NextResponse でない)', `return Response.json({ error: claimError.message }, { status: 500 });`],
      ['ステータスの指定が無い (200 で返る)', `return NextResponse.json({ ok: false, error: error.message });`],
      ['ステータスが 5xx の別の値', `return NextResponse.json({ error: error.message }, { status: 503 });`],
      ['ステータスが変数 ({ status })', `return NextResponse.json({ error: error.message }, { status });`],
      ['ステータスが変数 (status: code)', `return NextResponse.json({ error: error.message }, { status: code });`],
      ['ステータスの一部が 4xx でない分岐', `return NextResponse.json({ error: error.message }, { status: ok ? 400 : 500 });`],
      ['init がオブジェクトでない', `return NextResponse.json({ error: error.message }, init);`],
      ['init が spread を含む', `return NextResponse.json({ error: error.message }, { ...init });`],
      ['init に headers だけ (200 で返る)', `return NextResponse.json({ error: error.message }, { headers: {} });`],
    ])('%s', (_label, source) => {
      expect(count(source)).toBe(1);
    });

    it.each([
      [
        'catch の中で `const message = error instanceof Error ? error.message : ...` のあと { error: message }',
        `
          try {} catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            return NextResponse.json({ error: message }, { status: 500 });
          }`,
      ],
      [
        '運営 API の { error: { code, message } } (message は変数)',
        `
          try {} catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message } }, { status: 500 });
          }`,
      ],
      [
        '変数のあとに別の変数を経由する (2 段)',
        `
          try {} catch (e) {
            const raw = e.message;
            const text = raw.trim();
            return NextResponse.json({ error: text }, { status: 500 });
          }`,
      ],
      [
        'テンプレート文字列に変数を埋め込む',
        `
          try {} catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            return NextResponse.json({ error: \`Failed: \${errorMessage}\`, code: 'X' }, { status: 500 });
          }`,
      ],
      [
        '分割代入 const { message } = error',
        `
          const { message } = error;
          return NextResponse.json({ error: message }, { status: 500 });`,
      ],
      [
        '分割代入の別名 const { message: msg } = err',
        `
          const { message: msg } = err;
          return NextResponse.json({ error: msg }, { status: 500 });`,
      ],
      [
        'result.error から取り出した変数',
        `
          const detail = result.error.message;
          return NextResponse.json({ error: detail }, { status: 500 });`,
      ],
      [
        '関数の中の変数 (外側のブロックで宣言)',
        `
          export async function POST() {
            const reason = error.message;
            if (x) {
              return NextResponse.json({ error: reason }, { status: 500 });
            }
          }`,
      ],
    ])('変数経由: %s', (_label, source) => {
      expect(count(source)).toBe(1);
    });

    it('1 回の応答に生のエラー文が何か所入っていても 1 件。応答ごとに数える', () => {
      expect(count(`return NextResponse.json({ error: error.message, details: error.message }, { status: 500 });`)).toBe(1);
      expect(
        count(`
          if (a) return NextResponse.json({ error: error.message }, { status: 500 });
          if (b) return NextResponse.json({ error: err.message }, { status: 500 });
          const detail = result.error.message;
          return NextResponse.json({ error: detail }, { status: 500 });
        `),
      ).toBe(3);
    });

    it('違反の行番号と、その応答の文面を返す', () => {
      const findings = findRawErrorMessageResponses(
        `import { NextResponse } from 'next/server';\n\nexport async function GET() {\n  return NextResponse.json({ error: error.message }, { status: 500 });\n}\n`,
      );

      expect(findings).toEqual([{ line: 4, text: "NextResponse.json({ error: error.message }, { status: 500 })" }]);
    });

    it('.tsx のソースも解析できる', () => {
      const findings = findRawErrorMessageResponses(
        `export const GET = () => NextResponse.json({ error: error.message }, { status: 500 });`,
        'route.tsx',
      );
      expect(findings).toHaveLength(1);
    });
  });

  describe('検出しない', () => {
    it.each([
      ['4xx (400): こちらが書いた検証メッセージ', `return NextResponse.json({ error: parseResult.error.message }, { status: 400 });`],
      ['401: AuthError の文面', `return NextResponse.json({ error: { code: 'AUTH', message: err.message } }, { status: 401 });`],
      ['403: ForbiddenError の文面', `return NextResponse.json({ error: { code: 'PERM', message: err.message } }, { status: 403 });`],
      ['422', `return NextResponse.json({ error: e.message }, { status: 422 });`],
      ['4xx の分岐 (全て 4xx)', `return NextResponse.json({ error: rpcError.message }, { status: code === 'X' ? 403 : 400 });`],
      ['ネストした 4xx の分岐', `return NextResponse.json({ error: error.message }, { status: a ? 400 : b ? 403 : 404 });`],
      ['括弧・as 越しの 4xx', `return NextResponse.json({ error: error.message }, { status: (400 as number) });`],
      ['文字列のキー "status" の 4xx', `return NextResponse.json({ error: error.message }, { 'status': 400 });`],
    ])('%s', (_label, source) => {
      expect(count(source)).toBe(0);
    });

    it.each([
      ['固定メッセージ', `return NextResponse.json({ error: '処理中にエラーが発生しました' }, { status: 500 });`],
      ['internalError() を使う', `return internalError('GET /api/x', error, { userId: user.id });`],
      ['エラーでない値の message', `return NextResponse.json({ message: result.message }, { status: 200 });`],
      ['成功応答の message', `return NextResponse.json({ message: data.message, ok: true });`],
      ['message というキー (値は固定)', `return NextResponse.json({ error: { code: 'X', message: '権限がありません' } }, { status: 403 });`],
      ['エラーのオブジェクトの別のプロパティ (code)', `return NextResponse.json({ error: 'failed', code: error.code }, { status: 500 });`],
      ['LLM の応答の choices[0].message', `return NextResponse.json({ content: response.choices[0]?.message?.content });`],
      ['エラーでない名前の変数', `const message = formatGreeting(); return NextResponse.json({ error: message }, { status: 500 });`],
      ['関数の引数の message (宣言が見えない)', `function fail(message: string) { return NextResponse.json({ error: message }, { status: 500 }); }`],
      ['ログにだけ使う', `logger.error('failed', error.message); return NextResponse.json({ error: 'failed' }, { status: 500 });`],
      ['JSON を返さない呼び出し', `const edge = await edgeResponse.json(); return NextResponse.redirect(error.message);`],
      ['NextResponse 以外の .json()', `return res.json({ error: error.message }, { status: 500 });`],
      ['本文が無い', `return NextResponse.json();`],
    ])('%s', (_label, source) => {
      expect(count(source)).toBe(0);
    });

    it('コメントや文字列の中', () => {
      expect(
        count(`
          // NextResponse.json({ error: error.message }, { status: 500 }) と書かない
          /* return NextResponse.json({ error: err.message }); */
          const note = "NextResponse.json({ error: error.message })";
          return NextResponse.json({ error: 'ok' }, { status: 500 });
        `),
      ).toBe(0);
    });

    it('変数は、本文より後ろの宣言・別のスコープの宣言・直近の宣言で上書きされたものを使わない', () => {
      // 本文より後で宣言された変数
      expect(
        count(`
          const a = () => NextResponse.json({ error: message }, { status: 500 });
          const message = error.message;
        `),
      ).toBe(0);
      // 別の関数の変数 (スコープが違う)
      expect(
        count(`
          function one() { const message = error.message; return message; }
          function two() { return NextResponse.json({ error: message }, { status: 500 }); }
        `),
      ).toBe(0);
      // 内側のスコープで同名の変数が固定文字列で宣言し直されている (外側の変数は影になる)
      expect(
        count(`
          const message = error.message;
          function two() {
            const message = '固定のメッセージ';
            return NextResponse.json({ error: message }, { status: 500 });
          }
        `),
      ).toBe(0);
    });

    it('分割代入: エラーでないものの message / message 以外のプロパティ', () => {
      expect(count(`const { message } = result; return NextResponse.json({ error: message }, { status: 500 });`)).toBe(0);
      expect(count(`const { code } = error; return NextResponse.json({ error: code }, { status: 500 });`)).toBe(0);
    });

    it('変数をたどる段数には上限がある (無限ループしない)', () => {
      expect(
        count(`
          const a = error.message;
          const b = a;
          const c = b;
          const d = c;
          const e2 = d;
          return NextResponse.json({ error: e2 }, { status: 500 });
        `),
      ).toBe(0);
    });
  });

  describe('部品', () => {
    it('resolveStatuses: 指定なしは 200、リテラルと分岐は全ての値、分からないものは null', () => {
      const statusesOf = (source: string) => {
        const sf = ts.createSourceFile('x.ts', `f(${source})`, ts.ScriptTarget.Latest, true);
        const call = (sf.statements[0] as ts.ExpressionStatement).expression as ts.CallExpression;
        return resolveStatuses(call.arguments[0]);
      };

      expect(resolveStatuses(undefined)).toEqual([200]);
      expect(statusesOf('{ status: 500 }')).toEqual([500]);
      expect(statusesOf('{ status: a ? 403 : 400 }')).toEqual([403, 400]);
      expect(statusesOf('{ headers: {} }')).toEqual([200]);
      expect(statusesOf('{ status }')).toBeNull();
      expect(statusesOf('{ status: code }')).toBeNull();
      expect(statusesOf('{ status: a ? 400 : code }')).toBeNull();
      expect(statusesOf('init')).toBeNull();
    });

    it('isClientErrorOnly: 全て 400〜499 のときだけ true', () => {
      expect(isClientErrorOnly([400])).toBe(true);
      expect(isClientErrorOnly([403, 499])).toBe(true);
      expect(isClientErrorOnly([399])).toBe(false);
      expect(isClientErrorOnly([500])).toBe(false);
      expect(isClientErrorOnly([400, 500])).toBe(false);
      expect(isClientErrorOnly([200])).toBe(false);
      expect(isClientErrorOnly([])).toBe(false);
      expect(isClientErrorOnly(null)).toBe(false);
    });

    it.each([
      ['e', true],
      ['err', true],
      ['error', true],
      ['exception', true],
      ['ex', true],
      ['insertError', true],
      ['rpcErr', true],
      ['uploadError', true],
      ['result.error', true],
      ['parsed.error', true],
      ['state.insertError', true],
      ['message', false],
      ['result', false],
      ['errors', false],
      ['errorMessage', false],
      ['Errorable', false],
      ['errand', false],
    ])('isErrorLike(%s) は %s', (code, expected) => {
      const sf = ts.createSourceFile('x.ts', `(${code})`, ts.ScriptTarget.Latest, true);
      const expression = (sf.statements[0] as ts.ExpressionStatement).expression as ts.ParenthesizedExpression;
      expect(isErrorLike(expression.expression)).toBe(expected);
    });
  });
});
