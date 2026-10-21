// 料金 (docs/design/marketing/01-landing-site.md §4.17・§8.3 の PricingSection)。Server Component。地は tint。
// eyebrow・h2・lead・カード 2 枚 (無料プランと有料プラン。ul。見出し・札・項目の ul・CTA)・AI の上限 3 点 (ul)。768 px 以上はカード 2 列・上限 3 列、未満は 1 列。
// 価格の数字はカードの `items` (landing-copy.ts が `PLAN_CATALOG` から組む) だけに出し、このファイルに書かない。無料の一覧に組織・家族・究極モード・料理画像の作成を入れない (文言は landing-copy.ts)。
import { CalendarClock, Check, Gauge, CirclePause, Sparkles, type LucideIcon } from 'lucide-react';
import { LANDING_COPY } from '../landing-copy';
import { CtaLink } from '../primitives/CtaLink';
import { Reveal } from '../primitives/Reveal';

/** AI の上限の 3 点のアイコン (limits の順: 1 日の上限・数えない機能・一時停止) */
const LIMIT_ICONS: readonly LucideIcon[] = [Gauge, Sparkles, CirclePause];

export function PricingSection() {
  const pricing = LANDING_COPY.pricing;
  return (
    <section id="pricing" aria-labelledby="pricing-title" tabIndex={-1} className="lp-section lp-band lp-pricing">
      <div className="lp-container">
        <Reveal index={0} className="lp-section-head lp-section-head--center">
          <p className="lp-eyebrow">{pricing.eyebrow}</p>
          <h2 id="pricing-title" className="lp-h2-chapter">
            {pricing.title}
          </h2>
          <p className="lp-lead">{pricing.lead}</p>
        </Reveal>
        <ul className="lp-plans">
          {pricing.plans.map((plan, index) => (
            <Reveal key={plan.id} as="li" index={index} className={`lp-plan lp-plan--${plan.id}`}>
              <div className="lp-plan-head">
                <h3>{plan.title}</h3>
                <span className={`lp-pill lp-pill--${plan.id}`}>{plan.badge}</span>
              </div>
              {plan.items.length > 0 ? (
                <ul className="lp-plan-items">
                  {plan.items.map((item) => (
                    <li key={item}>
                      <Check className="lp-check" strokeWidth={2.5} aria-hidden="true" />
                      {item}
                    </li>
                  ))}
                </ul>
              ) : null}
              {plan.body ? (
                <p className="lp-plan-body">
                  <CalendarClock className="lp-plan-body-icon" aria-hidden="true" />
                  {plan.body}
                </p>
              ) : null}
              {plan.cta ? (
                <CtaLink href={plan.cta.href} variant="primary" className="lp-plan-cta">
                  {plan.cta.label}
                </CtaLink>
              ) : null}
            </Reveal>
          ))}
        </ul>
        <ul className="lp-limits">
          {pricing.limits.map((limit, index) => {
            const Icon = LIMIT_ICONS[index] ?? Gauge;
            return (
              <Reveal key={limit.title} as="li" index={index} className="lp-limit">
                <span className="lp-icon" aria-hidden="true">
                  <Icon />
                </span>
                <h3>{limit.title}</h3>
                <p>{limit.body}</p>
              </Reveal>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
