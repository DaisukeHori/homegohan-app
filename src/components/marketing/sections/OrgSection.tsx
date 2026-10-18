// 組織で使う (docs/design/marketing/01-landing-site.md §4.15・§5.7 の組織の形の図・§8.3 の OrgSection)。Server Component。地は blue。
// eyebrow・h2・lead・要点 4 つ・組織の形の図・CTA (secondary → /contact) (この DOM の順)。1024 px 以上は 2 列。実際の画面は置かない (管理者の画面は図で示す)。
// 図: 上の段に札「管理者」(白 on --lp-blue-ink)、下の段に横に並ぶ札 3 つ (org.figure.managed の順。--lp-surface の上に --lp-blue-ink の文字)、
// 管理者の札から 3 つの札へ SVG の線 3 本 (--lp-blue・2 px。aria-hidden)。下の段の札どうしはつながず、部署の下にメンバーを置く階層は描かない
// (メンバーを部署に分ける手段は製品に無い: §2.5)。320 px でも下の段の 3 つは 1 行に並ぶ。
import { Building2, Lock, Trophy, UserCog, Users, type LucideIcon } from 'lucide-react';
import { LANDING_COPY } from '../landing-copy';
import { CtaLink } from '../primitives/CtaLink';
import { Reveal } from '../primitives/Reveal';

/** 要点のアイコン (points の順。管理者の画面・部署と招待・チャレンジ・一人ひとりの記録は見せません) */
const POINT_ICONS: readonly LucideIcon[] = [UserCog, Building2, Trophy, Lock];
/** 図の下の段の札のアイコン (org.figure.managed の順: メンバー・部署・チャレンジ。§5.5) */
const MANAGED_ICONS: readonly LucideIcon[] = [Users, Building2, Trophy];
/**
 * 図の線 (viewBox 0 0 6 2 の上で、管理者の札の下の真ん中 (3, 0) から、3 列の札の上の真ん中 (1, 2)・(3, 2)・(5, 2) へ)。
 * 下の段は同じ幅の 3 列なので、列の真ん中は幅の 1/6・3/6・5/6
 */
const ORG_LINE_PATHS = ['M 3 0 L 1 2', 'M 3 0 L 3 2', 'M 3 0 L 5 2'] as const;

export function OrgSection() {
  const org = LANDING_COPY.org;
  return (
    <section id="org" aria-labelledby="org-title" tabIndex={-1} className="lp-section lp-org">
      <div className="lp-container lp-split">
        <div className="lp-split-copy">
          <Reveal index={0} className="lp-section-head">
            <p className="lp-eyebrow">{org.eyebrow}</p>
            <h2 id="org-title" className="lp-h2-chapter">
              {org.title}
            </h2>
            <p className="lp-lead">{org.lead}</p>
          </Reveal>
          <ul className="lp-points">
            {org.points.map((point, index) => {
              const Icon = POINT_ICONS[index] ?? UserCog;
              return (
                <Reveal key={point.title} as="li" index={index} className="lp-point">
                  <span className="lp-point-icon" aria-hidden="true">
                    <Icon strokeWidth={2.25} />
                  </span>
                  <div className="lp-point-text">
                    <h3>{point.title}</h3>
                    <p>{point.body}</p>
                  </div>
                </Reveal>
              );
            })}
          </ul>
        </div>
        <div className="lp-split-media">
          <Reveal index={0} className="lp-org-figure">
            <p className="lp-org-admin">
              <UserCog className="lp-org-icon" aria-hidden="true" />
              {org.figure.admin}
            </p>
            <svg className="lp-org-lines" viewBox="0 0 6 2" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              {ORG_LINE_PATHS.map((d) => (
                <path key={d} d={d} vectorEffect="non-scaling-stroke" />
              ))}
            </svg>
            <ul className="lp-org-managed">
              {org.figure.managed.map((label, index) => {
                const Icon = MANAGED_ICONS[index] ?? Users;
                return (
                  <li key={label} className="lp-org-node">
                    <Icon className="lp-org-icon" aria-hidden="true" />
                    {label}
                  </li>
                );
              })}
            </ul>
          </Reveal>
        </div>
        <Reveal index={0} className="lp-split-cta">
          <CtaLink href={org.cta.href} variant="secondary">
            {org.cta.label}
          </CtaLink>
        </Reveal>
      </div>
    </section>
  );
}
