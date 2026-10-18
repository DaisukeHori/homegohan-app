// よくある質問 (docs/design/marketing/01-landing-site.md §4.19・§8.3 の FaqSection・M-8・§13.3 の FAQ の表)。Server Component (島にしない)。
// 12 件の details (faq.items の順)。各 details の中は summary (中に h3 (問いの文) と ChevronDown (aria-hidden)) と、答えの箱 (p)。
// 開閉はブラウザの details に任せる (open 属性。JS を持たない) ので、JS が無くても開いて答えを読める (R-18)。サーバーの HTML ではどれも閉じて描く。
// name 属性は付けない (どの details も自分だけで開閉し、複数を同時に開ける)。summary の既定の三角の印は出さない (矢印は ChevronDown)。
// 動きは矢印の回転だけ (M-8。open の状態で CSS が決める。遷移の宣言は no-preference の中だけ)。末尾に問い合わせの行 (Link)。
import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { LANDING_COPY } from '../landing-copy';
import { Reveal } from '../primitives/Reveal';

export function FaqSection() {
  const faq = LANDING_COPY.faq;
  return (
    <section id="faq" aria-labelledby="faq-title" tabIndex={-1} className="lp-section lp-band lp-faq-section">
      <div className="lp-container lp-faq-layout">
        <Reveal index={0} className="lp-section-head lp-faq-head">
          <h2 id="faq-title">{faq.title}</h2>
          <p className="lp-lead">{faq.lead}</p>
        </Reveal>
        <div className="lp-faq-main">
          <Reveal index={0} className="lp-faq">
            {faq.items.map((item) => (
              <details key={item.q} className="lp-faq-item">
                <summary className="lp-faq-summary">
                  <h3>{item.q}</h3>
                  <ChevronDown className="lp-faq-chevron" aria-hidden="true" />
                </summary>
                <div className="lp-faq-answer">
                  <p>{item.a}</p>
                </div>
              </details>
            ))}
          </Reveal>
          <Reveal index={0} className="lp-note lp-faq-contact">
            {faq.contactLead} <Link href={faq.contact.href}>{faq.contact.label}</Link>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
