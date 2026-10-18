// 章の共通の骨格 (docs/design/marketing/01-landing-site.md §4.7〜§4.12・§5.4・§6.5・§8.2・§8.3 の ChapterSection)。Server Component。
// 6 つの章 (写真で記録・AI 献立と買い物・栄養の見える化・健康の記録・バッジ・AI に相談) が LANDING_COPY.chapters の 1 つを渡して使う。
// 中は DOM の順に: 章の番号 (aria-hidden)・eyebrow・h2・lead・要点の ul (アイコンの輪・h3・本文)・children (章ごとの追加: 輪・バッジの列・免責)・
// 画面の塊 (PhoneFrame ×1〜5 と札)・拡大 (chapter.zoom があれば ScreenZoom。画面の塊とは別の Reveal で包む)・画面の注記・CTA。
// - 画面が SCREEN_STRIP_MIN_SCREENS (2) 枚以上なら、画面の塊を「横にスクロールする帯」の箱 (div に role="region"・aria-label = screenStripLabel(eyebrow)・
//   tabIndex={0}。中に ul) で描く。属性はどの幅でも同じ (Server の HTML に出す)。768 px 未満だけ箱がスクロールする (CSS)。1 枚なら帯にしない。
// - 1024 px 以上は 2 列 (文字 7 : 画面 5)。章の番号が偶数なら画面が左 (章ごとに左右を入れ替える)。CTA は文字の列の下に置く。
// - 地は tone (§5.1 の区切りごとの地)。tone が dark なら文字は --lp-on-dark* の組・CTA は on-dark。
// - 現れ方 (§6.5): 見出しの塊・要点を 1 つずつ・画面の塊 (帯の箱の外側の 1 つ)・拡大・CTA を Reveal で包む。帯の中の端末は包まない。
import { Camera, Check, ChefHat, MessageCircle, Scale, TrendingUp, Trophy, type LucideIcon } from 'lucide-react';
import Image from 'next/image';
import type { CSSProperties, ReactNode } from 'react';
import {
  LANDING_IMAGE_SIZES,
  SCREEN_STRIP_MIN_SCREENS,
  screenStripLabel,
  type Chapter,
  type ChapterId,
  type ChapterScreen,
  type ChapterTone,
} from '../landing-copy';
import { CtaLink } from '../primitives/CtaLink';
import { GUIDE_SCREEN_HEIGHT_PX, GUIDE_SCREEN_WIDTH_PX, PhoneFrame } from '../primitives/PhoneFrame';
import { Reveal } from '../primitives/Reveal';
import { ScreenZoom } from '../primitives/ScreenZoom';

/** 章の eyebrow の横のアイコン (§5.5: 機能のカードと同じ対応) */
const CHAPTER_ICONS: Record<ChapterId, LucideIcon> = {
  photo: Camera,
  menu: ChefHat,
  nutrition: TrendingUp,
  health: Scale,
  badges: Trophy,
  chat: MessageCircle,
};
/** 章の番号の桁 (01〜06) */
const CHAPTER_NUMBER_DIGITS = 2;
/** 章の番号が偶数なら画面の列を左にする (左右の入れ替え) */
const FLIP_DIVISOR = 2;

type ChapterSectionProps = {
  chapter: Chapter;
  number: number;
  tone: ChapterTone;
  children?: ReactNode;
};

/** 端末の枠に入れた実際の画面と、その真下の札 (何の画面か) */
function ChapterShot({ screen }: { screen: ChapterScreen }) {
  return (
    <>
      <PhoneFrame className="lp-shot-phone">
        <Image
          src={screen.image.src}
          alt={screen.image.alt}
          width={GUIDE_SCREEN_WIDTH_PX}
          height={GUIDE_SCREEN_HEIGHT_PX}
          sizes={LANDING_IMAGE_SIZES.chapter}
        />
      </PhoneFrame>
      <p className="lp-shot-label">{screen.label}</p>
    </>
  );
}

/** 画面の塊: 2 枚以上は横にスクロールする帯の箱 (§5.4)、1 枚はその 1 枚 */
function ChapterScreens({ screens, stripLabel }: { screens: readonly ChapterScreen[]; stripLabel: string }) {
  if (screens.length < SCREEN_STRIP_MIN_SCREENS) {
    return (
      <div className="lp-shots lp-shots--single">
        {screens.map((screen) => (
          <div key={screen.image.src} className="lp-shot">
            <ChapterShot screen={screen} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="lp-strip" role="region" aria-label={stripLabel} tabIndex={0}>
      <ul className={`lp-shots lp-shots--${screens.length}`} style={{ '--lp-shot-count': screens.length } as CSSProperties}>
        {screens.map((screen) => (
          <li key={screen.image.src} className="lp-shot">
            <ChapterShot screen={screen} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChapterSection({ chapter, number, tone, children }: ChapterSectionProps) {
  const titleId = `${chapter.id}-title`;
  const Icon = CHAPTER_ICONS[chapter.id];
  const flipped = number % FLIP_DIVISOR === 0;
  const classes = ['lp-chapter', `lp-chapter--${chapter.id}`, `lp-tone-${tone}`, flipped ? 'is-flipped' : ''].filter(Boolean).join(' ');
  return (
    <section id={chapter.id} aria-labelledby={titleId} tabIndex={-1} className={classes}>
      <div className="lp-container lp-chapter-grid">
        <Reveal index={0} className="lp-chapter-head">
          <p className="lp-chapter-meta">
            <span className="lp-chapter-num" aria-hidden="true">
              {String(number).padStart(CHAPTER_NUMBER_DIGITS, '0')}
            </span>
            <span className="lp-eyebrow lp-chapter-eyebrow">
              <Icon className="lp-eyebrow-icon" aria-hidden="true" />
              {chapter.eyebrow}
            </span>
          </p>
          <h2 id={titleId}>{chapter.title}</h2>
          <p className="lp-lead">{chapter.lead}</p>
        </Reveal>
        <ul className="lp-points">
          {chapter.points.map((point, index) => (
            <Reveal key={point.title} as="li" index={index} className="lp-point">
              <span className="lp-point-icon" aria-hidden="true">
                <Check strokeWidth={2.5} />
              </span>
              <div className="lp-point-text">
                <h3>{point.title}</h3>
                <p>{point.body}</p>
              </div>
            </Reveal>
          ))}
        </ul>
        {children ? <div className="lp-chapter-extra">{children}</div> : null}
        <div className="lp-chapter-media">
          <Reveal index={0} className="lp-shots-reveal">
            <ChapterScreens screens={chapter.screens} stripLabel={screenStripLabel(chapter.eyebrow)} />
          </Reveal>
          {chapter.zoom ? (
            <Reveal index={0} className="lp-zoom-reveal">
              <ScreenZoom zoom={chapter.zoom} />
            </Reveal>
          ) : null}
          <p className="lp-caption">{chapter.screensCaption}</p>
        </div>
        <Reveal index={0} className="lp-chapter-cta">
          <CtaLink href={chapter.cta.href} variant={tone === 'dark' ? 'on-dark' : 'primary'}>
            {chapter.cta.label}
          </CtaLink>
        </Reveal>
      </div>
    </section>
  );
}
