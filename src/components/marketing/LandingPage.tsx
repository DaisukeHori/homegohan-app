// 紹介ページ (/) の本体 (docs/design/marketing/01-landing-site.md §3.1・§8.3 の LandingPage)。Server Component。
// 根は .lp の div 1 つ。ヘッダー → main (区切り 18) → フッター。データ取得・headers()・cookies() を呼ばない。
// 区切りは SECTION_IDS の順 (hero how demo features photo menu nutrition health badges chat scenes family org trust pricing guide faq cta)。
// 区切りの section は 18 とも tabIndex={-1} を持つ (ページの中のリンクの先にフォーカスを移すため: §2.2。各区切りの部品が描く)。
// 文言の正本は landing-copy.ts。文章と画像はすべて Server の HTML に出る (client の島は SiteHeader・DemoSection・Reveal・StoryScroller・
// ScoreRing・ReadingProgress の 6 つだけ)。main のランドマークは本部品が持つ (layout の #main-content は div)。
// 構造化データ (JSON-LD) は殻 src/app/page.tsx の SiteStructuredData が出す。各区切りは直接 import する (next/dynamic にしない)。
import './marketing.css';
import { BadgesChapter } from './sections/BadgesChapter';
import { ChatChapter } from './sections/ChatChapter';
import { DemoSection } from './sections/DemoSection';
import { FamilySection } from './sections/FamilySection';
import { FaqSection } from './sections/FaqSection';
import { FeaturesSection } from './sections/FeaturesSection';
import { FinalCtaSection } from './sections/FinalCtaSection';
import { GuideSection } from './sections/GuideSection';
import { HealthChapter } from './sections/HealthChapter';
import { HeroSection } from './sections/HeroSection';
import { MenuChapter } from './sections/MenuChapter';
import { NutritionChapter } from './sections/NutritionChapter';
import { OrgSection } from './sections/OrgSection';
import { PhotoChapter } from './sections/PhotoChapter';
import { PricingSection } from './sections/PricingSection';
import { ScenesSection } from './sections/ScenesSection';
import { SiteFooter } from './sections/SiteFooter';
import { SiteHeader } from './sections/SiteHeader';
import { StorySection } from './sections/StorySection';
import { TrustSection } from './sections/TrustSection';

export function LandingPage() {
  return (
    <div className="lp">
      <SiteHeader />
      <main>
        <HeroSection />
        <StorySection />
        <DemoSection />
        <FeaturesSection />
        <PhotoChapter />
        <MenuChapter />
        <NutritionChapter />
        <HealthChapter />
        <BadgesChapter />
        <ChatChapter />
        <ScenesSection />
        <FamilySection />
        <OrgSection />
        <TrustSection />
        <PricingSection />
        <GuideSection />
        <FaqSection />
        <FinalCtaSection />
      </main>
      <SiteFooter />
    </div>
  );
}
