'use client';

// よくある質問 (docs/design/marketing/01-landing-site.md §8.3 の FaqSection・M-8・§13.3 の FAQ の遷移表)。島。状態は openIndex だけ。
// 同時に開くのは 1 つ。ボタンは aria-expanded / aria-controls を持ち、答えの箱は role=region。閉じている間は inert (Tab にも読み上げにも出ない)。
// 答えの文は DOM に常にあるので、JS 無しでもクローラーは読める (JS 無しは閉じたまま。判断は §13.3)。
import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { LANDING_COPY } from '../landing-copy';
import { Reveal } from '../primitives/Reveal';

export function FaqSection() {
  const faq = LANDING_COPY.faq;
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section id="faq" aria-labelledby="faq-title" className="lp-section lp-band">
      <div className="lp-container">
        <Reveal index={0} className="lp-section-head">
          <h2 id="faq-title">{faq.title}</h2>
          <p className="lp-lead">{faq.lead}</p>
        </Reveal>
        <Reveal index={0} className="lp-faq">
          {faq.items.map((item, index) => {
            const open = openIndex === index;
            const buttonId = `faq-button-${index}`;
            const panelId = `faq-panel-${index}`;
            return (
              <div key={item.q} className="lp-faq-item">
                <h3>
                  <button
                    type="button"
                    id={buttonId}
                    className="lp-faq-btn"
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => setOpenIndex(open ? null : index)}
                  >
                    <span>{item.q}</span>
                    <ChevronDown className={open ? 'lp-faq-chevron is-open' : 'lp-faq-chevron'} aria-hidden="true" />
                  </button>
                </h3>
                <div id={panelId} role="region" aria-labelledby={buttonId} className={open ? 'lp-faq-panel is-open' : 'lp-faq-panel'}>
                  <div inert={!open}>
                    <p>{item.a}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </Reveal>
        <Reveal index={0} className="lp-note lp-faq-contact">
          {faq.contactLead} <Link href={faq.contact.href}>{faq.contact.label}</Link>
        </Reveal>
      </div>
    </section>
  );
}
