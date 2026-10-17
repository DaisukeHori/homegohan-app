// @vitest-environment node
/**
 * #1577 の 7: sendEmail の結果で「送れなかった」をログに残す呼び出し側は、宛先停止リストで止めた (suppressed) ときに
 * error を出さない (意図した動きなので warn。error だとエラー急増の通知 (GET /api/cron/app-log-alerts) の数に入る)。
 * 呼び出し側は src/lib/emails/send-result.ts の logEmailFailures を通す。このテストは、送れなかった理由を
 * ロガーの error(…) へ直接渡す書き方が src/ と lib/ に戻ってこないことを、TypeScript の構文木で見張る
 * (コメントの中は見ない)。
 *
 * 数える書き方 (どれも「ロガーの .error(message, <理由>, …) の 2 つ目の引数」):
 *   (A) `const failures = emailFailureReasons(…)` の要素 (`failures[0]` など)
 *   (B) `const sent = await sendEmail(…)` の `sent.error`
 *   (C) try の中で `throw sent.error` (sent は sendEmail の結果) し、catch の変数をそのまま渡す
 * 対象: src/ と lib/ の .ts / .tsx (`__tests__`・`*.test.*`・`*.spec.*`・`.d.ts` を除く)。
 * sendEmail と worker そのもの (src/lib/emails/) は対象外 (送る側の記録で、呼び出し側のログではない)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['src', 'lib'] as const;
/** sendEmail と worker の実体。呼び出し側ではないので数えない */
const EXCLUDED_DIR = 'src/lib/emails/';
const SEND_EMAIL = 'sendEmail';
const FAILURE_REASONS = 'emailFailureReasons';
const LOG_ERROR_METHOD = 'error';
/** 理由は error(message, reason, metadata) の 2 つ目 */
const REASON_ARGUMENT_INDEX = 1;
/** 走査が機能していることの目安 (src と lib の .ts / .tsx はこれより十分に多い) */
const MIN_SCANNED_FILES = 100;
/** sendEmail を呼ぶ呼び出し側の数の目安 (#1577 の時点で 20 を超える。走査が呼び出し側を見つけられていることの確認) */
const MIN_SEND_EMAIL_CALLERS = 10;

type Violation = 'failure-reasons-element' | 'send-result-error' | 'rethrown-send-error';

function unwrapAwait(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isCallTo(node: ts.Expression | undefined, name: string): boolean {
  if (!node) return false;
  const expr = unwrapAwait(node);
  return ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === name;
}

/** `<id>.error` の <id> の名前 (そうでなければ null) */
function errorPropertyOwner(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'error' && ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  return null;
}

/** `X.error(…)` の呼び出しなら、2 つ目の引数を返す */
function logErrorReason(node: ts.Node): ts.Expression | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== LOG_ERROR_METHOD) return null;
  return node.arguments[REASON_ARGUMENT_INDEX] ?? null;
}

function forEachDescendant(node: ts.Node, visit: (child: ts.Node) => void): void {
  const walk = (child: ts.Node): void => {
    visit(child);
    ts.forEachChild(child, walk);
  };
  ts.forEachChild(node, walk);
}

/** ソース 1 つの中の、送れなかった理由を error へ直接渡す書き方を数える。sendEmail を呼んでいるかも返す */
function scanSource(source: string, fileName = 'virtual.ts'): { violations: Violation[]; callsSendEmail: boolean } {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sendResults = new Set<string>();
  const failureLists = new Set<string>();
  let callsSendEmail = false;

  forEachDescendant(sourceFile, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === SEND_EMAIL) {
      callsSendEmail = true;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (isCallTo(node.initializer, SEND_EMAIL)) sendResults.add(node.name.text);
      if (isCallTo(node.initializer, FAILURE_REASONS)) failureLists.add(node.name.text);
    }
  });

  const violations: Violation[] = [];
  forEachDescendant(sourceFile, (node) => {
    const reason = logErrorReason(node);
    if (reason) {
      if (
        ts.isElementAccessExpression(reason) &&
        ts.isIdentifier(reason.expression) &&
        failureLists.has(reason.expression.text)
      ) {
        violations.push('failure-reasons-element');
      }
      const owner = errorPropertyOwner(reason);
      if (owner !== null && sendResults.has(owner)) violations.push('send-result-error');
    }

    if (ts.isTryStatement(node) && node.catchClause?.variableDeclaration) {
      const catchName = node.catchClause.variableDeclaration.name;
      if (!ts.isIdentifier(catchName)) return;
      let rethrowsSendError = false;
      forEachDescendant(node.tryBlock, (child) => {
        if (ts.isThrowStatement(child)) {
          const owner = errorPropertyOwner(child.expression);
          if (owner !== null && sendResults.has(owner)) rethrowsSendError = true;
        }
      });
      if (!rethrowsSendError) return;
      forEachDescendant(node.catchClause.block, (child) => {
        const caught = logErrorReason(child);
        if (caught && ts.isIdentifier(caught) && caught.text === catchName.text) violations.push('rethrown-send-error');
      });
    }
  });
  return { violations, callsSendEmail };
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(relative));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
    out.push(relative);
  }
  return out;
}

describe('送れなかった理由を error へ直接渡さない (#1577 の 7)', () => {
  it('走査の自己点検: 3 つの書き方を見つけ、logEmailFailures を通す書き方は数えない', () => {
    const bad = `
      async function a(log) {
        const results = await Promise.allSettled([sendEmail(x)]);
        const failures = emailFailureReasons(results);
        if (failures.length > 0) log.error('m', failures[0], {});
      }
      async function b(log) {
        const sent = await sendEmail(x);
        if (isEmailFailure(sent)) log.error('m', sent.error, {});
      }
      async function c(log) {
        try {
          const sent = await sendEmail(x);
          if (isEmailFailure(sent)) throw sent.error;
        } catch (err) {
          log.withUser('u').error('m', err, {});
        }
      }
    `;
    expect(scanSource(bad).violations.sort()).toEqual(
      ['failure-reasons-element', 'rethrown-send-error', 'send-result-error'].sort(),
    );

    const good = `
      async function a(log) {
        const results = await Promise.allSettled([sendEmail(x)]);
        const failures = emailFailureReasons(results);
        logEmailFailures(log, 'm', failures, {});
      }
      async function b(log) {
        const sent = await sendEmail(x);
        if (isEmailFailure(sent)) logEmailFailures(log, 'm', [sent.error], {});
      }
      async function c(log) {
        try {
          const sent = await sendEmail(x);
          if (isEmailFailure(sent)) throw sent.error;
        } catch (err) {
          logEmailFailures(log, 'm', [err], {});
        }
      }
      async function d(log) {
        try {
          await somethingElse();
        } catch (err) {
          // sendEmail の結果を投げ直していない try の例外は、今までどおり error でよい
          log.error('m', err, {});
        }
      }
    `;
    expect(scanSource(good)).toEqual({ violations: [], callsSendEmail: true });
  });

  it('src/ と lib/ の呼び出し側に、送れなかった理由を error へ直接渡す書き方が無い', () => {
    const files = SCAN_ROOTS.flatMap((root) => listSourceFiles(root)).filter((file) => !file.startsWith(EXCLUDED_DIR));
    expect(files.length).toBeGreaterThan(MIN_SCANNED_FILES);

    const found: string[] = [];
    let callers = 0;
    for (const file of files) {
      const { violations, callsSendEmail } = scanSource(fs.readFileSync(path.join(ROOT, file), 'utf-8'), file);
      if (callsSendEmail) callers += 1;
      for (const violation of violations) found.push(`${file}: ${violation}`);
    }
    expect(callers).toBeGreaterThan(MIN_SEND_EMAIL_CALLERS);
    expect(found, 'src/lib/emails/send-result.ts の logEmailFailures を通す').toEqual([]);
  });
});
