// バッジ (docs/design/marketing/01-landing-site.md §4.6・§8.3 の BadgesSection・M-10)。Server Component。
// 実在し、付与の処理があり、名前が付与の条件と食い違わないバッジ 4 つ。カードの列を 1 つの Reveal で包み、各カードの立ち上がりは CSS が --lp-stagger ずつずらす。
import { Flame, Footprints, GraduationCap, Trophy, type LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { LANDING_COPY, type BadgeCard } from '../landing-copy';
import { Reveal } from '../primitives/Reveal';

const BADGE_ICONS: Record<BadgeCard['code'], LucideIcon> = {
  first_bite: Footprints,
  streak_3: Flame,
  streak_7: Trophy,
  tutorial_complete: GraduationCap,
};

export function BadgesSection() {
  const badges = LANDING_COPY.badges;
  return (
    <section id="badges" aria-labelledby="badges-title" className="lp-section lp-band">
      <div className="lp-container">
        <Reveal index={0} className="lp-section-head">
          <h2 id="badges-title">{badges.title}</h2>
          <p className="lp-lead">{badges.lead}</p>
        </Reveal>
        <Reveal index={0}>
          <ul className="lp-badges">
            {badges.items.map((badge, index) => {
              const Icon = BADGE_ICONS[badge.code];
              return (
                <li key={badge.code} className="lp-badge-card" style={{ '--lp-i': index } as CSSProperties}>
                  <div className="lp-badge-ring" aria-hidden="true">
                    <Icon />
                  </div>
                  <div>
                    <h3>{badge.name}</h3>
                    <p>{badge.description}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
