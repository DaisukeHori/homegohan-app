// 安心 (docs/design/marketing/01-landing-site.md §4.7・§8.3 の TrustSection)。Server Component。
// 実績の代わりに、正直さで信頼を作る: 無料と AI の 1 日の上限・データと同意・AI の限界・退会と書き出しの 4 点。
import { Check, FileJson, ShieldCheck, Stethoscope, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { LANDING_COPY } from '../landing-copy';
import { Reveal } from '../primitives/Reveal';

/** 4 点のアイコン (trust.items の順。§5.5) */
const TRUST_ICONS: readonly LucideIcon[] = [Check, ShieldCheck, Stethoscope, FileJson];

export function TrustSection() {
  const trust = LANDING_COPY.trust;
  return (
    <section id="trust" aria-labelledby="trust-title" className="lp-section">
      <div className="lp-container">
        <Reveal index={0} className="lp-section-head">
          <h2 id="trust-title">{trust.title}</h2>
        </Reveal>
        <ul className="lp-trust">
          {trust.items.map((item, index) => {
            const Icon = TRUST_ICONS[index] ?? Check;
            return (
              <Reveal key={item.title} as="li" index={index} className="lp-trust-item">
                <div className="lp-icon" aria-hidden="true">
                  <Icon />
                </div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                {item.link && <Link href={item.link.href}>{item.link.label}</Link>}
              </Reveal>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
