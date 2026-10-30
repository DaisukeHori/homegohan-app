/**
 * #2073 の続き: 運営の画面 (src/app/super-admin) の書き込みの通信 (fetch の POST / PATCH / PUT / DELETE) を走査し、
 * 1 か所ずつ「通信が reject されたら今の状態を読み直す」か「対象外 (理由つき)」かに分けた表と突き合わせる。
 *
 * 状態の変更 (公開・一時停止・廃止・開始・切り替え・削除・再送 など) は、サーバーが変更を済ませてから応答が切れることがあるので、
 * 通信が reject されたら今の状態を読み直し、「<操作>の応答を受け取れませんでした（通信エラー）」の文を出す
 * (src/lib/super-admin/status-change-no-response.ts。振る舞いは super-admin-status-reject-reload-2073.test.tsx が確かめる)。
 * 書き込みの通信が増えた・減った・移ったら、この表が赤になるので、どちらに当たるかを決めて表を直す
 * (同じ型の取りこぼしを、画面を 1 つずつ探して見つけるのではなく、表の突き合わせで見つける)。
 *
 * 走査はソースの構文木 (TypeScript) で行う。コメント・文字列の中は見ない。
 * 限界 (見張りであって証明ではない): fetch を別の関数・別のファイル (src/lib など) に包んで呼ぶ書き方と、method を変数で渡す書き方は
 * 数えない。表の「reread」は、その画面が読み直しの文の部品を import していることまでを見る (読み直しの振る舞いそのものは見ない)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'src/app/super-admin';
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** 通信の reject のあとの読み直しの文の部品 (どちらかを import していれば、その画面は読み直しの文を出す) */
const NO_RESPONSE_MODULES = ['@/lib/super-admin/status-change-no-response', '@/lib/super-admin/experiment-status-display'];

type WriteHandling =
  /** 状態の変更。通信が reject されたら今の状態を読み直す (#2073) */
  | { kind: 'reread'; method: string; what: string }
  /** 状態の変更ではない (作成・値の編集)。読み直しの対象外。理由を書く */
  | { kind: 'exempt'; method: string; what: string; reason: string };

const CREATE_REASON =
  '作成 (状態の変更ではない)。応答が切れたあとに押し直すと二重に作られうるが、自分の操作を「別の運営が先に…」と言う 409 にはならない。#2073 の範囲 (状態の変更) の外';
const VALUE_EDIT_REASON =
  '値の編集 (状態の変更ではない)。送るのは変えた欄の値だけで、押し直しても同じ値を書き直すだけ (自分の操作で 409 にならない)。#2073 の範囲の外';

/** 画面ごとの書き込みの通信の表 (ファイルの中の出てくる順) */
const EXPECTED: Readonly<Record<string, readonly WriteHandling[]>> = {
  'src/app/super-admin/backups/page.tsx': [
    {
      kind: 'exempt',
      method: 'POST',
      what: '復旧の訓練の記録の追加',
      reason:
        '作成 (状態の変更ではない)。応答を受け取れなかったら訓練の記録の一覧を読み直し、送った内容の行ができていたかを確かめ、確かめられなければ送信を止める (#2101 X2。振る舞いは admin-create-no-response-2101.test.tsx が確かめる)。#2073 の範囲 (状態の変更) の外',
    },
  ],
  'src/app/super-admin/coupons/[id]/page.tsx': [
    { kind: 'exempt', method: 'PATCH', what: 'クーポンの保存', reason: VALUE_EDIT_REASON },
    { kind: 'reread', method: 'PATCH', what: 'クーポンの一時停止・再開' },
  ],
  'src/app/super-admin/coupons/new/page.tsx': [{ kind: 'exempt', method: 'POST', what: 'クーポンの作成', reason: CREATE_REASON }],
  'src/app/super-admin/email-outbox/page.tsx': [{ kind: 'reread', method: 'POST', what: 'メールの再送 (dead → queued)' }],
  'src/app/super-admin/experiments/[id]/page.tsx': [{ kind: 'reread', method: 'PATCH', what: 'A/B テストの開始・完了・中止' }],
  'src/app/super-admin/experiments/new/page.tsx': [{ kind: 'exempt', method: 'POST', what: 'A/B テストの作成', reason: CREATE_REASON }],
  'src/app/super-admin/experiments/page.tsx': [{ kind: 'reread', method: 'PATCH', what: 'A/B テストの開始・完了 (一覧)' }],
  'src/app/super-admin/feature-packages/[id]/page.tsx': [
    { kind: 'exempt', method: 'PATCH', what: '機能パッケージの保存', reason: VALUE_EDIT_REASON },
    { kind: 'reread', method: 'PATCH', what: '機能パッケージの廃止' },
  ],
  'src/app/super-admin/feature-packages/new/page.tsx': [
    { kind: 'exempt', method: 'POST', what: '機能パッケージの作成', reason: CREATE_REASON },
  ],
  'src/app/super-admin/flags/new/page.tsx': [{ kind: 'exempt', method: 'POST', what: '機能フラグの作成', reason: CREATE_REASON }],
  'src/app/super-admin/flags/page.tsx': [
    { kind: 'reread', method: 'PATCH', what: '機能フラグの切り替え' },
    { kind: 'reread', method: 'DELETE', what: '機能フラグの削除' },
  ],
  'src/app/super-admin/llm/quotas/page.tsx': [
    {
      kind: 'exempt',
      method: 'PATCH',
      what: 'AI の利用上限の保存',
      reason: '値の編集 (状態の変更ではない)。押し直しても同じ上限を書き直すだけで、自分の操作で 409 にならない。#2073 の範囲の外',
    },
  ],
  'src/app/super-admin/plans/[id]/page.tsx': [
    { kind: 'reread', method: 'PATCH', what: 'プランの公開・非公開・再公開・廃止・廃止の取り消し' },
    { kind: 'exempt', method: 'PATCH', what: 'プランの保存 (表示名・説明・表示順)', reason: VALUE_EDIT_REASON },
  ],
  'src/app/super-admin/plans/[id]/price-change/page.tsx': [
    {
      kind: 'exempt',
      method: 'POST',
      what: 'プランの価格の変更',
      reason:
        '価格の変更の作成 (状態の変更ではない)。#2073 の範囲の外。応答が切れたあとの押し直しの二重は #2101 X1 で、画面がプランを読み直して送った価格になっているかを確かめ、route が同じ価格を 409 OP_PRICE_UNCHANGED で断る (tests/price-change-page-no-response-2101.test.tsx・tests/price-change-unchanged-route-2101.test.ts)',
    },
  ],
  'src/app/super-admin/plans/new/page.tsx': [{ kind: 'exempt', method: 'POST', what: 'プランの作成', reason: CREATE_REASON }],
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** fetch(…, { method: '<書き込み>' }) の method を、ファイルの中の出てくる順に返す */
function writeMethodsOf(source: ts.SourceFile): string[] {
  const methods: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
      const init = node.arguments[1];
      if (init && ts.isObjectLiteralExpression(init)) {
        for (const prop of init.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === 'method' &&
            ts.isStringLiteralLike(prop.initializer) &&
            WRITE_METHODS.has(prop.initializer.text.toUpperCase())
          ) {
            methods.push(prop.initializer.text.toUpperCase());
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return methods;
}

function importsOf(source: ts.SourceFile): string[] {
  return source.statements
    .filter(ts.isImportDeclaration)
    .map((decl) => (ts.isStringLiteral(decl.moduleSpecifier) ? decl.moduleSpecifier.text : ''));
}

const scanned = new Map<string, { methods: string[]; imports: string[] }>();
for (const file of listSourceFiles(SCAN_ROOT)) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const methods = writeMethodsOf(source);
  if (methods.length > 0) scanned.set(file, { methods, imports: importsOf(source) });
}

describe('運営の画面の書き込みの通信の表 (#2073 の同じ型の見張り)', () => {
  it('書き込みの通信のある画面の集合が表と一致する (増えた・減った画面は、読み直すか対象外かを決めて表に足す)', () => {
    expect([...scanned.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s: 書き込みの通信の数と method の並びが表と一致する', (file, expected) => {
    expect(scanned.get(file)?.methods).toEqual(expected.map((entry) => entry.method));
  });

  it.each(Object.entries(EXPECTED).filter(([, entries]) => entries.some((e) => e.kind === 'reread')))(
    '%s: 状態の変更のある画面は、通信の reject のあとの読み直しの文の部品を import している',
    (file) => {
      const imports = scanned.get(file)?.imports ?? [];
      expect(imports.some((spec) => NO_RESPONSE_MODULES.includes(spec))).toBe(true);
    },
  );

  it('対象外には理由を書く', () => {
    for (const entries of Object.values(EXPECTED)) {
      for (const entry of entries) {
        if (entry.kind === 'exempt') expect(entry.reason.length, entry.what).toBeGreaterThan(0);
      }
    }
  });

  it('番兵: 走査が空振りしていない (読み直す書き込みと対象外の書き込みの両方を拾っている)', () => {
    const all = [...scanned.values()].flatMap((v) => v.methods);
    const expectedAll = Object.values(EXPECTED).flat();
    expect(all).toHaveLength(expectedAll.length);
    expect(expectedAll.filter((e) => e.kind === 'reread').length).toBeGreaterThan(0);
    expect(expectedAll.filter((e) => e.kind === 'exempt').length).toBeGreaterThan(0);
    // メール送信の再送 (2 周目のレビューで足した同じ型) を拾っている
    expect(scanned.get('src/app/super-admin/email-outbox/page.tsx')?.methods).toEqual(['POST']);
  });
});
