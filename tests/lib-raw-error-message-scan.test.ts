// @vitest-environment node
/**
 * #1172 src/lib のヘルパーが、結果 (戻り値のオブジェクト) に DB の生のエラー文を入れていないことのソース走査テスト
 *
 * 問題:
 *   tests/api-raw-error-message-scan.test.ts は src/app/api の route の本文を見る。ところが route は、src/lib のヘルパーの結果を
 *   そのまま本文に入れることがある。ヘルパーが `return { error: profileError.message }` や `result = { error: insertError.message }` と
 *   DB の生のエラー文 (テーブル名・列名・制約名・衝突した値) を結果に入れると、route の走査には「result.error」としか見えず、すり抜ける。
 *   第 2 段の R1 で、この形の漏れが 4 か所見つかった:
 *     - applyUserBan (src/lib/admin/user-ban.ts) → 運営のモデレーションの 500 の本文
 *     - runConsultationAction (src/lib/ai/consultation-action-executor.ts) → AI 相談の execute / messages の本文と ai_action_logs.result
 *     - createOrgInviteWithEmail (src/lib/membership/org-invite.ts) → 組織の招待の 4xx / 500 の本文
 *   直し方は「DB の失敗は固定の文にし、元のエラーは構造化ログ (または internalError に渡す cause) にだけ残す」。
 *
 * 何を違反として数えるか (TypeScript の構文木で解析するので、コメントや文字列の中は見ない):
 *   オブジェクトリテラルのプロパティの値 (`{ error: <値> }` / `{ message: <値> }` …) に、エラーの文面 `.message` / `.details` / `.hint`
 *   (`error.message` / `insertError?.details` / `(e as Error).message` / `result.error.hint` / `error['message']`) が入っているもの。
 *   テンプレート文字列・連結・`??`・三項演算子・関数の引数 (`clamp(err.message)`) の中にあっても数える。1 か所の文面を 1 件と数える。
 *   「エラー」の判定は route の走査と同じく名前で行う: `e` / `err` / `error` / `exception` / `ex`、または `Error` / `Err` で終わる名前、
 *   または `.error` / `.xxxError` のプロパティ。
 *
 * 数えないもの:
 *   - ログに渡す値 (`logger.error(...)` / `console.warn(...)` などの引数の中のオブジェクト)
 *   - 例外の文面 (`throw` の中、`new Error(...)` / `new XxxError(...)` の引数)。投げた例外は route の catch に届き、
 *     そこで本文に入れていないかは route の走査が見る
 *
 * 見ないもの (検出できない書き方。レビューで見る):
 *   変数を経由する (`const m = error.message; return { error: m }`) / 後から代入する / エラーらしくない名前の変数 /
 *   エラーのオブジェクトごと結果に入れる (`return { error }`。route が `.message` を本文に入れれば route の走査が見る)。
 *
 * 許可リスト (ALLOWED): 結果に入れても応答の本文に届かないことを確かめたものだけ。件数で固定し、増えても減っても失敗する
 * (減ったら許可リストから外す)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'src/lib';

/** エラーを受ける変数の名前 (tests/api-raw-error-message-scan.test.ts と同じ規則) */
const ERROR_NAME = /^(?:e|err|error|exception|ex)$|(?:Error|Err)$/;
/** PostgREST のエラーが文面を持つプロパティ (例外の Error も message を持つ) */
const RAW_TEXT_PROPERTIES = new Set(['message', 'details', 'hint']);
/** ログに書く呼び出しのメソッド名 (`logger.error(...)` / `console.warn(...)`) */
const LOG_METHODS = new Set(['error', 'warn', 'info', 'debug', 'log', 'trace']);
/** 例外を作る `new Xxx(...)` の名前 (`new Error(...)` / `new EmailSendError(...)`) */
const ERROR_CLASS_NAME = /Error$/;

/**
 * 許可リスト: ファイル -> { 件数, 理由 }。
 * 理由には「なぜ応答の本文に届かないか」を書く。
 */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  'src/lib/admin/audit.ts': {
    count: 1,
    reason:
      'recordAdminAudit の戻り値 { ok: false, error }。呼び出し側 (admin/finance/refunds) は ok だけを見て固定の文 (AUDIT_FAILED_MESSAGE) を返す。失敗は logAuditFailure で構造化ログに残している',
  },
  'src/lib/admin/not-supported.ts': {
    count: 2,
    reason: 'AuthError / ForbiddenError の文面 (こちらが書いた固定の文) を 401 / 403 で返す。DB のエラー文ではない',
  },
  'src/lib/emails/send.ts': {
    count: 2,
    reason:
      'Resend の送信の失敗 (EmailSendError の材料)。呼び出し側は isEmailFailure のとき例外にして catch で警告ログにだけ残す。DB のエラー文ではない',
  },
  'src/lib/report-boundary-error.ts': {
    count: 1,
    reason: '画面 (ブラウザ) のエラー境界が、捕まえた例外をサーバーのログへ送る (logToServer) 値。応答の本文ではない',
  },
};

interface Finding {
  line: number;
  text: string;
}

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

/** エラーを受けている値か: `error` / `insertError` / `result.error` */
function isErrorLike(expr: ts.Expression): boolean {
  const inner = unwrap(expr);
  if (ts.isIdentifier(inner)) return ERROR_NAME.test(inner.text);
  if (ts.isPropertyAccessExpression(inner)) return ERROR_NAME.test(inner.name.text);
  return false;
}

/** `error.message` / `err?.details` / `result.error.hint` / `error['message']` か */
function isRawTextAccess(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return RAW_TEXT_PROPERTIES.has(node.name.text) && isErrorLike(node.expression);
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return RAW_TEXT_PROPERTIES.has(node.argumentExpression.text) && isErrorLike(node.expression);
  }
  return false;
}

/** ログの呼び出し (`logger.error(...)` / `console.warn(...)`) か */
function isLogCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    LOG_METHODS.has(node.expression.name.text)
  );
}

/** 例外を作る `new Error(...)` / `new XxxError(...)` か */
function isErrorConstruction(node: ts.Node): boolean {
  if (!ts.isNewExpression(node)) return false;
  const callee = node.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
  return ERROR_CLASS_NAME.test(name);
}

/**
 * 文面が入る、いちばん内側のオブジェクトのプロパティ (`{ error: <ここ> }`)。
 * ログ・例外の中、またはプロパティの値でない (関数の境界を越える) ときは undefined
 */
function enclosingResultProperty(node: ts.Node): ts.PropertyAssignment | undefined {
  let property: ts.PropertyAssignment | undefined;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    // ログ・例外の中なら、途中にプロパティがあっても数えない (`logger.error('x', err, { error: err.message })`)
    if (isLogCall(current) || isErrorConstruction(current) || ts.isThrowStatement(current)) return undefined;
    if (!property && ts.isPropertyAssignment(current)) {
      // プロパティ名の側ではなく値の側にあること
      if (!(current.initializer.pos <= node.pos && node.end <= current.initializer.end)) return undefined;
      property = current;
    }
    if (ts.isFunctionLike(current) || ts.isStatement(current)) break;
  }
  return property;
}

function parseSource(source: string, fileName: string): ts.SourceFile {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

function findingsOf(sf: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (isRawTextAccess(node)) {
      const property = enclosingResultProperty(node);
      if (property) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        findings.push({ line: line + 1, text: property.getText(sf).replace(/\s+/g, ' ').slice(0, 140) });
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

/** ソースの中で、オブジェクトのプロパティにエラーの文面を入れている箇所を探す */
function findRawErrorTextInResults(source: string, fileName = 'helper.ts'): Finding[] {
  return findingsOf(parseSource(source, fileName));
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** ファイル (リポジトリ直下からの相対パス) -> 見つかった箇所 */
const scanned = new Map<string, Finding[]>();
for (const file of collectSourceFiles(path.join(ROOT, SCAN_ROOT)).sort()) {
  const relative = path.relative(ROOT, file).split(path.sep).join('/');
  scanned.set(relative, findingsOf(parseSource(fs.readFileSync(file, 'utf-8'), relative)));
}

/** 走査が壊れていないことの目安: src/lib のファイル数の下限 */
const MIN_SCANNED_FILES = 120;

const describeFindings = (findings: Finding[]) => findings.map((f) => `    L${f.line}: ${f.text}`).join('\n');

// ─────────────────────────────────────────────
// リポジトリのソースに対する contract
// ─────────────────────────────────────────────
describe('src/lib のヘルパーの結果に DB の生のエラー文を入れない (#1172): src/lib のソース', () => {
  it('走査が機能している: 多数のファイルを読み、R1 で直したヘルパーも対象に入っている', () => {
    expect(scanned.size).toBeGreaterThan(MIN_SCANNED_FILES);
    for (const file of [
      'src/lib/admin/user-ban.ts',
      'src/lib/ai/consultation-action-executor.ts',
      'src/lib/membership/org-invite.ts',
    ]) {
      expect(scanned.has(file), file).toBe(true);
    }
  });

  it('許可リストにないファイルは、結果 (オブジェクトのプロパティ) にエラーの文面を入れていない', () => {
    const violations: string[] = [];
    for (const [file, findings] of scanned) {
      if (findings.length === 0 || file in ALLOWED) continue;
      violations.push(`${file}: ${findings.length} 件\n${describeFindings(findings)}`);
    }

    expect(
      violations,
      '結果に error.message / details / hint を入れないこと。DB の失敗は固定の文にし、元のエラーは構造化ログ ' +
        '(createLogger(...).error) か、route が internalError(routeName, cause, ...) に渡す cause にだけ残す:\n' +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('許可リストの件数が実際と一致する (増えたら直す・減ったら許可リストを減らす)', () => {
    const actual = Object.fromEntries(Object.keys(ALLOWED).map((file) => [file, scanned.get(file)?.length ?? 0]));
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([file, { count }]) => [file, count]));
    expect(actual).toEqual(expected);
  });
});

// ─────────────────────────────────────────────
// 走査ロジック自体の確認 (合成ソースで検出できること / 誤検出しないこと)
// ─────────────────────────────────────────────
describe('src/lib のヘルパーの結果に DB の生のエラー文を入れない (#1172): ソース解析のロジック', () => {
  const count = (source: string) => findRawErrorTextInResults(source).length;

  it.each([
    ['戻り値の error に入れる (applyUserBan の形)', `return { success: false, unbanAt: null, error: profileError.message };`],
    ['結果の変数に代入する (runConsultationAction の形)', `result = { error: insertError.message };`],
    ['テンプレート文字列に埋め込む', 'result = { error: `食事の取得に失敗: ${mealFetchError.message}` };'],
    ['失敗の message に入れる (createOrgInviteWithEmail の形)', `return { ok: false, status, code, message: rpcError.message };`],
    ['?? の既定値つき', `return { ok: false, error: error?.message ?? 'failed' };`],
    ['三項演算子', `return { ok: false, error: err instanceof Error ? err.message : String(err) };`],
    ['関数の引数の中', `return { message: clamp(err.message, 100) };`],
    ['PostgREST の details', `return { ok: false, details: error.details };`],
    ['PostgREST の hint', `return { ok: false, hint: updateError?.hint };`],
    ['result.error.message (プロパティ)', `return { error: result.error.message };`],
    ["error['message'] (要素アクセス)", `return { error: error['message'] };`],
    ['入れ子のオブジェクトの中', `return { failure: { code, message: rpcError.message } };`],
    ['型アサーション越し', `return { error: (e as Error).message };`],
  ])('検出する: %s', (_label, source) => {
    expect(count(source)).toBe(1);
  });

  it.each([
    ['ログの metadata', `logger.error('failed', error, { error: error.message });`],
    ['withUser を挟んだログ', `createLogger('x').withUser(id).warn('failed', { reason: err.message });`],
    ['console', `console.error('failed', { message: error.message });`],
    ['例外の文面', `throw new Error(\`読み出しに失敗しました: \${error.message}\`);`],
    ['独自の例外クラスの文面', `throw new EmailSendError({ message: err.message });`],
    ['固定の文', `return { success: false, error: 'BAN の適用に失敗しました', kind: 'internal', cause: profileError };`],
    ['エラーのオブジェクトごと cause に入れる', `return { ok: false, internalCause: rpcError };`],
    ['エラーでない値の message', `return { message: data.message };`],
    ['LLM の応答の choices[0].message', `return { content: response.choices[0]?.message?.content };`],
    ['エラーのコード (文面ではない)', `return { ok: false, code: error.code };`],
    ['コメント・文字列の中', `// return { error: error.message }\nconst note = "{ error: error.message }";`],
    ['条件にだけ使う', `if (error.message.includes('RATE_LIMITED')) return { ok: false, error: '上限です' };`],
  ])('検出しない: %s', (_label, source) => {
    expect(count(source)).toBe(0);
  });

  it('1 か所の文面を 1 件と数え、行番号とプロパティを返す', () => {
    expect(
      findRawErrorTextInResults(`const a = 1;\nreturn { ok: false, error: insertError.message, details: insertError.details };\n`),
    ).toEqual([
      { line: 2, text: 'error: insertError.message' },
      { line: 2, text: 'details: insertError.details' },
    ]);
  });
});
