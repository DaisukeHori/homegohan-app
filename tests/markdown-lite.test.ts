/**
 * #1169: AI 応答を HTML にする parseMarkdown (src/lib/markdown-lite.ts) の XSS 回帰テスト。
 *
 * parseMarkdown の結果は dangerouslySetInnerHTML にそのまま渡される。修正前は入力をエスケープしていなかったため、
 * AI の応答 (プロンプトインジェクションで混ざった文字列を含む) の中の <img onerror=...> や <script> が
 * そのまま HTML として実行され、CSP も 'unsafe-inline' を許しているので防げなかった。ここでは
 *
 *   - 入力中の HTML が HTML として解釈されず、書いた文字がそのまま表示される
 *   - リンクは http(s) / mailto だけで、javascript: / data: などは (大文字小文字・空白・エンティティを混ぜても) 文字のまま
 *   - 引用符で href から抜け出して onmouseover などの属性を足せない
 *   - コードの中身はエスケープされたまま、中の記号が太字・斜体に変わらない
 *
 * を確かめる。あわせて、通常の文章 (太字・斜体・見出し・リスト・改行) の出力が修正前と変わっていないことを、
 * 修正前の実装が実際に返した HTML を期待値にして確かめる。
 *
 * 出力の検査は文字列の部分一致だけに頼らず、<template> の中でパースして「許可したタグ・属性だけが残っているか」を調べる。
 * template の中身は動作しないので、万一出力が壊れても検査中にスクリプトが走ることはない。
 */
import { describe, expect, it } from 'vitest';
import { escapeHtml, isSafeLinkUrl, parseMarkdown } from '../src/lib/markdown-lite';

// ─────────────────────────────────────────────
// 検査用ヘルパー
// ─────────────────────────────────────────────

/** parseMarkdown が出力してよいタグと、そのタグに付いてよい属性。これ以外が出たら失敗。 */
const ALLOWED_ATTRIBUTES = new Map<string, readonly string[]>([
  ['strong', []],
  ['em', []],
  ['br', []],
  ['h2', ['class']],
  ['h3', ['class']],
  ['h4', ['class']],
  ['ul', ['class']],
  ['ol', ['class']],
  ['li', ['class']],
  ['pre', ['class']],
  ['code', ['class']],
  ['a', ['href', 'target', 'rel', 'class']],
]);

function parseHtml(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

/** 出力が、許可したタグ・属性だけでできていること (リンクは http(s)/mailto で、別タブで noopener noreferrer)。 */
function expectOnlyAllowedMarkup(html: string, input = ''): void {
  const context = `入力: ${JSON.stringify(input)}\n出力: ${html}`;
  expect(html, `作業用の目印 (NUL) が出力に残っている\n${context}`).not.toContain('\u0000');

  for (const el of Array.from(parseHtml(html).querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase();
    const allowedAttributes = ALLOWED_ATTRIBUTES.get(tag);
    expect(allowedAttributes, `許可していないタグ <${tag}> が出力された\n${context}`).toBeDefined();
    for (const attribute of Array.from(el.attributes)) {
      expect(
        allowedAttributes,
        `<${tag}> に許可していない属性 ${attribute.name} が出力された\n${context}`,
      ).toContain(attribute.name);
    }
    if (tag === 'a') {
      expect(el.getAttribute('href'), `リンクの href が http(s)/mailto ではない\n${context}`).toMatch(
        /^(?:https?:\/\/|mailto:)/i,
      );
      expect(el.getAttribute('target'), context).toBe('_blank');
      expect(el.getAttribute('rel'), context).toBe('noopener noreferrer');
    }
  }
}

// ─────────────────────────────────────────────
// escapeHtml / isSafeLinkUrl
// ─────────────────────────────────────────────
describe('escapeHtml', () => {
  it('& < > " \' を HTML エンティティにする', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('& を最初に置き換えるのと同じ結果になる (作ったエンティティをさらに壊さない)', () => {
    expect(escapeHtml('<a href="x">&amp;</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;amp;&lt;/a&gt;');
  });

  it('それ以外の文字はそのまま返す', () => {
    expect(escapeHtml('こんにちは abc 123 `*_#-[]()')).toBe('こんにちは abc 123 `*_#-[]()');
  });
});

describe('isSafeLinkUrl', () => {
  it.each([
    'https://example.com',
    'http://example.com/a/b?x=1&y=2#top',
    'HTTPS://EXAMPLE.COM',
    'HtTp://example.com',
    'mailto:info@example.com',
    'MAILTO:info@example.com?subject=hello',
  ])('許可する: %s', (url) => {
    expect(isSafeLinkUrl(url)).toBe(true);
  });

  it.each([
    '',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'jAvAsCrIpT:alert(1)',
    ' javascript:alert(1)',
    '\tjavascript:alert(1)',
    '\njavascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    '\u0001javascript:alert(1)',
    'javascript://example.com/%0Aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    '//evil.example.com/path',
    '///evil.example.com',
    '\\\\evil.example.com',
    '/\\evil.example.com',
    '/relative/path',
    '#anchor',
    '?q=1',
    'file:///etc/passwd',
    'ftp://example.com',
    'tel:0312345678',
    'sms:0312345678',
    'blob:https://example.com/00000000-0000-0000-0000-000000000000',
    'about:blank',
    'https:example.com',
    'httpx://example.com',
    'xhttps://example.com',
    ' https://example.com',
    'https://example.com ',
    'https://exa mple.com',
    'https://example.com\tevil',
    'https://',
    'mailto:',
  ])('許可しない: %j', (url) => {
    expect(isSafeLinkUrl(url)).toBe(false);
  });
});

// ─────────────────────────────────────────────
// 入力中の HTML は HTML として解釈されない
// ─────────────────────────────────────────────
describe('入力中の HTML', () => {
  const HOSTILE_HTML = [
    '<img src=x onerror=alert(1)>',
    '<img src="x" onerror="alert(1)">',
    '<script>alert(1)</script>',
    '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
    '<svg onload=alert(1)>',
    '<svg><script>alert(1)</script></svg>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<a href="javascript:alert(1)">click</a>',
    '<body onload=alert(1)>',
    '<details open ontoggle=alert(1)>',
    '<input autofocus onfocus=alert(1)>',
    '<style>*{background:url(javascript:alert(1))}</style>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<form action="javascript:alert(1)"><button>go</button></form>',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    '</span><img src=x onerror=alert(1)>',
    '<<script>script>alert(1)<</script>/script>',
    '<!-- --><img src=x onerror=alert(1)>',
    '"><img src=x onerror=alert(1)>',
    "'><img src=x onerror=alert(1)>",
  ];

  it.each(HOSTILE_HTML)('タグにならず、書いた文字がそのまま表示される: %s', (input) => {
    const html = parseMarkdown(input);
    expect(html).not.toContain('<');
    expectOnlyAllowedMarkup(html, input);
    expect(parseHtml(html).textContent).toBe(input);
  });

  it('<img onerror> は img 要素にならない', () => {
    const html = parseMarkdown('<img src=x onerror=alert(1)>');
    expect(html).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(parseHtml(html).querySelector('img')).toBeNull();
  });

  it('<script> は script 要素にならない', () => {
    const html = parseMarkdown('<script>alert(1)</script>');
    expect(html).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(parseHtml(html).querySelector('script')).toBeNull();
  });

  it.each([
    ['見出し', '# <img src=x onerror=alert(1)>', 'h2'],
    ['小見出し', '### <script>alert(1)</script>', 'h4'],
    ['箇条書き', '- <svg onload=alert(1)>', 'li'],
    ['番号付きリスト', '1. <iframe src=javascript:alert(1)>', 'li'],
    ['太字', '**<img src=x onerror=alert(1)>**', 'strong'],
    ['斜体', '*<img src=x onerror=alert(1)>*', 'em'],
    ['リンクの表示文字', '[<img src=x onerror=alert(1)>](https://example.com)', 'a'],
  ])('%s の中の HTML も文字のまま表示される', (_name, input, tag) => {
    const html = parseMarkdown(input);
    expectOnlyAllowedMarkup(html, input);
    const element = parseHtml(html).querySelector(tag);
    expect(element).not.toBeNull();
    expect(element?.textContent).toMatch(/^<(?:img|script|svg|iframe)\b.*>$/);
  });

  it('引用符・アンパサンドを含む普通の文章は、見た目が変わらない', () => {
    const input = `It's a "nice" day & 卵&牛乳 を買う`;
    const html = parseMarkdown(input);
    expect(html).toBe('It&#39;s a &quot;nice&quot; day &amp; 卵&amp;牛乳 を買う');
    expect(parseHtml(html).textContent).toBe(input);
  });

  it('エンティティの書き方をした文字も、書いたとおりに表示される (二重に解釈されない)', () => {
    const input = '&lt;script&gt; &#60;img&#62; &amp;';
    const html = parseMarkdown(input);
    expect(parseHtml(html).textContent).toBe(input);
    expectOnlyAllowedMarkup(html, input);
  });
});

// ─────────────────────────────────────────────
// リンク
// ─────────────────────────────────────────────
describe('リンク', () => {
  it('https のリンクは別タブで開き、noopener noreferrer を付ける', () => {
    const html = parseMarkdown('[公式サイト](https://example.com/path?a=1&b=2)');
    expect(html).toBe(
      '<a href="https://example.com/path?a=1&amp;b=2" target="_blank" rel="noopener noreferrer" class="md-link">公式サイト</a>',
    );
    // ブラウザが読む href は、書かれたとおりの URL に戻る
    expect(parseHtml(html).querySelector('a')?.getAttribute('href')).toBe('https://example.com/path?a=1&b=2');
  });

  it.each([
    ['http://example.com/a/b', 'http://example.com/a/b'],
    ['mailto:info@example.com', 'mailto:info@example.com'],
    ['HTTPS://EXAMPLE.COM', 'HTTPS://EXAMPLE.COM'],
  ])('%s もリンクにする', (url, expectedHref) => {
    const html = parseMarkdown(`[リンク](${url})`);
    expectOnlyAllowedMarkup(html, url);
    expect(parseHtml(html).querySelector('a')?.getAttribute('href')).toBe(expectedHref);
  });

  it('URL の中の _ や * を斜体にして壊さない', () => {
    const html = parseMarkdown('[x](https://example.com/a_b_c/*d*)');
    const anchor = parseHtml(html).querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://example.com/a_b_c/*d*');
    expect(parseHtml(html).querySelector('em')).toBeNull();
  });

  it('表示文字の太字・斜体はそのまま効く', () => {
    expect(parseMarkdown('[**強調**](https://example.com)')).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer" class="md-link"><strong>強調</strong></a>',
    );
  });

  it('許可しない URL が混ざっていても、許可した方のリンクだけが残る', () => {
    const html = parseMarkdown('[a](https://example.com) と [b](javascript:alert(1))');
    expect(parseHtml(html).querySelectorAll('a')).toHaveLength(1);
    expectOnlyAllowedMarkup(html);
  });

  describe('許可しない URL は、リンクにせず文字のまま表示する', () => {
    const BLOCKED_URLS = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'jAvAsCrIpT:alert(1)',
      ' javascript:alert(1)',
      '   javascript:alert(1)',
      '\tjavascript:alert(1)',
      '\njavascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      '&#106;avascript:alert(1)',
      '&#x6A;avascript:alert(1)',
      '&#0000106avascript:alert(1)',
      'javascript&colon;alert(1)',
      '&Tab;javascript:alert(1)',
      'javascript://example.com/%0Aalert(1)',
      'data:text/html,<script>alert(1)</script>',
      'DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'data:image/svg+xml,<svg onload=alert(1)>',
      'vbscript:msgbox(1)',
      '//evil.example.com/path',
      '///evil.example.com',
      '\\\\evil.example.com',
      '/\\evil.example.com',
      '/relative/path',
      '#anchor',
      'file:///etc/passwd',
      'ftp://example.com',
      'tel:0312345678',
      'blob:https://example.com/00000000-0000-0000-0000-000000000000',
      'about:blank',
      'https:example.com',
      ' https://example.com',
      'https://exa mple.com',
    ];

    it.each(BLOCKED_URLS)('%j', (url) => {
      const input = `[リンク](${url})`;
      const html = parseMarkdown(input);
      expect(html).not.toContain('<a');
      expect(html).not.toMatch(/href/i);
      expectOnlyAllowedMarkup(html, input);
      // 改行だけは <br> になるので、それ以外の文字は書いたとおりに残っていること
      expect(parseHtml(html).textContent).toBe(input.replace(/\n/g, ''));
    });

    it('画像の書き方 ![alt](url) でも同じ', () => {
      const input = '![alt](javascript:alert(1))';
      const html = parseMarkdown(input);
      expect(html).not.toContain('<a');
      expect(html).not.toContain('<img');
      expect(parseHtml(html).textContent).toBe(input);
    });
  });

  describe('引用符で href から抜け出して属性やタグを足すことはできない', () => {
    it('空白なしでダブルクオートを挟んでも、属性は増えない (href の値の一部になる)', () => {
      const html = parseMarkdown('[x](https://example.com"onmouseover="alert(1))');
      const anchor = parseHtml(html).querySelector('a');
      expect(anchor).not.toBeNull();
      expect(anchor?.hasAttribute('onmouseover')).toBe(false);
      expect(anchor?.getAttributeNames().sort()).toEqual(['class', 'href', 'rel', 'target']);
      expect(anchor?.getAttribute('href')).toBe('https://example.com"onmouseover="alert(1');
      // 生の " が href の外へ出ていない
      expect(html).not.toContain('"onmouseover');
      expectOnlyAllowedMarkup(html);
    });

    it.each([
      '[x](https://example.com" onmouseover="alert(1))',
      "[x](https://example.com' onmouseover='alert(1))",
      '[x](https://example.com"><img src=x onerror=alert(1)>)',
      '[x](https://example.com" style="x:expression(alert(1))")',
    ])('空白を挟む手口はリンクにならず、文字のまま表示される: %s', (input) => {
      const html = parseMarkdown(input);
      expect(html).not.toContain('<a');
      expectOnlyAllowedMarkup(html, input);
      expect(parseHtml(html).textContent).toBe(input);
    });

    it('">< で閉じて新しい要素を足そうとしても、要素は増えない', () => {
      const input = '[x](https://example.com"><svg/onload=alert(1)>)';
      const html = parseMarkdown(input);
      expectOnlyAllowedMarkup(html, input);
      expect(parseHtml(html).querySelector('svg')).toBeNull();
      expect(parseHtml(html).querySelectorAll('a')).toHaveLength(1);
    });

    it('表示文字の側の引用符も属性にならない', () => {
      const input = '[x" onmouseover="alert(1)](https://example.com)';
      const html = parseMarkdown(input);
      const anchor = parseHtml(html).querySelector('a');
      expect(anchor?.hasAttribute('onmouseover')).toBe(false);
      expect(anchor?.textContent).toBe('x" onmouseover="alert(1)');
      expectOnlyAllowedMarkup(html, input);
    });
  });
});

// ─────────────────────────────────────────────
// コード
// ─────────────────────────────────────────────
describe('コード', () => {
  it('コードブロックの中の HTML はエスケープされたまま字面どおりに出る', () => {
    const html = parseMarkdown('```html\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```');
    expect(html).toBe(
      '<pre class="md-code-block"><code>&lt;script&gt;alert(1)&lt;/script&gt;<br>&lt;img src=x onerror=alert(1)&gt;\n</code></pre>',
    );
    const fragment = parseHtml(html);
    expect(fragment.querySelector('script')).toBeNull();
    expect(fragment.querySelector('img')).toBeNull();
    expect(fragment.querySelector('pre > code')?.textContent).toBe(
      '<script>alert(1)</script><img src=x onerror=alert(1)>\n',
    );
    expectOnlyAllowedMarkup(html);
  });

  it('インラインコードの中の HTML もエスケープされたまま', () => {
    const html = parseMarkdown('`<img src=x onerror=alert(1)>` と `<script>alert(1)</script>`');
    expect(html).toBe(
      '<code class="md-inline-code">&lt;img src=x onerror=alert(1)&gt;</code> と <code class="md-inline-code">&lt;script&gt;alert(1)&lt;/script&gt;</code>',
    );
    const fragment = parseHtml(html);
    expect(fragment.querySelector('img')).toBeNull();
    expect(fragment.querySelector('script')).toBeNull();
    expectOnlyAllowedMarkup(html);
  });

  it('コードの中の " と \' は引用符のエンティティになる', () => {
    const html = parseMarkdown('`<a href="x" title=\'y\'>`');
    expect(html).toBe('<code class="md-inline-code">&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;</code>');
  });

  it('コードの中の記号が太字・斜体・見出し・リスト・リンクに変わらない', () => {
    const inline = parseMarkdown('`snake_case_name` と `a * b * c` と `**not bold**`');
    expect(inline).toBe(
      '<code class="md-inline-code">snake_case_name</code> と <code class="md-inline-code">a * b * c</code> と <code class="md-inline-code">**not bold**</code>',
    );

    const block = parseMarkdown('```\n# コメント\n- 項目\n1. 手順\nx = a * b * c\n[a](https://example.com)\n```');
    const fragment = parseHtml(block);
    expect(fragment.querySelector('pre > code')?.textContent).toBe(
      '# コメント- 項目1. 手順x = a * b * c[a](https://example.com)\n',
    );
    for (const tag of ['em', 'strong', 'h2', 'ul', 'ol', 'li', 'a']) {
      expect(fragment.querySelector(tag), `<${tag}> がコードの中に出ている\n${block}`).toBeNull();
    }
  });

  it('コードの中の $& や $1 は、置換パターンとして解釈されずそのまま出る', () => {
    // String.prototype.replace の文字列テンプレートだと $& $1 $$ が特別扱いされる。目印を戻すときに崩れないこと。
    expect(parseMarkdown('`$& $1 $$`')).toBe('<code class="md-inline-code">$&amp; $1 $$</code>');
    const block = parseMarkdown('```\n$& $1\n```');
    expect(parseHtml(block).querySelector('code')?.textContent).toBe('$& $1\n');
  });

  it('閉じていないコードブロックの中の HTML も、タグにならない', () => {
    const input = '```\n<script>alert(1)</script>';
    const html = parseMarkdown(input);
    expectOnlyAllowedMarkup(html, input);
    expect(parseHtml(html).querySelector('script')).toBeNull();
  });

  it('入力に作業用の目印 (NUL) を混ぜても、コードの中身を差し込ませたり出力に残したりできない', () => {
    const html = parseMarkdown('`<b>secret</b>`\u00000\u0000 と \u00001\u0000');
    expect(html).not.toContain('\u0000');
    expect(html.match(/secret/g)).toHaveLength(1);
    expect(parseHtml(html).textContent).toBe('<b>secret</b>0 と 1');
  });

  it('インラインコードの中にコードブロックが入る入れ子でも、目印が残らない', () => {
    const input = '`前 ```js\n<b>x</b>\n``` 後`';
    const html = parseMarkdown(input);
    expect(html).not.toContain('\u0000');
    expectOnlyAllowedMarkup(html, input);
    expect(parseHtml(html).textContent).toContain('<b>x</b>');
  });

  it('アクションブロック (```action) は表示せず取り除く', () => {
    expect(parseMarkdown('こちらです。\n```action\n{"type":"x","note":"<script>"}\n```\n実行しますか？')).toBe(
      'こちらです。<br><br>実行しますか？',
    );
  });
});

// ─────────────────────────────────────────────
// 通常の文章の見た目が変わっていないこと
// 期待値は、修正前の parseMarkdown (AIChatBubble.tsx の自前実装) が実際に返した HTML。
// ─────────────────────────────────────────────
describe('通常の文章 (修正前と同じ出力)', () => {
  it.each([
    ['空文字', '', ''],
    ['太字 (**)', '**太字**です', '<strong>太字</strong>です'],
    ['太字 (__)', '__太字__です', '<strong>太字</strong>です'],
    ['斜体 (*)', '*斜体*です', '<em>斜体</em>です'],
    ['斜体 (_)', '_斜体_です', '<em>斜体</em>です'],
    ['太字と斜体', '**太字**と*斜体*', '<strong>太字</strong>と<em>斜体</em>'],
    ['見出し (#)', '# 見出し1', '<h2 class="md-h2">見出し1</h2>'],
    ['見出し (##)', '## 見出し2', '<h3 class="md-h3">見出し2</h3>'],
    ['見出し (###)', '### 見出し3', '<h4 class="md-h4">見出し3</h4>'],
    [
      '箇条書き',
      '- りんご\n- みかん\n- ぶどう',
      '<ul class="md-ul"><li class="md-li">りんご</li>\n<li class="md-li">みかん</li>\n<li class="md-li">ぶどう</li></ul>',
    ],
    [
      '番号付きリスト',
      '1. 洗う\n2. 切る\n3. 焼く',
      '<ol class="md-ol"><li class="md-li-num">洗う</li>\n<li class="md-li-num">切る</li>\n<li class="md-li-num">焼く</li></ol>',
    ],
    ['改行', '1行目\n2行目\n3行目', '1行目<br>2行目<br>3行目'],
    ['空行', '1行目\n\n3行目', '1行目<br><br>3行目'],
    [
      'リンク',
      '詳しくは[こちら](https://example.com/page?id=1)をご覧ください',
      '詳しくは<a href="https://example.com/page?id=1" target="_blank" rel="noopener noreferrer" class="md-link">こちら</a>をご覧ください',
    ],
    [
      'mailto リンク',
      '[連絡](mailto:info@example.com)',
      '<a href="mailto:info@example.com" target="_blank" rel="noopener noreferrer" class="md-link">連絡</a>',
    ],
    [
      'コードブロック',
      '前\n```js\nconst a = 1;\nconst b = 2;\n```\n後',
      '前\n<pre class="md-code-block"><code>const a = 1;<br>const b = 2;\n</code></pre><br>後',
    ],
    ['インラインコード', '`npm run dev` を実行', '<code class="md-inline-code">npm run dev</code> を実行'],
    [
      '献立の返答 (見出し・太字・リスト・改行の組み合わせ)',
      '## 今日の献立\n\n**朝食**\n- ご飯 (250kcal)\n- 味噌汁 (40kcal)\n\n### ポイント\n1. 野菜を先に食べる\n2. よく噛む\n\n以上です😊',
      '<h3 class="md-h3">今日の献立</h3><br>\n<strong>朝食</strong>\n<ul class="md-ul"><li class="md-li">ご飯 (250kcal)</li>\n<li class="md-li">味噌汁 (40kcal)</li>\n</ul>\n<h4 class="md-h4">ポイント</h4>\n<ol class="md-ol"><li class="md-li-num">野菜を先に食べる</li>\n<li class="md-li-num">よく噛む</li>\n</ol><br>以上です😊',
    ],
  ])('%s', (_name, input, expected) => {
    expect(parseMarkdown(input)).toBe(expected);
  });

  it('空・null・undefined・文字列でない値は空文字を返す', () => {
    expect(parseMarkdown('')).toBe('');
    expect(parseMarkdown(null)).toBe('');
    expect(parseMarkdown(undefined)).toBe('');
    expect(parseMarkdown(123 as unknown as string)).toBe('');
  });
});

// ─────────────────────────────────────────────
// でたらめな組み合わせでも、許可した以外のタグ・属性が出ないこと
// ─────────────────────────────────────────────
describe('でたらめな組み合わせ', () => {
  /** 再現できる乱数 (線形合同法)。失敗したときに同じ入力を再現できるよう、シードを固定する。 */
  function createRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  const PARTS = [
    '<', '>', '"', "'", '`', '```', '```js\n', '```action\n', '[', ']', '(', ')', '](', '*', '**', '_', '__', '#', '## ',
    '- ', '1. ', '\n', '\n\n', ' ', '\t', '&', '&#106;', '&lt;', '&quot;', '\u0000', '0', 'a', 'b', 'x_y', '/', '//', '\\',
    'javascript:', 'JavaScript:', 'data:', 'https://', 'mailto:', 'onerror=', 'onmouseover=', 'alert(1)',
    '<img src=x onerror=alert(1)>', '<script>', '</script>', '<svg onload=alert(1)>', '"><img src=x onerror=alert(1)>',
    '[x](https://example.com)', '[x](javascript:alert(1))', '`code`', '**bold**', '$&', '$1',
  ];

  it('1500 通りのでたらめな入力で、出力は許可したタグ・属性だけ', () => {
    const random = createRandom(1169);
    for (let i = 0; i < 1500; i += 1) {
      const length = 1 + Math.floor(random() * 40);
      let input = '';
      for (let j = 0; j < length; j += 1) {
        input += PARTS[Math.floor(random() * PARTS.length)];
      }
      expectOnlyAllowedMarkup(parseMarkdown(input), input);
    }
  });
});
