/**
 * 公開ページ (未ログインでも読める、検索に載せるページ) のメタ情報と sitemap の正本 (#1867)。
 *
 * 以前はルートの layout (src/app/layout.tsx) の `alternates.canonical: '/'` と `openGraph.url` (サイトのトップ) が
 * 全ページに引き継がれ、どのページも canonical が「/」になっていた (検索エンジンに「全ページがトップの重複」と伝わる)。
 * 公開ページには、ページごとの title・description も無かった。
 *
 * いまは:
 *   - ルートの layout は canonical と og:url を書かない (引き継がせない)。
 *   - 公開ページは、このファイルの publicPageMetadata(パス) で、自分のパスの canonical・og:url・title・description を持つ。
 *   - URL は相対パスで書き、Next がルートの layout の metadataBase (= getSiteUrl() = NEXT_PUBLIC_APP_URL) を前に付ける。
 *     ドメインを切り替える (NEXT_PUBLIC_APP_URL を変える) と、canonical・og:url・sitemap が自動で新しいドメインを指す。
 *   - src/app/sitemap.ts は PUBLIC_PAGE_PATHS を全部並べる。
 *
 * 公開ページを足すときは、PUBLIC_PAGE_PATHS と PUBLIC_PAGE_SEO に足し、ページ (または layout) で publicPageMetadata を使う。
 * lib/supabase/middleware.ts の publicPaths に足したパスは、ここに載せるか、APP_ENTRY_PUBLIC_PATHS (アプリの入口で、
 * 検索に載せないページ) に載せる。どちらにも無いと tests/seo-public-pages-1867.test.ts が赤になる。
 *
 * このファイルは next/og などサーバー専用のものを読み込まない (画像の URL・大きさは src/lib/brand-asset-paths.ts から読む)。
 */
import type { Metadata } from 'next';
import {
  OG_IMAGE_ALT,
  OG_IMAGE_CONTENT_TYPE,
  OG_IMAGE_PATH,
  OG_IMAGE_SIZE,
  TWITTER_IMAGE_PATH,
} from '@/lib/brand-asset-paths';
import { BUSINESS_NAME } from '@/lib/business-info';
import { SITE_NAME, SITE_TAGLINE } from '@/lib/site-config';

/** トップの title (ルートの layout の title.default と同じ。tests/og-image-1845.test.tsx が layout 側を固定する) */
export const SITE_DEFAULT_TITLE = `${SITE_NAME} | ${SITE_TAGLINE}`;

/** サイト全体の説明 (トップの description。ルートの layout の description と openGraph.description も同じ文) */
export const SITE_DESCRIPTION =
  '写真を撮るだけでAIが栄養分析。毎日の食事記録から献立提案、健康管理まで。あなたの食生活をサポートする次世代の食事管理アプリ。';

/** Twitter Card のトップの説明 (以前のルートの layout の twitter.description と同じ文) */
export const SITE_TWITTER_DESCRIPTION = '写真を撮るだけでAIが栄養分析。毎日の食事記録から献立提案、健康管理まで。';

/** OGP の言語・地域 (ルートの layout の openGraph.locale と同じ) */
export const OG_LOCALE = 'ja_JP';

/**
 * 公開ページのパス (sitemap に載せる順)。lib/supabase/middleware.ts の publicPaths の下にある (未ログインでも開ける) ことを
 * tests/seo-public-pages-1867.test.ts が確かめる。
 */
export const PUBLIC_PAGE_PATHS = [
  '/',
  '/about',
  '/pricing',
  '/guide',
  '/faq',
  '/news',
  '/company',
  '/contact',
  '/legal',
  '/legal/parental-consent',
  '/terms',
  '/privacy',
] as const;

export type PublicPagePath = (typeof PUBLIC_PAGE_PATHS)[number];

/**
 * lib/supabase/middleware.ts の publicPaths のうち、公開ページ (PUBLIC_PAGE_PATHS) ではなく、アプリの入口のパス。
 * 未ログインでも開けるが、検索に載せる中身ではない (ログイン・登録・認証の途中・招待のトークン・家族の同意のトークン)。
 * sitemap に入れず、ページごとの canonical も付けない (ルートの layout の canonical の引き継ぎをやめたので「/」も指さない)。
 */
export const APP_ENTRY_PUBLIC_PATHS = [
  '/login',
  '/signup',
  '/auth',
  '/onboarding/welcome',
  '/invite',
  '/family/promotions',
] as const;

/** 公開ページ 1 枚のメタ情報 */
interface PublicPageSeo {
  /**
   * ページの名前。publicPageFullTitle が後ろにサービス名を付ける (ルートの layout の title.template と同じ形)。
   * null はトップ (SITE_DEFAULT_TITLE をそのまま出す)。
   */
  title: string | null;
  /** 検索結果・SNS のカードに出る説明 (ページの中身の要約。ページの文言そのものは変えない) */
  description: string;
}

/** 公開ページごとのメタ情報。title はページの見出し (h1) と同じ語 */
export const PUBLIC_PAGE_SEO: Readonly<Record<PublicPagePath, PublicPageSeo>> = {
  '/': { title: null, description: SITE_DESCRIPTION },
  '/about': {
    title: 'ほめゴハンについて',
    description: `${SITE_NAME}は、食事の写真からAIが栄養を分析し、良いところを褒めてくれる食事管理アプリです。主な機能と考え方を紹介します。`,
  },
  '/pricing': {
    title: '料金プラン',
    description: `${SITE_NAME}の料金プランのご案内です。`,
  },
  '/guide': {
    title: '使い方ガイド',
    description: `${SITE_NAME}の始め方と、写真での食事の記録・献立の提案・体重の記録などの使い方を、手順ごとに説明します。`,
  },
  '/faq': {
    title: 'よくある質問',
    description: `${SITE_NAME}について、よくある質問とその答えをまとめています。`,
  },
  '/news': {
    title: 'お知らせ',
    description: `${SITE_NAME}の新機能・メンテナンスなどのお知らせです。`,
  },
  '/company': {
    title: '運営会社',
    description: `${SITE_NAME}を運営する${BUSINESS_NAME}の紹介です。`,
  },
  '/contact': {
    title: 'お問い合わせ',
    description: `${SITE_NAME}へのご質問・不具合のご報告・ご要望を受け付けています。`,
  },
  '/legal': {
    title: '特定商取引法に基づく表記',
    description: `${SITE_NAME}の特定商取引法に基づく表記です。`,
  },
  '/legal/parental-consent': {
    title: '保護者の同意書',
    description: `${SITE_NAME}で18歳未満のお子さまの情報を取り扱うときの、保護者の同意書の全文です。`,
  },
  '/terms': {
    title: '利用規約',
    description: `${SITE_NAME}の利用規約です。`,
  },
  '/privacy': {
    title: 'プライバシーポリシー',
    description: `${SITE_NAME}のプライバシーポリシー (個人情報の取り扱い) です。`,
  },
};

/**
 * ページの title がブラウザ・検索結果に出る形 (ルートの layout の title.template と同じ組み立て)。
 * メタ情報には title.absolute で渡す。Next の title.template は「いちばん近い親の segment の template」だけを使い、
 * 親の layout が文字列の title (例: /legal の layout) を持つと、その配下のページ (/legal/parental-consent) には
 * サービス名が付かなくなるため (本番ビルドで確かめた)。
 */
export function publicPageFullTitle(pagePath: PublicPagePath): string {
  const { title } = PUBLIC_PAGE_SEO[pagePath];
  return title === null ? SITE_DEFAULT_TITLE : `${title} | ${SITE_NAME}`;
}

/**
 * 公開ページのメタ情報 (title・description・canonical・OGP・Twitter Card)。
 * canonical と og:url は相対パス。Next がルートの layout の metadataBase (NEXT_PUBLIC_APP_URL) を前に付けて絶対 URL にする。
 *
 * openGraph / twitter は、子の layout / page で書くと親の値と丸ごと置き換わる (Next はキーごとにまとめない)。
 * そのため、ルートの layout の openGraph (siteName・locale・type) と twitter (card) の値もここで書き直し、
 * file convention の画像 (opengraph-image / twitter-image) は、子で openGraph を書くと消えるので URL を明示する。
 */
export function publicPageMetadata(pagePath: PublicPagePath): Metadata {
  const { title, description } = PUBLIC_PAGE_SEO[pagePath];
  const fullTitle = publicPageFullTitle(pagePath);
  const isTop = title === null;
  const imageDescriptor = {
    width: OG_IMAGE_SIZE.width,
    height: OG_IMAGE_SIZE.height,
    alt: OG_IMAGE_ALT,
    type: OG_IMAGE_CONTENT_TYPE,
  };
  return {
    title: { absolute: fullTitle },
    description,
    alternates: { canonical: pagePath },
    openGraph: {
      title: fullTitle,
      description,
      url: pagePath,
      siteName: SITE_NAME,
      locale: OG_LOCALE,
      type: 'website',
      images: [{ url: OG_IMAGE_PATH, ...imageDescriptor }],
    },
    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description: isTop ? SITE_TWITTER_DESCRIPTION : description,
      images: [{ url: TWITTER_IMAGE_PATH, ...imageDescriptor }],
    },
  };
}
