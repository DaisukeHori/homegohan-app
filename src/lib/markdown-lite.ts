/**
 * 軽量 Markdown → HTML 変換 (#1169)
 *
 * AI の応答のように「信頼できない文字列」を、限られた Markdown 記法だけ解釈して HTML 文字列にする。
 * 結果は dangerouslySetInnerHTML にそのまま渡される前提なので、次の 3 点で安全を保っている。
 *
 *   1. 最初に & < > " ' をすべてエスケープする。入力に含まれる HTML は、以降ぜんぶ「ただの文字」になる。
 *      出力に現れるタグは、この関数が組み立てる固定のものだけ
 *      (strong / em / h2〜h4 / ul / ol / li / pre / code / a / br)。
 *   2. リンクは http(s):// と mailto: だけを <a> にする。javascript: / data: / vbscript: /
 *      「//host」(プロトコル相対) / 相対パスなどは、リンクにせず文字のまま表示する。
 *   3. コードブロック・インラインコードの中身は、エスケープしたまま字面どおりに出す
 *      (中の ** や _ が太字・斜体に変わらない)。
 *
 * 利用者や AI の文字列を HTML にして dangerouslySetInnerHTML へ渡す処理は、自前で書かず
 * 必ずこの関数を通す (tests/inner-html-contract.test.ts が検査する)。
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * HTML の特殊文字 (& < > " ') をエンティティにする。
 * 本文だけでなく、ダブルクオート・シングルクオートどちらで囲んだ属性値にも使える。
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * リンクとして許す URL。先頭が http:// https:// mailto: のものだけ (大文字小文字は問わない)。
 *
 * 先頭が空白や制御文字の URL、途中に空白や制御文字を含む URL はまとめて断る。
 * ブラウザは URL を解釈するとき、先頭の空白・制御文字と途中のタブ・改行を取り除くため、
 * " javascript:..." や "java\tscript:..." が javascript: に化ける手口があるため。
 * 許可リスト方式なので、ここに載らないスキーム (javascript: data: vbscript: file: tel: など) は
 * すべてリンクにならない。
 */
const SAFE_LINK_URL = /^(?:https?:\/\/|mailto:)[^\s\u0000-\u001f\u007f-\u009f]+$/i;

/** この URL をリンク (<a href>) にしてよいか。 */
export function isSafeLinkUrl(url: string): boolean {
  return SAFE_LINK_URL.test(url);
}

/**
 * 作業中、コードやリンクの URL を一時的に置き換えておく目印の区切り文字 (NUL)。
 * NUL は文章にまず現れず、最初に入力から取り除くので、入力側から目印を偽造されることはない。
 */
const MARK = '\u0000';

/**
 * Markdown 風のテキストを、安全な HTML 文字列にする。
 * 対応する記法: コードブロック / インラインコード / 太字 / 斜体 / 見出し (# ## ###) /
 * 箇条書き (- *) / 番号付きリスト / リンク [text](url) / 改行。
 */
export function parseMarkdown(text: string | null | undefined): string {
  if (typeof text !== 'string' || text === '') return '';

  // アクションブロックを除去（別途表示されるため）
  let html = text.replace(/```action[\s\S]*?```/g, '');

  // 最初にエスケープする。これより後ろの変換は、すべてエスケープ済みの文字列に対して行う。
  html = escapeHtml(html.replace(/\u0000/g, ''));

  // コードの中身とリンクの URL は、このあとの太字・斜体・見出し・リストの変換で壊されないよう、
  // 完成した HTML を別に取っておき、本文には目印だけを残す。最後に目印を HTML へ戻す。
  const kept: string[] = [];
  const keep = (fragment: string): string => {
    kept.push(fragment);
    return `${MARK}${kept.length - 1}${MARK}`;
  };

  // コードブロック（```）を処理。中身はエスケープ済みのまま字面どおりに出す。
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang: string, code: string) =>
    keep(`<pre class="md-code-block"><code>${code}</code></pre>`),
  );

  // インラインコード（`）を処理
  html = html.replace(/`([^`]+)`/g, (_match, code: string) =>
    keep(`<code class="md-inline-code">${code}</code>`),
  );

  // リンク [text](url)。http(s) と mailto だけを <a> にし、それ以外は変換せず文字のまま残す。
  // url はエスケープ済みなので " ' を含んでいても href の引用符から抜け出せない。
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label: string, url: string) => {
    if (!isSafeLinkUrl(url)) return match;
    const open = keep(`<a href="${url}" target="_blank" rel="noopener noreferrer" class="md-link">`);
    return `${open}${label}</a>`;
  });

  // 太字（**text** または __text__）
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // 斜体（*text* または _text_）- 太字の後に処理
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  // 見出し（### ## #）
  html = html.replace(/^### (.+)$/gm, '<h4 class="md-h4">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2 class="md-h2">$1</h2>');

  // 箇条書き（- または *）
  html = html.replace(/^[-*] (.+)$/gm, '<li class="md-li">$1</li>');
  // 連続するliをulで囲む
  html = html.replace(/(<li class="md-li">.*?<\/li>\n?)+/g, '<ul class="md-ul">$&</ul>');

  // 番号付きリスト
  html = html.replace(/^\d+\. (.+)$/gm, '<li class="md-li-num">$1</li>');
  html = html.replace(/(<li class="md-li-num">.*?<\/li>\n?)+/g, '<ol class="md-ol">$&</ol>');

  // 取っておいた HTML を戻す。インラインコードの中にコードブロックの目印が入る入れ子の場合があるので、
  // 戻した HTML の中の目印も戻す (目印の番号は必ず小さい方向にしか入れ子にならないので、必ず終わる)。
  const restore = (s: string): string =>
    s.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => restore(kept[Number(index)] ?? ''));
  html = restore(html);

  // 改行を<br>に変換（ただし、HTMLタグの直前は除く）
  html = html.replace(/\n(?!<)/g, '<br>');

  return html;
}
