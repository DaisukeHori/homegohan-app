/**
 * #1901 利用規約・プライバシーポリシーの本文を描く部品 LegalDocumentBody (設計書 docs/design/cross/20-terms-privacy-text.md §8.2・§13 の T-21〜T-23)
 *
 * 部品は、章を h2・条を h3・ブロックを p / ul / ol / table / リンクの一覧 / AI 事業者の一覧 / 窓口 に写すだけ。
 * ここでは、章の見出しの有無・表の見出し・リンク・前文の位置・節のアンカーを確かめる。
 * このリポジトリには @testing-library/react が無いため、react-dom/server で HTML にして読む。
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LegalDocumentBody } from '@/components/legal/LegalDocumentBody';
import type { LegalDocumentText, LegalTextContext } from '@/lib/legal/legal-text';
import { privacyText } from '@/lib/legal/privacy-text';
import { termsText } from '@/lib/legal/terms-text';

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

const CTX: LegalTextContext = {
  businessName: 'TESTCO',
  businessAddress: 'TESTADDRESS',
  businessRepresentative: 'TESTREP',
  phoneDisclosure: 'TESTPHONE',
  businessEmail: 'contact@example.com',
  businessHours: 'TESTHOURS',
  aiProviders: [],
};

function render(document: LegalDocumentText): string {
  return renderToStaticMarkup(createElement(LegalDocumentBody, { document }));
}

const SAMPLE: LegalDocumentText = {
  type: 'privacy_policy',
  preamble: [{ kind: 'p', text: 'PREAMBLE-TEXT' }],
  chapters: [
    {
      id: 'privacy-ch-untitled',
      title: null,
      sections: [
        {
          id: 'privacy-sample-1',
          heading: 'SECTION-HEADING-1',
          blocks: [
            { kind: 'table', headers: ['HEAD-A', 'HEAD-B'], rows: [['CELL-A1', 'CELL-B1']] },
            { kind: 'links', items: [{ label: 'LINK-LABEL', href: '/contact' }] },
          ],
        },
      ],
    },
    {
      id: 'privacy-ch-titled',
      title: 'CHAPTER-TITLE',
      sections: [{ id: 'privacy-sample-2', heading: 'SECTION-HEADING-2', blocks: [{ kind: 'ol', items: ['OL-ITEM'] }] }],
    },
  ],
};

describe('#1901 LegalDocumentBody', () => {
  it('T-21 LegalDocumentBody は title が null の章に h2 を出さず、table に thead を出し、links を a で描く', () => {
    const html = render(SAMPLE);
    const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => m[1]);
    expect(h2s).toEqual(['CHAPTER-TITLE']);
    expect(html).toMatch(/<table><thead><tr><th scope="col">HEAD-A<\/th><th scope="col">HEAD-B<\/th><\/tr><\/thead><tbody><tr><td>CELL-A1<\/td><td>CELL-B1<\/td><\/tr><\/tbody><\/table>/);
    expect(html).toMatch(/<a href="\/contact"[^>]*>LINK-LABEL<\/a>/);
    expect(html).toContain('<ol><li>OL-ITEM</li></ol>');

    // 実際の文書でも、プライバシーポリシー (章の題が null) は h2 を出さず、利用規約は章の数だけ h2 を出す
    const privacy = privacyText(CTX);
    const terms = termsText(CTX);
    expect(render(privacy)).not.toContain('<h2');
    expect([...render(terms).matchAll(/<h2>/g)]).toHaveLength(terms.chapters.length);
  });

  it('T-22 LegalDocumentBody は preamble を章の前に出す', () => {
    const html = render(SAMPLE);
    const preamble = html.indexOf('<p>PREAMBLE-TEXT</p>');
    expect(preamble).toBeGreaterThan(-1);
    expect(preamble).toBeLessThan(html.indexOf('id="privacy-ch-untitled"'));
    expect(preamble).toBeLessThan(html.indexOf('SECTION-HEADING-1'));
  });

  it('T-23 各 section の id が描画した HTML の id 属性に出る', () => {
    for (const document of [termsText(CTX), privacyText(CTX), SAMPLE]) {
      const html = render(document);
      for (const chapter of document.chapters) {
        expect(html).toContain(`id="${chapter.id}"`);
        for (const section of chapter.sections) expect(html).toContain(`<section id="${section.id}"><h3>`);
      }
    }
  });
});
