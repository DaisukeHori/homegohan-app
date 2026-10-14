import type { MetadataRoute } from 'next';
import { getSiteUrl } from '@/lib/site-config';

// /robots.txt。以前は public/robots.txt に Sitemap の URL (ドメイン) を直書きしていて、サイトの URL を変えても
// 古いまま残るため、サイトの URL (NEXT_PUBLIC_APP_URL。src/lib/site-config.ts) から作る (#1194)。
// public/robots.txt を残すと Next.js のビルドが「同じパスの public ファイルとルートが衝突」で失敗するため置かない。
// 内容 (全クローラーに許可・/api/ と /admin/ は禁止・サイトマップの場所) は以前の robots.txt と同じ。
// 注: /sitemap.xml はまだ無い (従来の robots.txt も指していた)。作るときは src/app/sitemap.ts を足す。
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/admin/'],
    },
    sitemap: `${getSiteUrl()}/sitemap.xml`,
  };
}
