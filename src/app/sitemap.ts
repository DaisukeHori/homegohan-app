import type { MetadataRoute } from 'next';
import { PUBLIC_PAGE_PATHS } from '@/lib/seo/public-pages';
import { getSiteUrl } from '@/lib/site-config';

// /sitemap.xml (#1867)。公開ページ (src/lib/seo/public-pages.ts の PUBLIC_PAGE_PATHS) を全部並べる。
// URL はサイトの URL (NEXT_PUBLIC_APP_URL。src/lib/site-config.ts) から作る (ドメインを直接書かない。src/app/robots.ts と同じ)。
// 未ログインのクローラーが開けるよう、src/proxy.ts の matcher で /sitemap.xml を外している (外さないと /login へ送られる)。
// lastModified・changeFrequency・priority は書かない (ページごとの正しい更新日を持っていない。Google は changefreq と
// priority を使わず、lastmod は正確な場合だけ使う)。ログインが要るページ・アプリの入口 (/login など) は入れない。
export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getSiteUrl();
  return PUBLIC_PAGE_PATHS.map((pagePath) => ({ url: `${siteUrl}${pagePath}` }));
}
