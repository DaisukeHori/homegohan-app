import Link from 'next/link';
import type { LegalBlock, LegalDocumentText } from '@/lib/legal/legal-text';

/**
 * 利用規約・プライバシーポリシーの本文を描く (#1901)。文面は src/lib/legal の termsText / privacyText が作り、
 * ここは章を h2・条を h3・ブロックを p / ul / ol / table / リンクの一覧 / AI 事業者の一覧 / 窓口 に写すだけ。
 * AI 事業者の一覧の <ul data-testid="privacy-ai-providers"> と行の形「名前（国）：使い道」は
 * tests/business-info-legal-pages.test.ts が検査する (#1366 の形をそのまま引き継ぐ)。
 */
function Block({ block }: { block: LegalBlock }) {
  switch (block.kind) {
    case 'p':
      return <p>{block.text}</p>;
    case 'ul':
      return (
        <ul>
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol>
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      );
    case 'table':
      return (
        <table>
          <thead>
            <tr>
              {block.headers.map((h) => (
                <th key={h} scope="col">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row) => (
              <tr key={row.join('|')}>
                {row.map((cell, i) => (
                  <td key={`${i}-${cell}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'links':
      return (
        <ul data-legal-links="">
          {block.items.map((item) => (
            <li key={item.href}>
              <Link href={item.href} className="underline underline-offset-4 text-orange-700 hover:text-orange-800">
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      );
    case 'ai_providers':
      return (
        <ul data-testid="privacy-ai-providers">
          {block.providers.map((p) => (
            <li key={p.name}>
              {p.name}（{p.country}）：{p.usage}
            </li>
          ))}
        </ul>
      );
    case 'contact':
      return (
        <p>
          {block.lines.map((line) => (
            <span key={line}>
              {line}
              <br />
            </span>
          ))}
          E-mail: {block.email}
        </p>
      );
  }
}

export function LegalDocumentBody({ document }: { document: LegalDocumentText }) {
  return (
    <>
      {document.preamble?.map((block, i) => <Block key={`preamble-${i}`} block={block} />)}
      {document.chapters.map((chapter) => (
        <section key={chapter.id} id={chapter.id}>
          {chapter.title !== null && <h2>{chapter.title}</h2>}
          {chapter.sections.map((section) => (
            <section key={section.id} id={section.id}>
              <h3>{section.heading}</h3>
              {section.blocks.map((block, i) => (
                <Block key={`${section.id}-${i}`} block={block} />
              ))}
            </section>
          ))}
        </section>
      ))}
    </>
  );
}
