/**
 * #2080 U4 の続き: 組織の管理画面 (src/app/(org)) の書き込みの通信 (fetch の POST / PATCH / PUT / DELETE) を走査し、
 * 1 か所ずつ「通信が reject されたら一覧を読み直し、『<操作>の応答を受け取れませんでした（通信エラー）』を出す」か
 * 「対象外 (理由つき)」かに分けた表と突き合わせる (運営の画面の super-admin-write-reject-reread-scan-2073.test.ts と同じ形)。
 *
 * 一覧を読み直す書き込みは、読み直した一覧で操作が済んでいることがあるので、文は「できませんでした」「失敗しました」と言わない
 * (src/lib/org-write-no-response.ts。振る舞いは org-write-reject-message-2080.test.tsx が確かめる)。
 * 書き込みの通信が増えた・減った・移ったら、この表が赤になるので、どちらに当たるかを決めて表を直す。
 *
 * 走査はソースの構文木 (TypeScript) で行う。コメント・文字列の中は見ない。
 * 限界 (見張りであって証明ではない): fetch を別の関数・別のファイルに包んで呼ぶ書き方と、method を変数で渡す書き方は数えない。
 * 表の「reread」は、その画面が文の部品を import し、文の関数を呼んでいることまでを見る (読み直しの振る舞いそのものは見ない)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'src/app/(org)';
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** 通信の reject のあとの文の部品と、その関数の名前 */
const NO_RESPONSE_MODULE = '@/lib/org-write-no-response';
const NO_RESPONSE_FUNCTION = 'orgWriteNoResponseMessage';

type WriteHandling =
  /** 通信が reject されたら一覧を読み直し、応答を受け取れなかった文を出す (#2080 U4) */
  | { kind: 'reread'; method: string; what: string }
  /** 一覧を読み直す書き込みではない。理由を書く */
  | { kind: 'exempt'; method: string; what: string; reason: string };

/** 画面ごとの書き込みの通信の表 (ファイルの中の出てくる順) */
const EXPECTED: Readonly<Record<string, readonly WriteHandling[]>> = {
  'src/app/(org)/org/challenges/page.tsx': [
    { kind: 'reread', method: 'POST', what: 'チャレンジの作成' },
    { kind: 'reread', method: 'PUT', what: 'チャレンジの状態の変更 (開始・終了)' },
  ],
  'src/app/(org)/org/departments/page.tsx': [
    { kind: 'reread', method: 'PUT', what: '部署の更新' },
    { kind: 'reread', method: 'POST', what: '部署の追加' },
    { kind: 'reread', method: 'DELETE', what: '部署の削除' },
  ],
  'src/app/(org)/org/invites/page.tsx': [
    { kind: 'reread', method: 'POST', what: '招待の送信' },
    { kind: 'reread', method: 'POST', what: '招待の取り消し' },
  ],
  'src/app/(org)/org/members/page.tsx': [
    { kind: 'reread', method: 'POST', what: 'メンバーの除名' },
    {
      kind: 'exempt',
      method: 'POST',
      what: '組織からの脱退',
      reason:
        '一覧ではなく自分のプロフィールを読み直し、抜けていれば成功のときと同じくホームへ移る (#2064)。「脱退失敗」は抜けていないと分かった (か確かめられなかった) ときだけ出すので、事実と合う',
    },
  ],
  'src/app/(org)/org/settings/owner-transfer/page.tsx': [
    {
      kind: 'exempt',
      method: 'POST',
      what: 'オーナーの譲渡の提案',
      reason:
        '送る前と後の pending の提案を読み比べ、作れていれば成功のときと同じ遷移をする (#2073 S8)。失敗の文は作れていないと分かった (か確かめられなかった) ときだけ出すので、事実と合う',
    },
  ],
  'src/app/(org)/org/settings/page.tsx': [
    {
      kind: 'exempt',
      method: 'PUT',
      what: '組織の設定の保存',
      reason:
        '値の編集で、通信が切れても読み直さない (読み直した値が画面に出て、済んだのに失敗と読める食い違いが起きない)。押し直しても同じ値を書き直すだけ。#2080 U4 (読み直した一覧と文の食い違い) の範囲の外',
    },
  ],
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

/** 名前で呼んでいる関数の呼び出しの数 */
function callCountOf(source: ts.SourceFile, name: string): number {
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function importsOf(source: ts.SourceFile): string[] {
  return source.statements
    .filter(ts.isImportDeclaration)
    .map((decl) => (ts.isStringLiteral(decl.moduleSpecifier) ? decl.moduleSpecifier.text : ''));
}

const scanned = new Map<string, { methods: string[]; imports: string[]; noResponseCalls: number }>();
for (const file of listSourceFiles(SCAN_ROOT)) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const methods = writeMethodsOf(source);
  if (methods.length > 0) {
    scanned.set(file, {
      methods,
      imports: importsOf(source),
      noResponseCalls: callCountOf(source, NO_RESPONSE_FUNCTION),
    });
  }
}

describe('組織の管理画面の書き込みの通信の表 (#2080 U4 の同じ型の見張り)', () => {
  it('書き込みの通信のある画面の集合が表と一致する (増えた・減った画面は、読み直すか対象外かを決めて表に足す)', () => {
    expect([...scanned.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s: 書き込みの通信の数と method の並びが表と一致する', (file, expected) => {
    expect(scanned.get(file)?.methods).toEqual(expected.map((entry) => entry.method));
  });

  it.each(Object.entries(EXPECTED).filter(([, entries]) => entries.some((e) => e.kind === 'reread')))(
    '%s: 一覧を読み直す書き込みのある画面は、応答を受け取れなかった文の部品を import して呼んでいる',
    (file) => {
      const found = scanned.get(file);
      expect(found?.imports).toContain(NO_RESPONSE_MODULE);
      expect(found?.noResponseCalls ?? 0).toBeGreaterThan(0);
    },
  );

  it.each(Object.entries(EXPECTED).filter(([, entries]) => entries.every((e) => e.kind === 'exempt')))(
    '%s: 対象外だけの画面は、応答を受け取れなかった文の部品を使わない (表と実装の食い違いを見つける)',
    (file) => {
      expect(scanned.get(file)?.noResponseCalls).toBe(0);
    },
  );

  it('対象外の行には理由が書いてある', () => {
    for (const entries of Object.values(EXPECTED)) {
      for (const entry of entries) {
        if (entry.kind === 'exempt') expect(entry.reason.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
