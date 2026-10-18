// 安全とプライバシー (docs/design/marketing/01-landing-site.md §4.16・§8.3 の TrustSection)。Server Component。
// 実績の代わりに、正直さで信頼を作る 6 点 (無料と AI の 1 日の上限・データと同意・写真の保存・AI の限界・ログイン中の端末・退会と書き出しと請求)。
// 見出しの塊・ul の中に 6 項目 (アイコン・h3・本文・あればリンク)・画面 1 枚 (consent.png)・画面の注記 (この DOM の順)。
// 6 項目は 768 px 未満で 1 列・768〜1279 px で 2 列・1280 px 以上で 3 列 (2 行)。見出しは 1 行 (E-22)。リンクは高さ 24 px 以上。
import { Check, FileJson, Lock, MonitorSmartphone, ShieldCheck, Stethoscope, type LucideIcon } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { LANDING_COPY, LANDING_IMAGE_SIZES } from '../landing-copy';
import { GUIDE_SCREEN_HEIGHT_PX, GUIDE_SCREEN_WIDTH_PX, PhoneFrame } from '../primitives/PhoneFrame';
import { Reveal } from '../primitives/Reveal';

/** 6 点のアイコン (trust.items の順。§5.5) */
const TRUST_ICONS: readonly LucideIcon[] = [Check, ShieldCheck, Lock, Stethoscope, MonitorSmartphone, FileJson];

export function TrustSection() {
  const trust = LANDING_COPY.trust;
  return (
    <section id="trust" aria-labelledby="trust-title" tabIndex={-1} className="lp-section lp-trust-section">
      <div className="lp-container">
        <div className="lp-trust-head">
          <Reveal index={0} className="lp-section-head">
            <h2 id="trust-title">{trust.title}</h2>
            <p className="lp-lead">{trust.lead}</p>
          </Reveal>
        </div>
        <ul className="lp-trust">
          {trust.items.map((item, index) => {
            const Icon = TRUST_ICONS[index] ?? Check;
            return (
              <Reveal key={item.title} as="li" index={index} className="lp-trust-item">
                <span className="lp-icon lp-trust-icon" aria-hidden="true">
                  <Icon />
                </span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                {item.link ? (
                  <Link href={item.link.href} className="lp-text-link">
                    {item.link.label}
                  </Link>
                ) : null}
              </Reveal>
            );
          })}
        </ul>
        <div className="lp-trust-screen">
          <Reveal index={0} className="lp-shots lp-shots--single">
            <div className="lp-shot">
              <PhoneFrame className="lp-shot-phone">
                <Image
                  src={trust.screen.image.src}
                  alt={trust.screen.image.alt}
                  width={GUIDE_SCREEN_WIDTH_PX}
                  height={GUIDE_SCREEN_HEIGHT_PX}
                  sizes={LANDING_IMAGE_SIZES.chapter}
                />
              </PhoneFrame>
              <p className="lp-shot-label">{trust.screen.label}</p>
            </div>
          </Reveal>
          <p className="lp-caption">{trust.screensCaption}</p>
        </div>
      </div>
    </section>
  );
}
