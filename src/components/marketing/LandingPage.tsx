// 紹介ページ (/) の本体 (docs/design/marketing/01-landing-site.md §8.3 の LandingPage)。Server Component。
// 根は .lp の div 1 つ。ヘッダー → main (セクション 8 つ) → フッター。データ取得・headers()・cookies() を呼ばない。
// 文言の正本は landing-copy.ts。文章と画像はすべて Server の HTML に出る (client の島は SiteHeader・DemoSection・FaqSection・Reveal の 4 つだけ)。
// main のランドマークは本部品が持つ (layout の #main-content は div)。構造化データ (JSON-LD) は殻 src/app/page.tsx の SiteStructuredData が出す。
import './marketing.css';
import { BadgesSection } from './sections/BadgesSection';
import { DemoSection } from './sections/DemoSection';
import { FaqSection } from './sections/FaqSection';
import { FeaturesSection } from './sections/FeaturesSection';
import { FinalCtaSection } from './sections/FinalCtaSection';
import { HeroSection } from './sections/HeroSection';
import { HowItWorksSection } from './sections/HowItWorksSection';
import { SiteFooter } from './sections/SiteFooter';
import { SiteHeader } from './sections/SiteHeader';
import { TrustSection } from './sections/TrustSection';

export function LandingPage() {
  return (
    <div className="lp">
      <SiteHeader />
      <main>
        <HeroSection />
        <HowItWorksSection />
        <DemoSection />
        <FeaturesSection />
        <BadgesSection />
        <TrustSection />
        <FaqSection />
        <FinalCtaSection />
      </main>
      <SiteFooter />
    </div>
  );
}
