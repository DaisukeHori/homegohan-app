// 最終 CTA (docs/design/marketing/01-landing-site.md §4.20・§8.3 の FinalCtaSection)。Server Component。
// 面は --lp-dark の単色 (光や模様を重ねない)。文字は §5.1 の濃色の面の組だけ。中身を 1 つの Reveal で包む。
// section は tabIndex={-1} (ページの中のリンクの先にフォーカスを移せるように: §2.2。Tab の順には入らない)。
import { Check } from 'lucide-react';
import { LANDING_COPY } from '../landing-copy';
import { CtaLink } from '../primitives/CtaLink';
import { Reveal } from '../primitives/Reveal';

export function FinalCtaSection() {
  const cta = LANDING_COPY.finalCta;
  return (
    <section id="cta" aria-labelledby="cta-title" tabIndex={-1} className="lp-section lp-final">
      <Reveal index={0} className="lp-final-inner">
        <h2 id="cta-title">{cta.title}</h2>
        <p className="lp-lead">{cta.lead}</p>
        <CtaLink href={cta.cta.href} variant="on-dark">
          {cta.cta.label}
        </CtaLink>
        <ul className="lp-assurances">
          {cta.assurances.map((text) => (
            <li key={text}>
              <Check className="lp-check" strokeWidth={2.5} aria-hidden="true" />
              {text}
            </li>
          ))}
        </ul>
        <p className="lp-disclaimer">{cta.disclaimer}</p>
      </Reveal>
    </section>
  );
}
