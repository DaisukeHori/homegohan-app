// @vitest-environment node
/**
 * #2245 K5 利用者の id を metadata にだけ渡すログ (app_logs の user_id 列が空のまま残る) のソース走査テスト
 *
 * 問題:
 *   app_logs の user_id 列は、createLogger(...).withUser(userId) で作ったロガーだけが埋める (src/lib/db-logger.ts・
 *   supabase/functions/_shared/db-logger.ts)。createLogger(...).warn / .error に `{ userId }` / `{ user_id }` を metadata で
 *   渡すだけだと、user_id 列は空のまま残り、運営が user_id 列で絞ったときにそのログだけが出てこない。
 *   lib/meal-image-jobs.ts の後始末のログ (K5 の本体) と、同じ型が次の 16 か所にあった (直す前の origin/main で 17 件):
 *     - 料理画像の上限の判定の失敗の warn (/api/meals・/api/meals/[id]・/api/meal-plans/meals・/api/meal-plans/meals/[id]・
 *       AI 相談の献立の更新のアクション)
 *     - AI 相談のアクションの値の検証の失敗の warn・家族の招待の招待者のプロフィールの読み取りの失敗の error
 *     - アプリ内課金の同期を止めた warn・ストアの購読の取り直し (定期・遅延) の warn
 *     - Push 通知の送信待ちの dead・端末の行の削除・receipt の error の warn
 *   直し方は「利用者が分かるログは .withUser(userId) を通して出す」(metadata の userId / user_id はそのまま残してよい)。
 *
 * 何を違反として数えるか (TypeScript の構文木で解析するので、コメントや文字列の中は見ない):
 *   `<受け手>.error(...)` / `.warn(...)` / `.info(...)` / `.debug(...)` の呼び出しで、引数のどれかが
 *   `userId` / `user_id` のプロパティを持つオブジェクトリテラル (同じファイルで宣言した、そういうオブジェクトの変数を含む) で、
 *   受け手の式に `withUser(` が無いもの。受け手が識別子なら、その宣言の初期化の式に `withUser(` があれば数えない。
 *   受け手が `console` なら数えない (console は app_logs に書かない)。
 *
 * 見ないもの (検出できない書き方。レビューで見る):
 *   ほかの名前のキー (`target_user_id` は別の利用者 (操作の対象) なので、利用者の列ではなく metadata に置くのが正しい) /
 *   スプレッドや関数の戻り値で渡す metadata / 別のファイルで作った metadata。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
/** 走査するディレクトリ (Next.js のサーバー・共有の lib・Edge Function。テストは見ない) */
const SCAN_ROOTS = ['src', 'lib', 'packages', 'supabase/functions'];
/** 走査しないディレクトリの名前 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '__tests__', '__mocks__']);
/** 走査しないファイル (テスト・型の宣言) */
const SKIPPED_FILE = /\.(?:test|spec)\.tsx?$|\.d\.ts$/;
/** ログに書く呼び出しのメソッド名 */
const LOG_METHODS = new Set(['error', 'warn', 'info', 'debug']);
/** 利用者の id を表すキー (app_logs の user_id 列に入れるべき値) */
const USER_ID_KEYS = new Set(['userId', 'user_id']);
/** 利用者つきのロガーを作る呼び出し (createLogger(...).withUser(userId)) */
const WITH_USER_CALL = 'withUser(';

interface Finding {
  line: number;
  receiver: string;
}

function hasUserIdKey(node: ts.Node | undefined): boolean {
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      USER_ID_KEYS.has(property.name.getText()),
  );
}

/** ソースの文字列から、user_id 列に入らないログの呼び出しを探す */
function findUserIdOnlyInMetadata(fileName: string, source: string): Finding[] {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const initializers = new Map<string, ts.Expression[]>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, [...(initializers.get(node.name.text) ?? []), node.initializer]);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const isUserLogger = (receiver: ts.Expression): boolean => {
    if (receiver.getText().includes(WITH_USER_CALL)) return true;
    if (!ts.isIdentifier(receiver)) return false;
    const declared = initializers.get(receiver.text) ?? [];
    return declared.length > 0 && declared.every((initializer) => initializer.getText().includes(WITH_USER_CALL));
  };
  const carriesUserId = (argument: ts.Expression): boolean =>
    hasUserIdKey(argument) || (ts.isIdentifier(argument) && (initializers.get(argument.text) ?? []).some(hasUserIdKey));

  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && LOG_METHODS.has(node.expression.name.text)) {
      const receiver = node.expression.expression;
      if (receiver.getText() !== 'console' && !isUserLogger(receiver) && node.arguments.some(carriesUserId)) {
        findings.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          receiver: receiver.getText().replace(/\s+/g, ' '),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function listSourceFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : listSourceFiles(fullPath);
    return /\.tsx?$/.test(entry.name) && !SKIPPED_FILE.test(entry.name) ? [fullPath] : [];
  });
}

describe('利用者の id を metadata にだけ渡すログが無い (app_logs の user_id 列に入る。#2245 K5)', () => {
  it('検出の規則: metadata の userId / user_id を withUser を通さずに出すものだけを数える', () => {
    const source = `
      const logger = createLogger('x');
      const userLogger = createLogger('x').withUser(id);
      const context = { userId: id, step: 's' };
      createLogger('x').warn('a', { userId: id });
      logger.error('b', err, { user_id: id });
      logger.error('c', err, context);
      deps.log.warn('d', { user_id: row.user_id });
      createLogger('x').withUser(id).warn('ok', { userId: id });
      userLogger.error('ok', err, { userId: id });
      (id ? logger.withUser(id) : logger).warn('ok', { user_id: id });
      console.warn('ok', { userId: id });
      logger.warn('ok', { target_user_id: id });
      logger.info('ok', { count: 1 });
    `;
    expect(findUserIdOnlyInMetadata('fixture.ts', source).map((finding) => finding.receiver)).toEqual([
      "createLogger('x')",
      'logger',
      'logger',
      'deps.log',
    ]);
  });

  it('src・lib・packages・supabase/functions に、利用者の id を metadata にだけ渡すログが無い', () => {
    const files = SCAN_ROOTS.flatMap((root) => listSourceFiles(path.join(ROOT, root)));
    const relative = files.map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
    // 走査が空振りしていない (K5 の本体のファイルを読んでいる)
    expect(relative).toContain('lib/meal-image-jobs.ts');
    expect(relative).toContain('src/lib/push/outbox.ts');

    const violations = files.flatMap((file, index) =>
      findUserIdOnlyInMetadata(file, fs.readFileSync(file, 'utf8')).map(
        (finding) => `${relative[index]}:${finding.line} ${finding.receiver}`,
      ),
    );
    expect(violations).toEqual([]);
  });
});
