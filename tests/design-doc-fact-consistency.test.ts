// @vitest-environment node
/**
 * 設計書の 1 冊の中で、同じ事実の指し先 (行番号・置き場のファイル) が 1 つにそろうことの contract テスト (ソース走査)
 *
 * #1917 docs-1024a の R3 の指摘: 指し先を取り直すときに一部の箇所だけを直し、同じ事実を指す別の箇所が古いまま残った。
 *   1. cross/13b: ログインの後の振り分け routeAfterSignIn の置き場を src/lib/routeAfterSignIn.ts に直したのに、S1 のトレースが
 *      `login.tsx:76-100` のまま。新規登録の signUp (`signup.tsx:109`)・ログインの signInWithPassword (`login.tsx:154`) も、
 *      画面の表の (auth) の行だけ直して S1 などに古い行が残った
 *   2. family/11・cross/20: findBlocker の範囲を `account-deletion.ts:282-320` に直したのに、前提の事実の行が `:248-285` のまま
 * 「すべて古い行のまま」と「すべて今の行」のどちらも通し (設計書の直しは別に当てる)、混ざったときだけ赤にする。
 * 確かめる事実と冊は tests/helpers/design-doc-facts-1917.ts、そろい方の判定は tests/helpers/design-doc-fact-consistency.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectFactValues, findSplitFactValues, type FactValueReader } from './helpers/design-doc-fact-consistency';
import { DESIGN_DOC_FACTS_1917 } from './helpers/design-doc-facts-1917';

const ROOT = path.resolve(__dirname, '..');

/** 単体テストの事実: 行の中の `place.ts:<範囲>` の範囲 */
const readPlace: FactValueReader = (text) => [...text.matchAll(/place\.ts:(\d+-\d+)/g)].map((match) => match[1]);

describe('collectFactValues', () => {
  it('本文の行から値を行ごとに集める (1 行に 2 つあれば 2 つ)', () => {
    const doc = ['# 本書', '| 事実 | `place.ts:10-20` |', '', '本文 `place.ts:10-20` と `place.ts:30-40`'].join('\n');
    expect(collectFactValues(doc, readPlace)).toEqual([
      { line: 2, value: '10-20' },
      { line: 4, value: '10-20' },
      { line: 4, value: '30-40' },
    ]);
  });

  it('コードの囲みの中・改定履歴の節の中・`> 改定履歴` の行は見ない (節を抜けたら見る)', () => {
    const doc = [
      '> 改定履歴: v1.1 `place.ts:1-2` を直した',
      '## 1. 本文',
      '`place.ts:10-20`',
      '```ts',
      '// place.ts:3-4',
      '```',
      '## 9. 改定履歴',
      '| v1.0 | `place.ts:5-6` |',
      '### 9.1 前の版',
      '`place.ts:7-8`',
      '## 10. 付録',
      '`place.ts:10-20`',
    ].join('\n');
    expect(collectFactValues(doc, readPlace)).toEqual([
      { line: 3, value: '10-20' },
      { line: 12, value: '10-20' },
    ]);
  });
});

describe('findSplitFactValues', () => {
  it('値がそろっていれば (古いままでも今の行でも) 問題は無い', () => {
    expect(findSplitFactValues([{ line: 3, value: '248-285' }, { line: 9, value: '248-285' }])).toEqual([]);
    expect(findSplitFactValues([{ line: 3, value: '282-320' }, { line: 9, value: '282-320' }])).toEqual([]);
    expect(findSplitFactValues([])).toEqual([]);
  });

  it('一部だけ直して値が分かれると、値ごとの行を返す (#1917 docs-1024a の R3 の形)', () => {
    expect(
      findSplitFactValues([
        { line: 59, value: '282-320' },
        { line: 100, value: '248-285' },
        { line: 1071, value: '282-320' },
      ]),
    ).toEqual(['282-320: 59, 1071', '248-285: 100']);
  });
});

describe('#1917 docs-1024a で指し先を取り直した事実が、冊の中でそろう', () => {
  for (const fact of DESIGN_DOC_FACTS_1917) {
    it(`${fact.doc} の「${fact.name}」`, () => {
      const doc = fs.readFileSync(path.join(ROOT, fact.doc), 'utf8');
      const mentions = collectFactValues(doc, fact.read);
      // 取り出しの形が冊の書き方からずれて、何も見なくなっていないこと
      expect(mentions.length, `${fact.doc} で「${fact.name}」を述べる箇所の数`).toBeGreaterThanOrEqual(fact.minMentions);
      expect(findSplitFactValues(mentions), `${fact.doc} の「${fact.name}」が箇所によって違う`).toEqual([]);
    });
  }
});
