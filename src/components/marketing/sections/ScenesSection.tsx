// 場面 (docs/design/marketing/01-landing-site.md §4.13・§5.4 の「横にスクロールする帯」・§8.3 の ScenesSection・M-13)。Server Component。
// 見出しの塊と、帯の箱 (div。role="region"・aria-label = SCENES_STRIP_LABEL・tabIndex={0}。どの幅でも同じ属性) の中の ul に 4 枚のカード
// (アイコン・h3・本文)。768 px 未満は帯の箱が横にスクロールして 1 枚ずつ止まる (CSS の scroll-snap。ページは横に動かない)。
// 768〜1023 px は 2 列・1024 px 以上は 4 列で、帯の箱はスクロールしない。
// 帯の箱は 1 つの Reveal で包み、カードの li は包まない (帯の見える幅の外の li は画面と交差しないため: §6.5)。
// 人物の名前・年齢・写真・引用・成果は書かない (§4.0)。
import { Building2, HeartPulse, User, Users, type LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { LANDING_COPY, SCENES_STRIP_LABEL, type Scene } from '../landing-copy';
import { Reveal } from '../primitives/Reveal';

/** 場面ごとのアイコン (§4.13 の表) */
const SCENE_ICONS: Record<Scene['id'], LucideIcon> = {
  solo: User,
  family: Users,
  health: HeartPulse,
  team: Building2,
};

export function ScenesSection() {
  const scenes = LANDING_COPY.scenes;
  return (
    <section id="scenes" aria-labelledby="scenes-title" tabIndex={-1} className="lp-section lp-scenes-section">
      <div className="lp-container">
        <Reveal index={0} className="lp-section-head">
          <h2 id="scenes-title">{scenes.title}</h2>
          <p className="lp-lead">{scenes.lead}</p>
        </Reveal>
        <Reveal index={0} className="lp-scenes-reveal">
          <div className="lp-strip lp-strip--scenes" role="region" aria-label={SCENES_STRIP_LABEL} tabIndex={0}>
            <ul className="lp-scenes">
              {scenes.items.map((scene, index) => {
                const Icon = SCENE_ICONS[scene.id];
                return (
                  <li key={scene.id} className={`lp-scene lp-scene--${scene.id}`} style={{ '--lp-i': index } as CSSProperties}>
                    <span className="lp-scene-icon" aria-hidden="true">
                      <Icon />
                    </span>
                    <h3>{scene.title}</h3>
                    <p>{scene.body}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
