// tests/helpers/design-doc-fact-consistency.ts
// 設計書 (docs/design/) の 1 冊の中で、同じ事実 (関数の場所・呼び出しの行など) を何か所かで指すとき、その指し先がそろっているかを確かめる。
//
// 設計書の file:line は、冊や節が名指す origin/main の sha の時点で取る。コードが動いたあとで一部の箇所だけ今の行に書き換えると、
// 同じ事実を指す別の箇所が古い行のまま残り、冊の中で食い違う (#1917 docs-1024a の R3: findBlocker の場所を family/11 の用語の行では
// 直したのに前提の事実の行に古い行が残った・cross/13b のログインの振り分けの場所を 3 か所で直したのに S1 のトレースに残った)。
// ここでは「すべて古い行のまま」と「すべて今の行」のどちらも正しいとし、値が 2 つ以上に分かれたときを問題として返す。
// 改定の記録の行 (改定履歴の節・行頭が `> 改定履歴` の行) と、コードの囲み (正典コードの写し) の中は、昔の値を残す所なので見ない。

/** 1 行が述べる事実の値を取り出す (その事実を述べない行は空の配列を返す) */
export type FactValueReader = (lineText: string) => readonly string[];

/** 設計書の中の、事実の値の 1 か所 */
export type FactValueMention = {
  /** 設計書の行 (1 から) */
  readonly line: number;
  /** 取り出した値 */
  readonly value: string;
};

/** コードの囲みの始まりと終わり (``` と ~~~) */
const CODE_FENCE = /^\s*(?:```|~~~)/;
/** 見出し (# の数が見出しの深さ) */
const HEADING = /^(#{1,6})\s/;
/** 改定の記録の節の見出しの語 */
const REVISION_HEADING_WORD = /改定履歴|改訂履歴/;
/** 冊の頭の 1 行の改定の記録 (`> 改定履歴: v1.0 …`) */
const REVISION_QUOTE = /^>\s*改定履歴/;

/**
 * 設計書の本文から、事実の値を行ごとに集める。コードの囲みの中・改定の記録の節の中・`> 改定履歴` の行は見ない。
 * 改定の記録の節は、その見出しから、同じ深さかより浅い次の見出しの手前まで。
 */
export function collectFactValues(doc: string, read: FactValueReader): FactValueMention[] {
  const mentions: FactValueMention[] = [];
  let inFence = false;
  /** 改定の記録の節の見出しの深さ (節の外なら null) */
  let revisionDepth: number | null = null;
  doc.split('\n').forEach((text, index) => {
    if (CODE_FENCE.test(text)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const heading = HEADING.exec(text);
    if (heading) {
      const depth = heading[1].length;
      if (revisionDepth !== null && depth <= revisionDepth) revisionDepth = null;
      if (revisionDepth === null && REVISION_HEADING_WORD.test(text)) revisionDepth = depth;
    }
    if (revisionDepth !== null || REVISION_QUOTE.test(text)) return;
    for (const value of read(text)) mentions.push({ line: index + 1, value });
  });
  return mentions;
}

/**
 * 集めた値が 2 つ以上に分かれていたら、値ごとに `値: 行, 行` の文を返す (値の初出の順)。そろっている (値が 0 か 1 つ) なら空の配列。
 */
export function findSplitFactValues(mentions: readonly FactValueMention[]): string[] {
  const linesByValue = new Map<string, number[]>();
  for (const mention of mentions) {
    const lines = linesByValue.get(mention.value) ?? [];
    lines.push(mention.line);
    linesByValue.set(mention.value, lines);
  }
  if (linesByValue.size <= 1) return [];
  return [...linesByValue].map(([value, lines]) => `${value}: ${lines.join(', ')}`);
}
