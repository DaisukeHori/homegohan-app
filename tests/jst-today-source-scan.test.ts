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
// 例外は下の許可リストに、ファイルと件数と理由を書く (件数は「これ以上増やさない」上限ではなく、ちょうどの件数。直したら減らす)。
//
// 走査の限界 (構文だけを見るので、次は検出しない。レビューで見る):
//   - 変数の追跡はファイルの中で名前が同じものだけ (スコープは区別しない)。別の関数・別のファイルに渡した Date は追わない
//   - 規則 E は setter を当てた変数だけ。ローカル時刻の getter で読んだ値を自前で組み立てて文字列にする書き方
//     (`${d.getFullYear()}-${d.getMonth() + 1}-...`) は、Web / Mobile の画面では利用者の端末の暦日として正しい使い方もあるので数えない
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

type Rule = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

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

/** 本番コード 1 ファイルの検出結果 */
function scanSource(file: string, source: string): Finding[] {
  const kind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const findings: Finding[] = [];
  const isEdgeFunction = file.startsWith('supabase/functions/');
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
    }
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
 * どれも「利用者が見る日付・DB の日付列と比べる日付」ではないもの。
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
    ["if (to) query = query.lte('created_at', to + 'T23:59:59Z');", 'F'],
    ['const end = `${to}T23:59:59.999Z`;', 'F'],
    ['const end = `${to}T23:59:59`;', 'F'],
    ['const end = to + "T23:59:59+09:00";', 'F'],
  ] as const)('検出する: %s', (code, rule) => {
    expect(scanSource('src/example.ts', code).map((f) => f.rule)).toEqual([rule]);
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
    "const { toTimestampExclusive } = jstOptionalDayRangeTimestamps(from, to); q = q.lt('created_at', toTimestampExclusive);",
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

describe('「今日」を UTC の暦日・ローカル時刻で決める書き方が本番コードに無い (#1433)', () => {
  it('許可リストにないファイルに、規則 A / B / C / D / E / F の書き方が無い', () => {
    const unexpected = findings.filter((f) => !ALLOWLIST.some((entry) => entry.file === f.file && entry.rule === f.rule));
    const message = unexpected
      .map(
        (f) =>
          `${f.file}:${f.line} [規則 ${f.rule}] ${f.text}\n` +
          '  → Edge Functions は supabase/functions/_shared/jst-date.ts (todayJst / addDaysToDate / monthJst)、' +
          'Web / Mobile は packages/shared (todayLocal / formatLocalDate / addDaysToDate / monthLocal) か src/lib/jst-day-ranges.ts を使う。' +
          'timestamptz の列を日付で絞るときは jstDayRangeTimestamps / jstOptionalDayRangeTimestamps (.gte と .lt)',
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
