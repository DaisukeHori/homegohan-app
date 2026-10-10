// @vitest-environment node
//
// #1433: 「今日」を UTC の暦日やローカル時刻で決める書き方が、本番コードに戻ってこないようにするソース走査。
//
// Vercel / Supabase Edge の実行環境のタイムゾーンは UTC。そのため
//   - `new Date().toISOString().slice(0, 10)` / `.split('T')[0]` は UTC の暦日になり、JST の 0:00〜8:59 は「前日」になる
//   - `new Date().getMonth() + 1` は実行環境のローカル時刻の月で、月初 1 日の JST 0:00〜8:59 は前月になる
//   - Edge Functions の Date#getDate / setDate / getDay / getMonth など (ローカル時刻) は、実行環境のタイムゾーンで結果が変わる
// DB の日付列は JST の暦日なので、「今日」は Edge では supabase/functions/_shared/jst-date.ts (todayJst など)、
// Web / Mobile では packages/shared (todayLocal / formatLocalDate / addDaysToDate など。サーバーは src/lib/jst-day-ranges.ts) で求める。
//
// 本番コード (テストを除く) を TypeScript の構文木で読み (コメントや文字列の中は見ない)、次を検出する:
//   規則 A: 今の時刻 (`new Date()` / `new Date(Date.now() ...)`) を toISOString して、先頭 10 文字 (slice / substring / substr) か
//           split('T')[0] で日付にする
//   規則 B: 今の時刻 (`new Date()`) の月・日・曜日・年をローカル時刻で読む (`new Date().getMonth()` など)
//   規則 C: supabase/functions の中で、ローカル時刻の Date のメソッド (getDate / setDate / getDay / getMonth など) を使う
//   規則 D: ローカル時刻の年・月・日から作った Date (`new Date(y, m, d)` のように引数が 2 つ以上) を toISOString する
//           (例: `new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10)`。ローカル時刻の 0 時を UTC に戻すので、
//           実行環境のタイムゾーンで日付が変わる)。同じファイルで `const d = new Date(y, m, d)` と作った変数の toISOString も数える
//   規則 E: 同じファイルでローカル時刻の setter (setDate / setMonth / setFullYear / setHours) を当てた変数を、
//           toISOString して日付 (先頭 10 文字 / split('T')[0]) にする (例: `d.setDate(d.getDate() - 7); d.toISOString().slice(0, 10)`)
//   規則 F: 文字列 (リテラル・テンプレート) に 'T23:59:59' を含む。日付の文字列に足して「その日の終わり」の時刻を作る書き方
//           (例: `.lte('created_at', to + 'T23:59:59Z')`) は、UTC の 23:59:59 = JST の翌日 8:59:59 になり、
//           JST の暦日の期間に翌日の朝の行が混ざる。timestamptz の列を JST の暦日で絞るときは
//           src/lib/jst-day-ranges.ts の jstDayRangeTimestamps / jstOptionalDayRangeTimestamps (JST 0 時の時刻・.gte と .lt) を使う
//   規則 G: timestamptz の列 (名前が _at で終わる列と、TIMESTAMPTZ_COLUMNS_WITHOUT_AT_SUFFIX の列) を .gte / .gt / .lte / .lt で絞るのに、
//           JST の暦日から作った時刻 (src/lib/jst-day-ranges.ts・packages/shared・Edge の _shared/jst-date.ts の関数の戻り値) 以外を渡す。
//           画面で選んだ日付 ('2026-10-10') をそのまま渡すと、DB は UTC の 0 時 (= JST 9 時) と読み、開始日の JST 0:00〜8:59 と
//           終了日の JST 9:00 以降の行が落ちる (#1433 の監査ログ・NPS / CSAT・CSV の書き出し)。
//           今からの相対時刻・入口で検査した ISO の日時など、暦日ではない値で絞る箇所は、理由つきで許可リストに載せる。
//           「悪い書き方の形」ではなく「timestamptz の列を絞る呼び出しの数」を数えるので、新しいルートが生の日付を渡す書き方を
//           足した時点で (許可リストに理由を書かない限り) 落ちる
//   規則 H: timestamptz の値 (`invite.expires_at` など、規則 G と同じ名前の列の値) を、先頭 10 文字 (slice / substring / substr) か
//           split('T')[0] で日付にする (toISOString を通したもの・String(...) で包んだものも)。UTC の暦日になり、
//           JST 0:00〜8:59 の時刻が前日になる。src/lib/jst-day-ranges.ts の jstDayOfTimestamp を使う
//   規則 I: サーバーのコード (src/app/api・supabase/functions) で、Date を toLocaleDateString / toLocaleTimeString / toLocaleString、
//           Intl.DateTimeFormat で文字にするのに timeZone を指定しない。実行環境 (UTC) の暦日・時刻になる
// 例外は下の許可リストに、ファイルと件数と理由を書く (件数は「これ以上増やさない」上限ではなく、ちょうどの件数。直したら減らす)。
//
// 走査の限界 (構文だけを見るので、次は検出しない。レビューで見る):
//   - 変数の追跡はファイルの中で名前が同じものだけ (スコープは区別しない)。別の関数・別のファイルに渡した Date は追わない
//   - 規則 E は setter を当てた変数だけ。ローカル時刻の getter で読んだ値を自前で組み立てて文字列にする書き方
//     (`${d.getFullYear()}-${d.getMonth() + 1}-...`) は、Web / Mobile の画面では利用者の端末の暦日として正しい使い方もあるので数えない
//   - 規則 G は、列の名前を文字列のリテラルで書いた .gte / .gt / .lte / .lt だけ。.filter / .or / .match の中の条件と、
//     DB の関数 (RPC) に渡す引数 (p_from / p_to など) は見ない (RPC の引数はルートのテストで固定する。例: tests/admin-finance-nps-route.test.ts)
//   - 規則 G の「JST の暦日から作った時刻」は、その関数の呼び出しそのものか、同じファイルでその戻り値を入れた変数 (分割代入を含む) だけ
//   - 規則 H は、列の名前のプロパティ (`x.expires_at`) を直接切り出す形だけ。別の名前の変数に入れてから切り出す形は追わない
//   - 規則 I の options が変数 (オブジェクトのリテラルでない) のときは、timeZone があるか分からないので数えない
//
// 加えて、#1433 で直した箇所が JST の関数を使い続けていること (呼び出しが消えていないこと) も確かめる。

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** 走査する本番コードの場所 */
const SCAN_ROOTS = [
  'src',
  'lib',
  'supabase/functions',
  'apps/mobile/app',
  'apps/mobile/src',
  'packages/shared/src',
  'packages/core/src',
  'packages/handson-tour-shared/src',
] as const;

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

/** テスト・型宣言・依存は走査しない */
function isProductionSource(relPath: string): boolean {
  if (!SOURCE_EXTENSIONS.has(path.extname(relPath))) return false;
  if (relPath.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.[jt]sx?$/.test(relPath)) return false;
  const parts = relPath.split('/');
  return !parts.some((p) => p === 'node_modules' || p === '__tests__' || p === '__mocks__');
}

function listProductionSources(): string[] {
  const files: string[] = [];
  const walk = (absDir: string) => {
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(abs);
      } else if (isProductionSource(rel)) {
        files.push(rel);
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(path.join(ROOT, root));
  return files.sort();
}

type Rule = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';

interface Finding {
  rule: Rule;
  file: string;
  line: number;
  text: string;
}

/** `new Date()` (引数なし) か `new Date(Date.now() ...)` (Date.now() を含む式 1 つ) か */
function isNowDate(node: ts.Expression): boolean {
  const expr = skipParens(node);
  if (!ts.isNewExpression(expr) || !ts.isIdentifier(expr.expression) || expr.expression.text !== 'Date') return false;
  const args = expr.arguments ?? ts.factory.createNodeArray();
  if (args.length === 0) return true;
  return args.length === 1 && containsDateNow(args[0]);
}

function containsDateNow(node: ts.Node): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Date' &&
    node.expression.name.text === 'now'
  ) {
    return true;
  }
  return ts.forEachChild(node, containsDateNow) === true;
}

function skipParens(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** `<receiver>.toISOString()` の呼び出しなら receiver を返す */
function toIsoStringReceiver(node: ts.Expression): ts.Expression | null {
  const expr = skipParens(node);
  if (
    ts.isCallExpression(expr) &&
    expr.arguments.length === 0 &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === 'toISOString'
  ) {
    return expr.expression.expression;
  }
  return null;
}

function isNumericLiteral(node: ts.Expression | undefined, value: number): boolean {
  return !!node && ts.isNumericLiteral(node) && Number(node.text) === value;
}

/** 先頭 10 文字 (YYYY-MM-DD) を取り出す呼び出しの数 */
const DATE_PART_LENGTH = 10;

/** ローカル時刻の年・月・日から Date を作るときの引数の最小の数 (`new Date(y, m)` から。1 つだと時刻の値か文字列) */
const LOCAL_COMPONENT_MIN_ARGS = 2;

/**
 * 規則 F で探す「その日の終わり」の時刻の書き方。日付の文字列に足すと、UTC の 23:59:59 (= JST の翌日 8:59:59) か、
 * オフセットを書かなければ DB (UTC) の 23:59:59 として読まれる
 */
const END_OF_DAY_TIME_SUFFIX = 'T23:59:59';

/** ローカル時刻を動かす Date の setter (規則 E) */
const LOCAL_TIME_SETTERS = new Set(['setDate', 'setMonth', 'setFullYear', 'setHours']);

/**
 * node が「toISOString した文字列から日付を取り出す式」なら、toISOString の receiver を返す。
 *   - <receiver>.toISOString().slice(0, 10) / substring(0, 10) / substr(0, 10)
 *   - <receiver>.toISOString().split('T')[0]
 */
function datePartOfIsoReceiver(node: ts.Node): ts.Expression | null {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ['slice', 'substring', 'substr'].includes(node.expression.name.text) &&
    isNumericLiteral(node.arguments[0], 0) &&
    isNumericLiteral(node.arguments[1], DATE_PART_LENGTH)
  ) {
    return toIsoStringReceiver(node.expression.expression);
  }
  if (ts.isElementAccessExpression(node) && isNumericLiteral(node.argumentExpression, 0)) {
    const call = skipParens(node.expression);
    if (
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === 'split' &&
      call.arguments.length === 1 &&
      ts.isStringLiteralLike(call.arguments[0]) &&
      call.arguments[0].text === 'T'
    ) {
      return toIsoStringReceiver(call.expression.expression);
    }
  }
  return null;
}

/** `new Date(a, b, ...)` (ローカル時刻の年・月・日から作る Date) か */
function isLocalComponentDate(node: ts.Expression): boolean {
  const expr = skipParens(node);
  return (
    ts.isNewExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'Date' &&
    (expr.arguments?.length ?? 0) >= LOCAL_COMPONENT_MIN_ARGS
  );
}

/** ファイルの中で、規則 D・E が追う変数の名前を集める */
function collectTrackedDateNames(sf: ts.SourceFile): { localComponent: Set<string>; locallyMutated: Set<string> } {
  const localComponent = new Set<string>();
  const locallyMutated = new Set<string>();
  const visit = (node: ts.Node) => {
    // const d = new Date(y, m, d)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isLocalComponentDate(node.initializer)) {
      localComponent.add(node.name.text);
    }
    // d.setDate(...) など
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && LOCAL_TIME_SETTERS.has(node.expression.name.text)) {
      const target = skipParens(node.expression.expression);
      if (ts.isIdentifier(target)) locallyMutated.add(target.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { localComponent, locallyMutated };
}

/** 名前が timestamptz の列の印になる接尾辞 (規則 G・H)。created_at / sent_at / expires_at など */
const TIMESTAMPTZ_COLUMN_SUFFIX = '_at';

/**
 * 名前が _at で終わらない timestamptz の列 (規則 G・H)。supabase/migrations で timestamptz と宣言された列の名前から、
 * _at で終わるものと、関数の引数・変数 (p_ / v_ / _ で始まる名前) を除いたもの。
 * migrations と食い違わないことは、下の describe('規則 G・H の timestamptz の列の名前') で確かめる
 */
const TIMESTAMPTZ_COLUMNS_WITHOUT_AT_SUFFIX: ReadonlySet<string> = new Set([
  'cooling_until',
  'current_period_end',
  'current_period_start',
  'last_profile_update',
  'leased_until',
  'locked_until',
  'ocr_extraction_timestamp',
  'owner_last_sign_in',
  'past_due_since',
  'paused_until',
  'start_time',
  'valid_from',
  'valid_until',
]);

/** 列の名前 (埋め込んだ先の表の列 'user_daily_meals.created_at' も) が timestamptz の列か */
function isTimestamptzColumnName(name: string): boolean {
  const column = name.slice(name.lastIndexOf('.') + 1);
  return column.endsWith(TIMESTAMPTZ_COLUMN_SUFFIX) || TIMESTAMPTZ_COLUMNS_WITHOUT_AT_SUFFIX.has(column);
}

/** 期間で絞る PostgREST の絞り込みのメソッド (規則 G) */
const RANGE_FILTER_METHODS = new Set(['gte', 'gt', 'lte', 'lt']);

/**
 * JST の暦日から、timestamptz と比べる時刻 (ISO 8601) を 1 つ返す関数 (規則 G で、その戻り値を渡していれば数えない)。
 * jstDayStartTimestamp は packages/shared (src/lib/date-utils 経由)、jstDayEndInclusiveTimestamp は src/lib/jst-day-ranges.ts
 */
const JST_TIMESTAMP_FUNCTIONS = new Set(['jstDayStartTimestamp', 'jstDayEndInclusiveTimestamp']);

/**
 * JST の暦日の範囲から、timestamptz と比べる時刻の組を返す関数 (規則 G)。
 * jstDayRangeTimestamps / jstOptionalDayRangeTimestamps は src/lib/jst-day-ranges.ts、jstDayRangeToTimestamps は
 * supabase/functions/_shared/jst-date.ts。戻り値の分割代入で作った変数・戻り値を入れた変数のプロパティを、JST の時刻として扱う
 */
const JST_RANGE_FUNCTIONS = new Set(['jstDayRangeTimestamps', 'jstOptionalDayRangeTimestamps', 'jstDayRangeToTimestamps']);

/** 規則 I を当てる、サーバーで動くコードの場所 (実行環境のタイムゾーンは UTC) */
const SERVER_ONLY_PREFIXES = ['src/app/api/', 'supabase/functions/'] as const;

/** Date を文字にするメソッドのうち、Date にしか無いもの (規則 I)。toLocaleString は数値にもあるので、new Date(...) に当てたときだけ数える */
const DATE_ONLY_LOCALE_METHODS = new Set(['toLocaleDateString', 'toLocaleTimeString']);

/** 括弧と、TypeScript の非 null 表明 (`x!`) を外す */
function skipParensAndNonNull(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

/** callee が名前 (識別子) の呼び出しなら、その名前 */
function calleeName(node: ts.Expression): string | null {
  const expr = skipParens(node);
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text;
  return null;
}

/** ファイルの中で、JST の暦日から作った時刻を入れた変数 (values) と、時刻の組を入れた変数 (ranges) を集める (規則 G) */
function collectJstTimestampNames(sf: ts.SourceFile): { values: Set<string>; ranges: Set<string> } {
  const values = new Set<string>();
  const ranges = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const fn = calleeName(node.initializer);
      if (fn && JST_TIMESTAMP_FUNCTIONS.has(fn) && ts.isIdentifier(node.name)) values.add(node.name.text);
      if (fn && JST_RANGE_FUNCTIONS.has(fn)) {
        if (ts.isIdentifier(node.name)) ranges.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (ts.isIdentifier(element.name)) values.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { values, ranges };
}

/** 規則 G: 値が JST の暦日から作った時刻か (関数の呼び出しそのもの・その戻り値を入れた変数・時刻の組のプロパティ) */
function isJstTimestampExpression(node: ts.Expression, names: { values: Set<string>; ranges: Set<string> }): boolean {
  const expr = skipParensAndNonNull(node);
  if (ts.isIdentifier(expr)) return names.values.has(expr.text);
  const fn = calleeName(expr);
  if (fn) return JST_TIMESTAMP_FUNCTIONS.has(fn);
  if (ts.isPropertyAccessExpression(expr)) {
    const target = skipParensAndNonNull(expr.expression);
    return ts.isIdentifier(target) && names.ranges.has(target.text);
  }
  return false;
}

/** 式が timestamptz の列の値 (`row.created_at` / `row?.expires_at` / `data!.valid_until`) か (規則 H) */
function isTimestamptzPropertyValue(node: ts.Expression): boolean {
  const expr = skipParensAndNonNull(node);
  return ts.isPropertyAccessExpression(expr) && isTimestamptzColumnName(expr.name.text);
}

/**
 * 規則 H: 「先頭 10 文字 / split('T')[0] で日付にする」式の、切り出す前の文字列が timestamptz の値か。
 *   - row.created_at.slice(0, 10) / substring(0, 10) / substr(0, 10) / row.created_at.split('T')[0]
 *   - String(row.created_at).slice(0, 10)
 *   - new Date(row.created_at).toISOString().slice(0, 10)
 */
function isTimestamptzDatePart(node: ts.Node): boolean {
  let receiver: ts.Expression | null = null;
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ['slice', 'substring', 'substr'].includes(node.expression.name.text) &&
    isNumericLiteral(node.arguments[0], 0) &&
    isNumericLiteral(node.arguments[1], DATE_PART_LENGTH)
  ) {
    receiver = node.expression.expression;
  }
  if (ts.isElementAccessExpression(node) && isNumericLiteral(node.argumentExpression, 0)) {
    const call = skipParens(node.expression);
    if (
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === 'split' &&
      call.arguments.length === 1 &&
      ts.isStringLiteralLike(call.arguments[0]) &&
      call.arguments[0].text === 'T'
    ) {
      receiver = call.expression.expression;
    }
  }
  if (!receiver) return false;
  const value = skipParensAndNonNull(receiver);
  if (isTimestamptzPropertyValue(value)) return true;
  // String(row.created_at)
  if (calleeName(value) === 'String' && ts.isCallExpression(value) && value.arguments.length === 1) {
    return isTimestamptzPropertyValue(value.arguments[0]);
  }
  // new Date(row.created_at).toISOString()
  const isoReceiver = toIsoStringReceiver(value);
  if (isoReceiver) {
    const date = skipParens(isoReceiver);
    return (
      ts.isNewExpression(date) &&
      ts.isIdentifier(date.expression) &&
      date.expression.text === 'Date' &&
      date.arguments?.length === 1 &&
      isTimestamptzPropertyValue(date.arguments[0])
    );
  }
  return false;
}

/** 規則 I: Date を文字にするときの options (第 2 引数) に timeZone があるか。オブジェクトのリテラルでなければ分からないので「ある」とみなす */
function hasTimeZoneOption(options: ts.Expression | undefined): boolean {
  if (!options) return false;
  const expr = skipParens(options);
  if (!ts.isObjectLiteralExpression(expr)) return true;
  return expr.properties.some(
    (p) =>
      ts.isSpreadAssignment(p) ||
      ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === 'timeZone'),
  );
}

/** `Intl.DateTimeFormat` (new を付けても付けなくても) か */
function isIntlDateTimeFormat(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'Intl' &&
    node.name.text === 'DateTimeFormat'
  );
}

/** 本番コード 1 ファイルの検出結果 */
function scanSource(file: string, source: string): Finding[] {
  const kind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const findings: Finding[] = [];
  const isEdgeFunction = file.startsWith('supabase/functions/');
  const isServerOnly = SERVER_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix));
  const push = (rule: Rule, node: ts.Node) => {
    const pos = node.getStart(sf);
    findings.push({
      rule,
      file,
      line: sf.getLineAndCharacterOfPosition(pos).line + 1,
      text: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120),
    });
  };

  const tracked = collectTrackedDateNames(sf);
  const jstTimestampNames = collectJstTimestampNames(sf);

  const visit = (node: ts.Node) => {
    // 規則 A: <now>.toISOString().slice(0, 10) / substring(0, 10) / substr(0, 10) / split('T')[0]
    const datePartReceiver = datePartOfIsoReceiver(node);
    if (datePartReceiver && isNowDate(datePartReceiver)) push('A', node);
    // 規則 E: ローカル時刻の setter を当てた変数を toISOString して日付にする
    if (datePartReceiver) {
      const receiver = skipParens(datePartReceiver);
      if (ts.isIdentifier(receiver) && tracked.locallyMutated.has(receiver.text)) push('E', node);
    }
    // 規則 D: ローカル時刻の年・月・日から作った Date (と、それで初期化した変数) の toISOString
    // (括弧で囲んだ式を二重に数えないよう、呼び出しそのものだけを見る)
    if (ts.isCallExpression(node)) {
      const isoReceiver = toIsoStringReceiver(node);
      if (isoReceiver) {
        const receiver = skipParens(isoReceiver);
        if (isLocalComponentDate(receiver) || (ts.isIdentifier(receiver) && tracked.localComponent.has(receiver.text))) {
          push('D', node);
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      // 規則 B: new Date().getMonth() など (今の時刻をローカル時刻で読む)
      if (['getMonth', 'getDate', 'getDay', 'getFullYear'].includes(method) && isNowDate(node.expression.expression)) {
        push('B', node);
      }
      // 規則 C: Edge Functions の中のローカル時刻の Date のメソッド
      if (isEdgeFunction && LOCAL_TIME_METHODS.has(method)) {
        push('C', node);
      }
      // 規則 G: timestamptz の列を、JST の暦日から作った時刻以外の値で .gte / .gt / .lte / .lt する
      const [column, value] = node.arguments;
      if (
        RANGE_FILTER_METHODS.has(method) &&
        column &&
        value &&
        ts.isStringLiteralLike(column) &&
        isTimestamptzColumnName(column.text) &&
        !isJstTimestampExpression(value, jstTimestampNames)
      ) {
        push('G', node);
      }
      // 規則 I: サーバーのコードで、Date を timeZone を指定せずに文字にする (toLocaleString は new Date(...) に当てたときだけ)
      const receiver = skipParens(node.expression.expression);
      const isDateLocaleCall =
        DATE_ONLY_LOCALE_METHODS.has(method) ||
        (method === 'toLocaleString' && ts.isNewExpression(receiver) && ts.isIdentifier(receiver.expression) && receiver.expression.text === 'Date');
      if (isServerOnly && isDateLocaleCall && !hasTimeZoneOption(node.arguments[1])) {
        push('I', node);
      }
    }
    // 規則 I: サーバーのコードで、timeZone を指定しない Intl.DateTimeFormat
    if (
      isServerOnly &&
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      isIntlDateTimeFormat(node.expression) &&
      !hasTimeZoneOption(node.arguments?.[1])
    ) {
      push('I', node);
    }
    // 規則 H: timestamptz の値を先頭 10 文字 / split('T')[0] で日付にする (UTC の暦日になる)
    if (isTimestamptzDatePart(node)) push('H', node);
    // 規則 F: 'T23:59:59' を含む文字列 (リテラル・テンプレートの各部分。コメントは構文木に無いので見ない)
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
      node.text.includes(END_OF_DAY_TIME_SUFFIX)
    ) {
      push('F', node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

/** 実行環境のローカル時刻で答える・動かす Date のメソッド */
const LOCAL_TIME_METHODS = new Set([
  'getDate',
  'getDay',
  'getMonth',
  'getFullYear',
  'getHours',
  'getMinutes',
  'setDate',
  'setMonth',
  'setFullYear',
  'setHours',
  'setMinutes',
]);

/**
 * 規則の例外。ファイルごとに、規則と件数と理由を書く。
 * 規則 A〜F・H は、どれも「利用者が見る日付・DB の日付列と比べる日付」ではないもの (または書き込みの変換と対で別に直すもの)。
 * 規則 G は、暦日ではない時刻 (今からの相対時刻・入口で検査した ISO の日時・カーソル) で絞るものと、
 * 画面から呼ばれない (期間を送る呼び出し元が無い) API。画面から期間を選べるようにするときは、許可リストから外して直す。
 */
const ALLOWLIST: ReadonlyArray<{ file: string; rule: Rule; count: number; reason: string }> = [
  {
    file: 'src/app/api/admin/finance/exports/route.ts',
    rule: 'A',
    count: 4,
    reason: 'CSV のダウンロードのファイル名の日付。DB の日付と比べない。ファイル名は他のエクスポートと同じく UTC の日付にそろえている',
  },
  {
    file: 'src/app/api/super-admin/audit-logs/route.ts',
    rule: 'A',
    count: 1,
    reason: 'CSV のダウンロードのファイル名の日付 (UTC の日付にそろえている)',
  },
  {
    file: 'src/app/super-admin/audit-logs/page.tsx',
    rule: 'A',
    count: 1,
    reason: 'CSV のダウンロードのファイル名の日付 (UTC の日付にそろえている)',
  },
  {
    file: 'src/app/api/export/meals/route.ts',
    rule: 'A',
    count: 1,
    reason: '食事の CSV のファイル名の日付。個人データの JSON (buildExportFilename・UTC の日付を tests/account-export.test.ts が固定) とそろえている',
  },
  {
    file: 'src/app/(main)/settings/page.tsx',
    rule: 'A',
    count: 2,
    reason: 'エクスポートのファイル名の日付。API が付けるファイル名 (UTC の日付) とそろえている',
  },
  {
    file: 'apps/mobile/app/(tabs)/settings.tsx',
    rule: 'A',
    count: 2,
    reason: 'エクスポートのファイル名の日付。API が付けるファイル名 (UTC の日付) とそろえている',
  },
  {
    file: 'src/app/(main)/settings/page.tsx',
    rule: 'B',
    count: 1,
    reason: '画面下の著作権表示の年 (© 2026)。日付の判定や DB の日付と比べない',
  },
  {
    file: 'src/app/super-admin/coupons/new/page.tsx',
    rule: 'A',
    count: 1,
    reason:
      'クーポンの有効開始日の初期値。送信時に new Date(validFrom).toISOString() で UTC の 0 時に変換するので、初期値だけ JST にすると ' +
      'JST の 0:00〜8:59 に作ったクーポンが数時間有効にならない。変換と合わせて別に直す',
  },
  {
    file: 'src/app/super-admin/coupons/[id]/page.tsx',
    rule: 'H',
    count: 1,
    reason:
      'クーポンの有効期限の編集欄の初期値 (valid_until)。保存時に new Date(validUntil).toISOString() (UTC の 0 時) で書き戻すので、' +
      '読み出しも UTC の暦日で対にしている (この画面で保存した値は UTC の 0 時 = JST の同じ日の 9 時なので、どちらで読んでも同じ日付)。' +
      '有効期限を JST のその日の終わりまでにするかは、coupons/new の有効開始日 (規則 A の許可) と合わせて、書き込みの変換と一緒に別に直す',
  },
  // ---- 規則 G: timestamptz の列を、画面で選んだ JST の暦日ではない値で絞る箇所 (ルートごとに件数と理由) ----
  {
    file: 'src/app/api/admin/finance/invoices/route.ts',
    rule: 'G',
    count: 2,
    reason:
      '請求書の一覧 (received_at)。画面 (src/app/admin/finance/invoices/page.tsx) は「課金は未開始のため準備中」で、この API を呼ばない。' +
      '画面を作るときに、CSV の書き出し (finance/exports の invoices) と同じく jstOptionalDayRangeTimestamps で直す',
  },
  {
    file: 'src/app/api/admin/finance/reconciliation/route.ts',
    rule: 'G',
    count: 2,
    reason:
      'Stripe の整合チェックの一覧 (admin_audit_logs.created_at)。画面 (src/app/admin/finance/reconciliation/page.tsx) は' +
      '「課金は未開始のため準備中」で、この API を呼ばない。画面を作るときに jstOptionalDayRangeTimestamps で直す',
  },
  {
    file: 'src/app/api/super-admin/infra/metrics/route.ts',
    rule: 'G',
    count: 2,
    reason: 'from / to は入口 (InfraMetricsQuerySchema) で ISO 8601 の日時 (z.string().datetime()) として検査した時刻。暦日ではない',
  },
  {
    file: 'src/app/api/super-admin/logs/route.ts',
    rule: 'G',
    count: 3,
    reason:
      'from / to は入口 (parseAppLogsQuery) でオフセットつきの ISO 8601 の日時として検査した時刻、残りの 1 つはカーソル ' +
      '(前のページの最後の行の created_at)。どれも暦日ではない',
  },
  {
    file: 'src/app/api/support/stats/route.ts',
    rule: 'G',
    count: 1,
    reason: '「今週の対応件数」の 7 日前の今の時刻 (今からの相対時刻)。暦日ではない (「今日の解決件数」は jstDayStartTimestamp で JST 0 時から)',
  },
  {
    file: 'src/app/api/support/users/[id]/route.ts',
    rule: 'G',
    count: 1,
    reason: '最近の AI セッション数の 30 日前の今の時刻 (今からの相対時刻)。暦日ではない',
  },
  {
    file: 'src/app/api/ai/menu/weekly/cleanup/route.ts',
    rule: 'G',
    count: 1,
    reason: '止まった生成の判定に使う 5 分前の時刻 (今からの相対時刻)。暦日ではない',
  },
];

const sources = listProductionSources();
const findings = sources.flatMap((file) => scanSource(file, fs.readFileSync(path.join(ROOT, file), 'utf8')));

describe('走査そのもの', () => {
  it('本番コードを読んでいる (走査する場所が空振りしていない)', () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(sources).toContain('supabase/functions/generate-menu-v4/index.ts');
    expect(sources).toContain('src/app/api/ai/nutrition-analysis/route.ts');
    expect(sources).toContain('apps/mobile/app/health/graphs.tsx');
    expect(sources.some((f) => /\.test\.[jt]sx?$/.test(f))).toBe(false);
  });

  it.each([
    ["const t = new Date().toISOString().slice(0, 10);", 'A'],
    ["const t = new Date().toISOString().split('T')[0];", 'A'],
    ['const t = new Date().toISOString().substring(0, 10);', 'A'],
    ['const t = (new Date()).toISOString().slice(0, 10);', 'A'],
    ['const t = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);', 'A'],
    ['const m = new Date().getMonth() + 1;', 'B'],
    // 規則 D: ローカル時刻の年・月・日から作った Date の toISOString (#1433 の finance/dashboard の書き方。複数行のチェーンでも)
    ['const s = new Date(today.getFullYear(), today.getMonth(), 1)\n  .toISOString()\n  .slice(0, 10);', 'D'],
    ['const s = new Date(y, m - 1, 0).toISOString();', 'D'],
    ['const s = (new Date(y, m, 1).toISOString()).slice(0, 10);', 'D'],
    ['const d = new Date(y, m, 1);\nconst s = d.toISOString().split("T")[0];', 'D'],
    // 規則 E: ローカル時刻の setter を当てた変数を toISOString して日付にする
    ['const d = new Date();\nd.setDate(d.getDate() - 7);\nconst s = d.toISOString().slice(0, 10);', 'E'],
    ['const d = new Date(base);\nd.setMonth(d.getMonth() + 1);\nconst s = d.toISOString().split("T")[0];', 'E'],
    // 規則 F: 日付の文字列に足して「その日の終わり」の時刻を作る (#1433 の監査ログ 2 ルートの書き方)
    ['const end = `${to}T23:59:59.999Z`;', 'F'],
    ['const end = `${to}T23:59:59`;', 'F'],
    ['const end = to + "T23:59:59+09:00";', 'F'],
    // 規則 G: timestamptz の列を、画面の日付 (の文字列) で絞る (#1433 の NPS / CSAT・CSV の書き出し・監査ログの書き方)
    ["if (from) q = q.gte('sent_at', from);", 'G'],
    ["if (to) q = q.lte('created_at', to);", 'G'],
    ["q = q.lt('received_at', '2026-10-10');", 'G'],
    ["q = q.gt('user_daily_meals.created_at', day);", 'G'], // 埋め込んだ先の表の列
    ["q = q.lte('valid_until', until);", 'G'], // 名前が _at で終わらない timestamptz の列
    ["q = q.gte('created_at', sevenDaysAgo.toISOString());", 'G'], // 暦日ではない時刻も数える (理由を許可リストに書く)
    // 規則 G は、名前が JST の関数と同じでも、その戻り値を入れていない変数は数える
    ["const fromTimestamp = from; q = q.gte('created_at', fromTimestamp);", 'G'],
    // 規則 H: timestamptz の値を UTC の暦日として切り出す (#1433 の招待メールの期限の書き方)
    ['const d = invite.expires_at.slice(0, 10);', 'H'],
    ['const d = inviteRow.expires_at.substring(0, 10);', 'H'],
    ["const d = row?.created_at?.split('T')[0];", 'H'],
    ['const d = data.data!.valid_until.slice(0, 10);', 'H'],
    ['const d = String(row.sent_at).slice(0, 10);', 'H'],
    ['const d = new Date(row.created_at).toISOString().slice(0, 10);', 'H'],
  ] as const)('検出する: %s', (code, rule) => {
    expect(scanSource('src/example.ts', code).map((f) => f.rule)).toEqual([rule]);
  });

  it('監査ログの以前の書き方 (終了日を UTC の 23:59:59 で閉じる) は、規則 G と規則 F の両方で検出する', () => {
    const code = "if (to) query = query.lte('created_at', to + 'T23:59:59Z');";
    expect(scanSource('src/example.ts', code).map((f) => f.rule).sort()).toEqual(['F', 'G']);
  });

  it.each([
    "const s = new Date(m.created_at).toLocaleDateString('ja-JP');",
    "const s = d.toLocaleTimeString('ja-JP', { hour: '2-digit' });",
    "const s = new Date(x).toLocaleString('ja-JP');",
    "const f = new Intl.DateTimeFormat('ja-JP', { year: 'numeric' });",
    "const f = Intl.DateTimeFormat('ja-JP');",
  ])('サーバーのコード (src/app/api・supabase/functions) で検出する (規則 I): %s', (code) => {
    expect(scanSource('src/app/api/example/route.ts', code).map((f) => f.rule)).toEqual(['I']);
    expect(scanSource('supabase/functions/example/index.ts', code).map((f) => f.rule)).toEqual(['I']);
    // 画面のコードは利用者の端末のタイムゾーンで書くのが正しい使い方もあるので、規則 I は当てない
    expect(scanSource('src/app/example/page.tsx', code)).toEqual([]);
  });

  it.each([
    "const s = new Date(m.created_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });",
    "const s = d.toLocaleTimeString('ja-JP', { hour: '2-digit', timeZone: TZ });",
    'const s = d.toLocaleDateString("sv-SE", { timeZone });',
    "const s = d.toLocaleDateString('ja-JP', OPTIONS);", // options が変数のときは分からないので数えない (走査の限界)
    "const f = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric' });",
    'const s = price.toLocaleString();', // 数値の toLocaleString は Date ではない
    "const s = (1234).toLocaleString('ja-JP');",
  ])('サーバーのコードでも検出しない (規則 I): %s', (code) => {
    expect(scanSource('src/app/api/example/route.ts', code)).toEqual([]);
  });

  it.each([
    'const t = todayLocal();',
    'const t = new Date(Date.UTC(2026, 0, 1)).toISOString().slice(0, 10);', // 暦の計算 (時刻を持たない)
    "const t = new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10);",
    'const ts = new Date().toISOString();', // 時刻 (timestamptz) はそのまま使ってよい
    '// const t = new Date().toISOString().slice(0, 10);', // コメントは見ない
    "const s = 'new Date().toISOString().slice(0, 10)';", // 文字列は見ない
    'const ts = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);', // Date.UTC は引数 1 つ (暦の計算)
    'const d = new Date(Date.now()); d.setUTCDate(d.getUTCDate() - 7); const s = d.toISOString().slice(0, 10);', // UTC の setter
    'const d = new Date(); d.setDate(d.getDate() + 30); const at = d.toISOString();', // 時刻 (timestamptz) のまま使う
    "// .lte('created_at', to + 'T23:59:59Z')", // コメントの中の 'T23:59:59' は見ない
    // 規則 G: JST の暦日から作った時刻で絞る
    "const { fromTimestamp, toTimestampExclusive } = jstOptionalDayRangeTimestamps(from, to); q = q.gte('created_at', fromTimestamp).lt('created_at', toTimestampExclusive);",
    "const { fromTimestamp: start } = jstDayRangeTimestamps(a, b); q = q.gte('created_at', start);", // 分割代入で名前を変えても
    "const todayStart = jstDayStartTimestamp(jstToday()); q = q.gte('resolved_at', todayStart);",
    "q = q.lte('sent_at', jstDayEndInclusiveTimestamp(to));",
    "q = q.gte('sent_at', jstDayStartTimestamp(from)!);",
    "const range = jstDayRangeToTimestamps(a, b); q = q.gte('eaten_at', range.from).lt('eaten_at', range.before);", // Edge の関数
    "q = q.gte('day_date', from).lte('day_date', to);", // date 型の列 (暦日そのもの) は日付のまま絞ってよい
    "q = q.gte('record_date', start).lte('cooking_time_minutes', 30);",
    // 規則 H: date 型の列・JST の暦日にしてから使う値
    'const d = goal.target_date.slice(0, 10);',
    'const d = jstDayOfTimestamp(invite.expires_at);',
    "const d = String(day?.day_date ?? '').slice(0, 10);",
    'const d = invite.expires_at;',
  ])('検出しない: %s', (code) => {
    expect(scanSource('src/example.ts', code)).toEqual([]);
  });

  it('Edge Functions のローカル時刻のメソッドを検出する (規則 C)。Edge 以外では検出しない', () => {
    const code = 'const d = new Date(day); d.setDate(d.getDate() + 1);';
    expect(scanSource('supabase/functions/example/index.ts', code).map((f) => f.rule)).toEqual(['C', 'C']);
    expect(scanSource('src/example.ts', code)).toEqual([]);
    expect(scanSource('supabase/functions/example/index.ts', 'd.setUTCDate(d.getUTCDate() + 1);')).toEqual([]);
  });
});

/** supabase/migrations の SQL から、timestamptz と宣言された名前 (列・関数の引数・変数) を集める */
const TIMESTAMPTZ_DECLARATION = /(?:^|[(,]|ADD COLUMN(?: IF NOT EXISTS)?)\s*"?([a-z_][a-z0-9_]*)"?\s+(?:timestamp with time zone|timestamptz)\b/gim;
/** 関数の引数 (p_from など)・PL/pgSQL の変数 (v_now など) の名前。列ではない */
const NON_COLUMN_NAME = /^(?:p_|v_|_)/;

function timestamptzNamesWithoutAtSuffixInMigrations(): Set<string> {
  const dir = path.join(ROOT, 'supabase/migrations');
  const names = new Set<string>();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of sql.matchAll(TIMESTAMPTZ_DECLARATION)) {
      const name = match[1].toLowerCase();
      if (!name.endsWith(TIMESTAMPTZ_COLUMN_SUFFIX) && !NON_COLUMN_NAME.test(name)) names.add(name);
    }
  }
  return names;
}

describe('規則 G・H の timestamptz の列の名前', () => {
  it('名前が _at で終わらない timestamptz の列の一覧 (TIMESTAMPTZ_COLUMNS_WITHOUT_AT_SUFFIX) が、supabase/migrations の宣言と一致する', () => {
    // migrations に新しい timestamptz の列 (名前が _at で終わらないもの) が増えたら、ここで落ちる。一覧に足すこと
    // (足さないと、その列を画面の日付で絞る書き方・UTC の暦日に切り出す書き方を規則 G・H が見逃す)
    expect([...timestamptzNamesWithoutAtSuffixInMigrations()].sort()).toEqual([...TIMESTAMPTZ_COLUMNS_WITHOUT_AT_SUFFIX].sort());
  });

  it('migrations の読み取りが空振りしていない (_at で終わる timestamptz の列も同じ書き方で読める)', () => {
    const dir = path.join(ROOT, 'supabase/migrations');
    const all = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .flatMap((f) => [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(TIMESTAMPTZ_DECLARATION)].map((m) => m[1]));
    expect(all).toContain('created_at');
    expect(all).toContain('sent_at');
    expect(all).toContain('expires_at');
    expect(all).toContain('valid_until');
  });

  it.each([
    ['created_at', true],
    ['user_daily_meals.created_at', true],
    ['valid_until', true],
    ['current_period_end', true],
    ['day_date', false],
    ['record_date', false],
    ['target_date', false],
    ['date', false],
  ] as const)('%s は timestamptz の列として扱う: %s', (name, expected) => {
    expect(isTimestamptzColumnName(name)).toBe(expected);
  });
});

describe('「今日」を UTC の暦日・ローカル時刻で決める書き方が本番コードに無い (#1433)', () => {
  it('許可リストにないファイルに、規則 A / B / C / D / E / F / G / H / I の書き方が無い', () => {
    const unexpected = findings.filter((f) => !ALLOWLIST.some((entry) => entry.file === f.file && entry.rule === f.rule));
    const message = unexpected
      .map(
        (f) =>
          `${f.file}:${f.line} [規則 ${f.rule}] ${f.text}\n` +
          '  → Edge Functions は supabase/functions/_shared/jst-date.ts (todayJst / addDaysToDate / monthJst)、' +
          'Web / Mobile は packages/shared (todayLocal / formatLocalDate / addDaysToDate / monthLocal) か src/lib/jst-day-ranges.ts を使う。' +
          'timestamptz の列を日付で絞るときは jstDayRangeTimestamps / jstOptionalDayRangeTimestamps (.gte と .lt。' +
          '両端を含む DB の関数には jstDayEndInclusiveTimestamp)、timestamptz の値を日付にするときは jstDayOfTimestamp、' +
          'サーバーで Date を文字にするときは timeZone: \'Asia/Tokyo\' を指定する。暦日ではない時刻 (今からの相対時刻など) で絞るなら、理由を許可リストに書く',
      )
      .join('\n');
    expect(unexpected, message).toEqual([]);
  });

  it.each(ALLOWLIST.map((entry) => [`${entry.file} (規則 ${entry.rule})`, entry] as const))(
    '許可リストの件数がちょうど (%s)。直したら許可リストから減らす',
    (_label, entry) => {
      expect(fs.existsSync(path.join(ROOT, entry.file)), `${entry.file} が無い。許可リストから消す`).toBe(true);
      expect(findings.filter((f) => f.file === entry.file && f.rule === entry.rule).length, entry.reason).toBe(entry.count);
    },
  );
});

/**
 * #1433 で直した箇所が、JST の関数を呼び続けていること。
 * 規則 A〜C は「悪い書き方」を見るが、別の悪い書き方 (例えば自前の UTC+9 の計算) に置き換わっても気づけないので、
 * 直した箇所ごとに、使うべき関数の呼び出しが残っていることを確かめる。
 */
const REQUIRED_CALLS: Record<string, string[]> = {
  // Edge Functions (献立生成)。今日 (賞味期限・過去の献立の判定)・日付のずらし・旬の月
  'supabase/functions/generate-menu-v4/index.ts': ['todayJst', 'addDaysToDate', 'monthJst'],
  'supabase/functions/generate-menu-v5/index.ts': ['todayJst', 'addDaysToDate', 'monthJst'],
  'supabase/functions/regenerate-shopping-list-v2/index.ts': ['getUTCDay'],
  // Next の API ルート
  'src/app/api/ai/nutrition-analysis/route.ts': ['nutritionAnalysisRange'],
  'src/app/api/ai/menu/weekly/request/route.ts': ['addDaysToDate', 'isCalendarDate', 'todayLocal'],
  'src/app/api/ai/menu/v4/generate/route.ts': ['addDaysToDate', 'todayLocal', 'getUTCMonth'],
  'src/app/api/ai/menu/v5/generate/route.ts': ['addDaysToDate', 'todayLocal'],
  'src/app/api/ai/menu/meal/pending/route.ts': ['sundayWeekRange', 'isCalendarDate'],
  'src/app/api/ai/consultation/sessions/route.ts': ['jstDayOffset'],
  'src/app/api/support/stats/route.ts': ['jstDayStartTimestamp', 'jstToday'],
  'src/app/api/meals/route.ts': ['jstToday'],
  'src/app/api/badges/route.ts': ['consecutiveDayStreak'],
  'src/app/api/health/challenges/route.ts': ['challengePeriod'],
  'src/app/api/health/checkups/route.ts': ['jstToday'],
  'src/app/api/health/blood-tests/route.ts': ['jstToday'],
  'src/app/api/health/records/[date]/route.ts': ['addDaysToDate', 'isCalendarDate'],
  'src/app/api/performance/analyze/route.ts': ['jstToday'],
  'src/app/api/performance/checkins/route.ts': ['jstToday', 'jstDayOffset'],
  'src/app/api/performance/plans/route.ts': ['jstToday'],
  'src/app/api/super-admin/llm/usage/route.ts': ['llmUsageRange', 'jstDayRangeTimestamps', 'jstDayOfTimestamp'],
  'src/app/api/super-admin/audit-logs/route.ts': ['jstOptionalDayRangeTimestamps'],
  'src/app/api/operator/membership/audit/route.ts': ['jstOptionalDayRangeTimestamps'],
  'src/app/api/admin/finance/dashboard/route.ts': ['jstMonthBoundaries'],
  'src/app/api/admin/finance/nps/route.ts': ['jstOptionalDayRangeTimestamps', 'jstDayEndInclusiveTimestamp'],
  'src/app/api/admin/finance/exports/route.ts': ['jstOptionalDayRangeTimestamps'],
  'src/app/api/family/invites/route.ts': ['jstDayOfTimestamp'],
  'src/lib/membership/org-invite.ts': ['jstDayOfTimestamp'],
  'src/app/api/menu-plans/add/route.ts': ['jstDayOffset'],
  'src/app/api/admin/finance/revenue/route.ts': ['jstDayOffset'],
  'src/app/api/org/owner-transfer/propose/route.ts': ['formatLocalDate'],
  'src/lib/ai/consultation-action-executor.ts': ['addDaysToDate', 'isCalendarDate'],
  // 献立生成の共通処理
  'lib/slot-builder.ts': ['addDaysToDate', 'isCalendarDate'],
  'lib/seasonal-ingredients.ts': ['formatLocalDate'],
  'lib/seasonal-events.ts': ['addDaysToDate', 'formatLocalDate'],
  // 画面 (Web)
  'src/app/(main)/health/goals/page.tsx': ['todayLocal'],
  'src/app/(main)/health/settings/page.tsx': ['todayLocal'],
  'src/app/(main)/meals/new/page.tsx': ['todayLocal'],
  'src/app/admin/sales/[id]/page.tsx': ['todayLocal'],
  'src/app/onboarding/questions/page.tsx': ['todayLocal'],
  'src/components/ai-assistant/V4GenerateModal.tsx': ['addDaysToDate'],
  // 画面 (モバイル)
  'apps/mobile/app/health/graphs.tsx': ['healthGraphFetchStartDate', 'healthGraphDateSlots'],
  'apps/mobile/src/components/menu/V4GenerateModal.tsx': ['addDaysToDate'],
  'apps/mobile/src/components/ai/AIDayMenuModal.tsx': ['todayLocal'],
};

/** ファイルの中で呼ばれている関数・メソッドの名前 (構文木で見るので、コメントや文字列の中は数えない) */
function calledNames(file: string): Set<string> {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) names.add(callee.text);
      if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

describe('#1433 で直した箇所が JST の関数を使い続けている', () => {
  it.each(Object.entries(REQUIRED_CALLS))('%s', (file, required) => {
    const names = calledNames(file);
    for (const name of required) {
      expect(names.has(name), `${file} から ${name}() の呼び出しが消えた`).toBe(true);
    }
  });

  it('献立生成 v4 / v5 (Edge) の getTodayStr は todayJst を返すだけ (UTC の暦日に戻っていない)', () => {
    for (const file of ['supabase/functions/generate-menu-v4/index.ts', 'supabase/functions/generate-menu-v5/index.ts']) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(source, file).toMatch(/function getTodayStr\(\): string \{\s*return todayJst\(\);\s*\}/);
      expect(source, file).toMatch(/import \{[^}]*\btodayJst\b[^}]*\} from "\.\.\/_shared\/jst-date\.ts";/);
    }
  });
});
