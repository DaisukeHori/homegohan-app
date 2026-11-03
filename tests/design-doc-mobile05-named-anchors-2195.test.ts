/**
 * mobile/05 (auth のセッション) §9.1 の閉包の表の M-1・M-2 の行が、apps/mobile の 2 ファイルを関数の名前で指す。
 * その名前の指し先が、今のコードでも本当に auth の呼び出しを持っていることを見る (#2195 docs-1103b)
 *
 * W2 (#2193)・V3 (#2198) で行がずれ、M-1 の `AIAdvisorSheet.tsx:328`・`:445` と M-2 の `questions.tsx:767`・`:937` が
 * getSession() / getUser() でない行を指したまま残った。表は行番号をやめて関数の名前で指す:
 *   - M-1: `AIAdvisorSheet.tsx` の `archiveSession`・`sendMessage` の `getSession()` (表の文は「`AIAdvisorSheet.tsx` の 2 行」)
 *   - M-2: `questions.tsx` の `saveProgress` の `getUser()`・`handleAnswer` の完了の分岐の `getUser()`
 * 名前の参照が古くなる (呼び出しが別の関数へ移る・増える・消える) と、ここが赤くなる。
 * 表の行数の列 (M-1 は 11・M-2 は 13) は tests/design-doc-auth-call-closure-count.test.ts が見る。
 * 文書の側 (M-1・M-2 の行がこの名前で指し、2 ファイルを行番号で指す所が mobile/05 に無いこと) も見る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** コンポーネントの中の関数の宣言の字下げ (2 文字)。宣言の行と、その関数を閉じる `  }` の行がこの字下げで始まる */
const MEMBER_INDENT = '  ';

const DOC_PATH = 'docs/design/mobile/05-auth-session.md';
const ADVISOR_SHEET_PATH = 'apps/mobile/src/components/ai/AIAdvisorSheet.tsx';
const QUESTIONS_PATH = 'apps/mobile/app/onboarding/questions.tsx';

const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

/** 正規表現の特殊文字をすべて逃がす */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 文字列の中に needle が何回あるか (重ならない数) */
const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

/** 閉包の表の行 (`| <群の名前> ` で始まる行)。ちょうど 1 行あることを確かめる */
function closureRow(doc: string, group: string): string {
  const rows = doc.split('\n').filter((line) => line.startsWith(`| ${group} `));
  expect(rows, `閉包の表の ${group} の行がちょうど 1 つ`).toHaveLength(1);
  return rows[0];
}

/** ファイルの名前のあとに行番号 (`<file>:N` / `` `<file>`:N ``) が続く所 */
const lineReferenceOf = (fileName: string): RegExp => new RegExp(`${escapeRegExp(fileName)}\`?:\\d`);

/**
 * コンポーネントの中の `async function <name>(` の本体 (宣言の行から、同じ字下げの `}` の行まで)。
 * 宣言はファイルの中にちょうど 1 つ、閉じる行も見つかることを確かめる。
 */
function memberFunctionBody(source: string, name: string): string {
  const lines = source.split('\n');
  const declaration = new RegExp(`^${MEMBER_INDENT}async function ${escapeRegExp(name)}\\(`);
  const starts = lines.flatMap((line, index) => (declaration.test(line) ? [index] : []));
  expect(starts, `async function ${name} の宣言がちょうど 1 つ`).toHaveLength(1);
  const start = starts[0];
  const closing = `${MEMBER_INDENT}}`;
  const endOffset = lines.slice(start + 1).findIndex((line) => line === closing);
  expect(endOffset, `async function ${name} を閉じる行がある`).toBeGreaterThanOrEqual(0);
  return lines.slice(start, start + 1 + endOffset + 1).join('\n');
}

describe('mobile/05 の閉包の表の M-1・M-2 が関数の名前で指す先 (#2195 docs-1103b)', () => {
  it('M-1: AIAdvisorSheet.tsx の getSession() は archiveSession と sendMessage に 1 つずつで、ファイルの中はその 2 つだけ', () => {
    const source = read(ADVISOR_SHEET_PATH);
    const call = 'supabase.auth.getSession()';
    const namedFunctions = ['archiveSession', 'sendMessage'];
    for (const name of namedFunctions) {
      expect(countOf(memberFunctionBody(source, name), call), `${name} の中の ${call}`).toBe(1);
    }
    // 表の文「`AIAdvisorSheet.tsx` の 2 行」と同じ数 (名前を挙げた関数の数) だけ、ファイルに呼び出しがある
    expect(countOf(source, call), `AIAdvisorSheet.tsx の ${call} の数`).toBe(namedFunctions.length);
  });

  it('M-2: questions.tsx の getUser() は saveProgress と handleAnswer の完了の分岐に 1 つずつで、ファイルの中はその 2 つだけ', () => {
    const source = read(QUESTIONS_PATH);
    const call = 'supabase.auth.getUser()';
    expect(countOf(memberFunctionBody(source, 'saveProgress'), call), `saveProgress の中の ${call}`).toBe(1);

    const handleAnswer = memberFunctionBody(source, 'handleAnswer');
    expect(countOf(handleAnswer, call), `handleAnswer の中の ${call}`).toBe(1);
    // 完了の分岐 = 次の質問が無い (`next !== -1` の早い return を過ぎた) あと。呼び出しはその return より後ろにある
    const earlyReturnGuard = 'if (next !== -1) {';
    const guardAt = handleAnswer.indexOf(earlyReturnGuard);
    expect(guardAt, `handleAnswer に「${earlyReturnGuard}」がある`).toBeGreaterThanOrEqual(0);
    const returnAt = handleAnswer.indexOf('return;', guardAt);
    expect(returnAt, '次の質問へ進む分岐の return がある').toBeGreaterThan(guardAt);
    expect(handleAnswer.indexOf(call), `${call} は完了の分岐 (早い return の後ろ) にある`).toBeGreaterThan(returnAt);

    const namedCallSites = ['saveProgress', 'handleAnswer'];
    expect(countOf(source, call), `questions.tsx の ${call} の数`).toBe(namedCallSites.length);
  });

  it('文書: M-1・M-2 の行は 2 ファイルを関数の名前で指し、mobile/05 に 2 ファイルの行番号の参照は無い', () => {
    const doc = read(DOC_PATH);
    const m1 = closureRow(doc, 'M-1');
    expect(m1).toContain(`\`${ADVISOR_SHEET_PATH}\` の \`archiveSession\`・\`sendMessage\` の \`getSession()\``);
    const m2 = closureRow(doc, 'M-2');
    expect(m2).toContain(
      `\`${QUESTIONS_PATH}\` の \`saveProgress\` の \`getUser()\`・\`handleAnswer\` の完了の分岐の \`getUser()\``,
    );
    for (const fileName of ['AIAdvisorSheet.tsx', 'questions.tsx']) {
      expect(doc, `mobile/05 に ${fileName} の行番号の参照が無い`).not.toMatch(lineReferenceOf(fileName));
    }
  });
});
