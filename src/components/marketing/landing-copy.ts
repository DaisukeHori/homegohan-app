// src/components/marketing/landing-copy.ts
// 紹介ページ (/) の文言・画像・公開の主張・デモの見本・動きの定数の正本。ここだけを直せば、月に数回の更新が済む。
// claims は docs/design/marketing/01-landing-site.md §4.1 の公開の主張の表と同じ行 (id・文・根拠のパス・条件) を持つ。
// 根拠のパスの実在とデモの見本の式は tests/landing-page-1867.test.ts が、載せてはいけない語は tests/public-claims-guard.test.ts が見る。
// 絵文字は書かない (アイコンは各部品が lucide-react から import する)。ドメイン (homegohan.*) は書かない (tests/site-config-guard.test.ts)。
// 新しい画面と拡大の画像 (/marketing/screens/*.png) の名前と alt は landing-screens.ts (LANDING_SCREENS・LANDING_ZOOMS) が正本で、ここに書くパスと alt はその一覧と一致する (U-4)。拡大の画像の大きさは landing-screens.ts だけが持つ。
import { z } from 'zod';
import { PAID_PLAN_SUMMARY, PLAN_CATALOG, formatJpy } from '@homegohan/shared';
import { SITE_NAME } from '@/lib/site-config';

/** ページが指す public/ の画像 (ガイドの画面写真・紹介ページの写真・紹介ページの新しい画面写真)。実在は U-4 が見る */
export const LANDING_IMAGE_PATH_PATTERN = /^\/(?:guide\/[a-z-]+\.png|marketing\/(?:photos\/[a-z-]+\.webp|screens\/[a-z-]+\.png))$/;
/** 主張の根拠に書けるパス (リポジトリの根からの相対。ディレクトリは末尾 /)。.. を含まない */
export const EVIDENCE_PATH_PATTERN = /^(?:src|tests|supabase|packages|apps|docs)\/[^\s]+$/;

/** サイトの中のリンク先 (先頭が / か #)。外部の URL は紹介ページに置かない */
const InternalHrefSchema = z.string().regex(/^(?:\/[a-z0-9\-/]*|#[a-z0-9-]+)$/);
const ImagePathSchema = z.string().regex(LANDING_IMAGE_PATH_PATTERN);
const EvidencePathSchema = z.string().regex(EVIDENCE_PATH_PATTERN);

export const LandingImageSchema = z.object({ src: ImagePathSchema, alt: z.string().min(1) });
export const LandingLinkSchema = z.object({ label: z.string().min(1), href: InternalHrefSchema });

/** 公開の主張の id (§4.1 の表の 46 行と同じ順。先頭の 17 件は v1.7 と同じ) */
export const CLAIM_IDS = [
  'photo-analyze',
  'praise',
  'nutrition-tip',
  'demo-sample',
  'weekly-menu',
  'shopping-list',
  'health-records',
  'badges',
  'fridge',
  'family',
  'free-now',
  'ai-daily-limit',
  'ai-consent',
  'no-card',
  'delete-export',
  'ai-estimate',
  'privacy',
  'photo-entrances',
  'nutrition-five',
  'photo-modes',
  'menu-conditions',
  'menu-edit',
  'menu-stats',
  'favorites',
  'today-score',
  'weekly-stats',
  'health-items',
  'health-graphs',
  'blood-tests',
  'health-goals',
  'badge-ranks',
  'pantry-manage',
  'ai-chat',
  'ai-features',
  'family-roles',
  'family-share',
  'family-menu-view',
  'org-admin',
  'org-challenge-privacy',
  'signup-methods',
  'onboarding',
  'guide-exists',
  'sessions',
  'data-requests',
  'photo-storage',
  'ai-stop',
] as const;

/** 公開の主張。text は主張の文、evidence は根拠のパス (1 つ以上)、condition は主張が成り立つ条件 (無ければ null) */
export const LandingClaimSchema = z.object({
  id: z.enum(CLAIM_IDS),
  text: z.string().min(1),
  evidence: z.array(EvidencePathSchema).min(1),
  condition: z.string().min(1).nullable(),
});

/** main の中の区切りの id (§3.1 の順。U-14・E-1 が順を見る) */
export const SECTION_IDS = [
  'hero',
  'how',
  'demo',
  'features',
  'photo',
  'menu',
  'nutrition',
  'health',
  'badges',
  'chat',
  'scenes',
  'family',
  'org',
  'trust',
  'pricing',
  'guide',
  'faq',
  'cta',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/** ヘッダーのナビの項目 (5 つ) と、各区切りがどの項目に属するか (M-14。U-33) */
export const NAV_KEYS = ['how', 'features', 'family', 'pricing', 'faq'] as const;
export type NavKey = (typeof NAV_KEYS)[number];
export const SECTION_NAV_KEY: Record<SectionId, NavKey> = {
  hero: 'how',
  how: 'how',
  demo: 'features',
  features: 'features',
  photo: 'features',
  menu: 'features',
  nutrition: 'features',
  health: 'features',
  badges: 'features',
  chat: 'features',
  scenes: 'family',
  family: 'family',
  org: 'family',
  trust: 'pricing',
  pricing: 'pricing',
  guide: 'pricing',
  faq: 'faq',
  cta: 'faq',
};

/** ページの中のリンクの href の頭 (同じページの区切りへ移るリンクは '#<区切りの id>') */
const IN_PAGE_HREF_PREFIX = '#';

/** ページの中のリンクの href から、移る先の区切りの id を返す。区切りでなければ null (useInPageLinkFocus がフォーカスを移す先。§2.2) */
export function inPageSectionId(href: string): SectionId | null {
  if (!href.startsWith(IN_PAGE_HREF_PREFIX)) return null;
  const id = href.slice(IN_PAGE_HREF_PREFIX.length);
  return SECTION_IDS.find((sectionId) => sectionId === id) ?? null;
}

// ─── デモの記録コメント (アプリの定型の文と同じ形。§4.5。v1.7 と同じ) ───
export const DEMO_PRAISE_DISH_SUFFIX = 'の記録';
export const DEMO_PRAISE_RECORD_PHRASE = 'がしっかりできていて素晴らしいです。';
export const DEMO_PRAISE_MEAL_PHRASE = 'を丁寧に残せていて、とても良い流れです';
/** 記録コメントの文の終わり。アプリは絵文字で終わるが、紹介ページは絵文字を使わない (U-9) ので句点にする */
export const DEMO_PRAISE_END = '。';
/** 記録コメントに入れる料理の名前の数の上限 (アプリの slice(0, 2) と同じ) */
export const DEMO_PRAISE_MAX_DISHES = 2;
/** 料理の名前をつなぐ文字 (アプリの join('、') と同じ) */
export const DEMO_PRAISE_DISH_SEPARATOR = '、';
/** 食事の区分の語。アプリの toMealTypeLabel が返す語のうち、デモで使うもの */
export const DEMO_MEAL_TYPE_LABELS = ['朝食', '昼食', '夕食'] as const;

// ─── デモのスコア (アプリの overallScore と同じ式。§4.5。v1.7 と同じ) ───
export const DEMO_SCORE_BASE = 70;
export const DEMO_SCORE_MIN = 70;
export const DEMO_SCORE_MAX = 95;
export const DEMO_SCORE_PROTEIN_DIVISOR = 3;
export const DEMO_SCORE_PROTEIN_CAP = 10;
export const DEMO_SCORE_FIBER_FACTOR = 1.6;
export const DEMO_SCORE_FIBER_CAP = 8;
export const DEMO_SCORE_KCAL_RANGE_MIN = 250;
export const DEMO_SCORE_KCAL_RANGE_MAX = 900;
export const DEMO_SCORE_KCAL_IN_RANGE = 5;
export const DEMO_SCORE_KCAL_OUT_OF_RANGE = 2;

/** デモの写真の名前の最大の字数 (320 px の帯の中で 1 行に入る長さ。v1.7 §8.3) */
export const DEMO_PHOTO_NAME_MAX_CHARS = 4;
/** 章の画面の札と拡大の札の最大の字数 (1〜2 枚の端末と拡大の箱の下で 14 px の字が 1 行に入る長さ。3〜5 枚の格子の札は §4.0 のとおり 8 字以内で、E-22 が 1024 px で確かめる) */
export const CHAPTER_SCREEN_LABEL_MAX_CHARS = 10;

/** 横にスクロールする帯 (§5.4) にする画面の塊の最小の枚数 (1 枚の塊は帯にしない) */
export const SCREEN_STRIP_MIN_SCREENS = 2;
/** 場面のカードの帯の aria-label (§5.4) */
export const SCENES_STRIP_LABEL = '使い方の場面';
/** 画面の帯の aria-label の末尾。章とガイドの eyebrow に付ける (§5.4) */
export const SCREEN_STRIP_LABEL_SUFFIX = 'の画面';

/** 画面の帯の aria-label (例: '写真で記録' → '写真で記録の画面')。ChapterSection と GuideSection が使う (§5.4) */
export function screenStripLabel(eyebrow: string): string {
  return `${eyebrow}${SCREEN_STRIP_LABEL_SUFFIX}`;
}

export const DemoNutritionSchema = z.object({
  kcal: z.number().int().min(0),
  proteinG: z.number().int().min(0),
  carbsG: z.number().int().min(0),
  fatG: z.number().int().min(0),
  fiberG: z.number().int().min(0),
});

export const DemoSampleSchema = z.object({
  id: z.enum(['salad-bowl', 'salmon-plate', 'pesto-pasta']),
  name: z.string().min(1).max(DEMO_PHOTO_NAME_MAX_CHARS),
  photo: LandingImageSchema,
  dishNames: z.array(z.string().min(1)).min(1).max(DEMO_PRAISE_MAX_DISHES),
  mealTypeLabel: z.enum(DEMO_MEAL_TYPE_LABELS),
  nutrition: DemoNutritionSchema,
});

const NutritionTextSchema = z.object({
  kcal: z.string().min(1),
  proteinG: z.string().min(1),
  carbsG: z.string().min(1),
  fatG: z.string().min(1),
  fiberG: z.string().min(1),
});

/** 機能の一覧のカード。href はページの中の先 (各章の id) */
export const FeatureCardSchema = z.object({
  id: z.enum(['photo', 'praise', 'menu', 'shopping', 'pantry', 'nutrition', 'health', 'badges', 'chat', 'family']),
  size: z.enum(['large', 'medium', 'small']),
  title: z.string().min(1),
  body: z.string().min(1),
  image: LandingImageSchema.nullable(),
  claimId: z.enum(CLAIM_IDS),
  href: InternalHrefSchema,
});

/** badges テーブルの行と同じ code / name。description は付与の条件を短く言う紹介ページの文 (DB の説明 (migration 20261018040000 で付与の条件に合わせた文) と同じでなくてよい)。photo_10 (名前が付与の条件と食い違う) と planner (章の列を 4 枚に保つ) は載せない (§4.11・Q-13) */
export const BadgeCardSchema = z.object({
  code: z.enum(['first_bite', 'streak_3', 'streak_7', 'tutorial_complete']),
  name: z.string().min(1),
  description: z.string().min(1),
});

/** 要点 (章・家族・組織・料金の上限・ガイド)。claimIds は §4 の各表の「主張」の列 */
export const PointSchema = z.object({ title: z.string().min(1), body: z.string().min(1), claimIds: z.array(z.enum(CLAIM_IDS)).min(1) });
/** 章の画面 (端末の枠に入れる実際の画面と、その下の札) */
export const ChapterScreenSchema = z.object({ image: LandingImageSchema, label: z.string().min(1).max(CHAPTER_SCREEN_LABEL_MAX_CHARS) });
/**
 * 章の拡大 (§5.4 の「拡大」・M-17): 撮影の台本が、章の画面と同じ撮影の回の同じ画面から切り出した画像 (landing-screens.ts の LANDING_ZOOMS) を、
 * 端末の枠の外の箱に大きく出す。src と alt が LANDING_ZOOMS と一致することは U-4、切り出す元がその章の画面にあることは U-36 が見る。
 * 画像の大きさ (箱の縦横比) は ScreenZoom が landingZoomBySrc で引く (ここには持たない)
 */
export const ChapterZoomSchema = z.object({
  image: LandingImageSchema,
  label: z.string().min(1).max(CHAPTER_SCREEN_LABEL_MAX_CHARS),
});

export const CHAPTER_IDS = ['photo', 'menu', 'nutrition', 'health', 'badges', 'chat'] as const;
export type ChapterId = (typeof CHAPTER_IDS)[number];
/** 章の地 (§5.1 の区切りごとの地) */
export type ChapterTone = 'bg' | 'tint' | 'green' | 'blue' | 'dark';
export const CHAPTER_TONE: Record<ChapterId, ChapterTone> = { photo: 'bg', menu: 'tint', nutrition: 'green', health: 'blue', badges: 'tint', chat: 'dark' };

export const ChapterSchema = z.object({
  id: z.enum(CHAPTER_IDS),
  eyebrow: z.string().min(1),
  title: z.string().min(1),
  lead: z.string().min(1),
  points: z.array(PointSchema).min(2).max(5),
  screens: z.array(ChapterScreenSchema).min(1).max(5),
  /** 画面の一部の拡大 (§5.4)。置かない章は null */
  zoom: ChapterZoomSchema.nullable(),
  screensCaption: z.string().min(1),
  cta: LandingLinkSchema,
});

export const FaqItemSchema = z.object({ q: z.string().min(1), a: z.string().min(1) });
export const TrustItemSchema = z.object({ title: z.string().min(1), body: z.string().min(1), link: LandingLinkSchema.nullable() });
export const StepSchema = z.object({ title: z.string().min(1), body: z.string().min(1), image: LandingImageSchema });
export const SceneSchema = z.object({
  id: z.enum(['solo', 'family', 'health', 'team']),
  title: z.string().min(1),
  body: z.string().min(1),
  claimIds: z.array(z.enum(CLAIM_IDS)).min(1),
});
export const FLOW_NODE_IDS = ['photo', 'analyze', 'record', 'menu', 'shopping'] as const;
export type FlowNodeId = (typeof FLOW_NODE_IDS)[number];
export const FlowNodeSchema = z.object({ id: z.enum(FLOW_NODE_IDS), label: z.string().min(1) });
/** 家族の共有の範囲の図の 1 項目 (§5.7)。state は切り替えの形 */
export const ShareFigureItemSchema = z.object({ label: z.string().min(1), state: z.enum(['on', 'off', 'choose']), note: z.string().min(1) });
export const PlanCardSchema = z.object({
  id: z.enum(['free', 'paid']),
  title: z.string().min(1),
  badge: z.string().min(1),
  items: z.array(z.string().min(1)),
  body: z.string().min(1).nullable(),
  cta: LandingLinkSchema.nullable(),
});
export const GuideChapterSchema = z.object({ title: z.string().min(1), stepCount: z.number().int().positive() });

export const LandingCopySchema = z.object({
  header: z.object({ nav: z.array(LandingLinkSchema.extend({ key: z.enum(NAV_KEYS) })).length(5), login: LandingLinkSchema, cta: LandingLinkSchema }),
  hero: z.object({
    eyebrow: z.string().min(1),
    headlineLines: z.array(z.string().min(1)).length(2),
    lead: z.string().min(1),
    primaryCta: LandingLinkSchema,
    secondaryCta: LandingLinkSchema,
    assurances: z.array(z.string().min(1)).length(3),
    /** 扇に重ねる実際の画面 5 枚。順は HTML の順 (読み上げの順): 左の後ろ・右の後ろ・前の中央・遠くの左・遠くの右 */
    screens: z.array(LandingImageSchema).length(5),
    screensCaption: z.string().min(1),
    scrollCue: z.string().min(1),
  }),
  story: z.object({
    eyebrow: z.string().min(1),
    title: z.string().min(1),
    lead: z.string().min(1),
    steps: z.array(StepSchema).length(4),
    flow: z.object({ nodes: z.array(FlowNodeSchema).length(5), note: z.string().min(1) }),
    screensCaption: z.string().min(1),
  }),
  demo: z.object({
    eyebrow: z.string().min(1),
    title: z.string().min(1),
    lead: z.string().min(1),
    pickerTitle: z.string().min(1),
    analyzingTitle: z.string().min(1),
    analyzingBody: z.string().min(1),
    scoreNote: z.string().min(1),
    resultTitle: z.string().min(1),
    nutritionTitle: z.string().min(1),
    nutritionLabels: NutritionTextSchema,
    nutritionUnits: NutritionTextSchema,
    sampleNotice: z.string().min(1),
    emptyBody: z.string().min(1),
    cta: LandingLinkSchema,
    samples: z.array(DemoSampleSchema).length(3),
  }),
  features: z.object({ title: z.string().min(1), lead: z.string().min(1), cards: z.array(FeatureCardSchema).length(10), screensCaption: z.string().min(1) }),
  chapters: z.object({
    photo: ChapterSchema,
    menu: ChapterSchema,
    nutrition: ChapterSchema.extend({
      /** スコアの輪 (M-11)。value は撮影の見本 GUIDE_MEAL_ANALYSIS.overallScore と同じ (U-28) */
      ring: z.object({ label: z.string().min(1), value: z.number().int().min(0).max(100), note: z.string().min(1) }),
    }),
    health: ChapterSchema.extend({ disclaimer: z.string().min(1) }),
    badges: ChapterSchema.extend({ items: z.array(BadgeCardSchema).length(4) }),
    chat: ChapterSchema,
  }),
  scenes: z.object({ title: z.string().min(1), lead: z.string().min(1), items: z.array(SceneSchema).length(4) }),
  family: z.object({
    eyebrow: z.string().min(1),
    title: z.string().min(1),
    lead: z.string().min(1),
    points: z.array(PointSchema).length(4),
    shareFigure: z.array(ShareFigureItemSchema).length(3),
    screen: ChapterScreenSchema,
    screensCaption: z.string().min(1),
    cta: LandingLinkSchema,
  }),
  org: z.object({
    eyebrow: z.string().min(1),
    title: z.string().min(1),
    lead: z.string().min(1),
    points: z.array(PointSchema).length(4),
    /** 組織の形の図 (§5.7): 管理者の札と、管理者が管理する 3 つの札 (メンバー・部署・チャレンジ。部署の下にメンバーを置く階層は描かない) */
    figure: z.object({ admin: z.string().min(1), managed: z.array(z.string().min(1)).length(3) }),
    cta: LandingLinkSchema,
  }),
  trust: z.object({ title: z.string().min(1), lead: z.string().min(1), items: z.array(TrustItemSchema).length(6), screen: ChapterScreenSchema, screensCaption: z.string().min(1) }),
  pricing: z.object({
    eyebrow: z.string().min(1),
    title: z.string().min(1),
    lead: z.string().min(1),
    plans: z.array(PlanCardSchema).length(2),
    limits: z.array(PointSchema).length(3),
  }),
  guide: z.object({
    eyebrow: z.string().min(1),
    title: z.string().min(1),
    lead: z.string().min(1),
    chapters: z.array(GuideChapterSchema).length(5),
    points: z.array(PointSchema).length(3),
    screens: z.array(ChapterScreenSchema).length(2),
    screensCaption: z.string().min(1),
    cta: LandingLinkSchema,
  }),
  faq: z.object({ title: z.string().min(1), lead: z.string().min(1), items: z.array(FaqItemSchema).length(12), contactLead: z.string().min(1), contact: LandingLinkSchema }),
  finalCta: z.object({ title: z.string().min(1), lead: z.string().min(1), cta: LandingLinkSchema, assurances: z.array(z.string().min(1)).length(3), disclaimer: z.string().min(1) }),
  footer: z.object({
    tagline: z.string().min(1),
    columns: z.array(z.object({ title: z.string().min(1), links: z.array(LandingLinkSchema).min(1) })).length(3),
    socialLinks: z.array(LandingLinkSchema),
    storeLinks: z.array(LandingLinkSchema),
    copyrightYear: z.number().int().min(2025),
  }),
  claims: z.array(LandingClaimSchema).length(CLAIM_IDS.length),
});

export type LandingCopy = z.infer<typeof LandingCopySchema>;
export type LandingClaim = z.infer<typeof LandingClaimSchema>;
export type ClaimId = (typeof CLAIM_IDS)[number];
export type DemoSample = z.infer<typeof DemoSampleSchema>;
export type DemoSampleId = DemoSample['id'];
export type DemoNutrition = z.infer<typeof DemoNutritionSchema>;
export type DemoNutritionKey = keyof DemoNutrition;
export type FeatureCard = z.infer<typeof FeatureCardSchema>;
export type FeatureCardId = FeatureCard['id'];
export type BadgeCard = z.infer<typeof BadgeCardSchema>;
export type Chapter = z.infer<typeof ChapterSchema>;
export type ChapterScreen = z.infer<typeof ChapterScreenSchema>;
export type ChapterZoom = z.infer<typeof ChapterZoomSchema>;
export type Point = z.infer<typeof PointSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type FlowNode = z.infer<typeof FlowNodeSchema>;

/** デモの栄養の表示の順 (v1.7 と同じ) */
export const DEMO_NUTRITION_KEYS: readonly DemoNutritionKey[] = ['kcal', 'proteinG', 'carbsG', 'fatG', 'fiberG'];

// ─── 動き・レイアウト・画像の定数 (根拠は docs/design/marketing/01-landing-site.md §5・§6) ───
/** デモの「分析中」の長さ (ms。M-7) */
export const DEMO_ANALYZING_MS = 1400;
/** 動きを減らす設定のときのデモの待ち時間 (ms) */
export const DEMO_ANALYZING_MS_REDUCED = 0;
/** デモの結果のスコアの数字が 0 から増えて止まるまで (ms。M-7) */
export const COUNT_UP_MS = 600;
/** スコアの輪の描かれ方と数字の増え方 (ms。M-11。marketing.css の --lp-dur-slow と同じ) */
export const RING_DRAW_MS = 800;
/** スコアの輪の目盛りの上限 (スコアは 0〜100 の点) */
export const RING_MAX = 100;
/** 拡大の箱が縮んだ形から元の大きさになるまで (ms。M-17。marketing.css の --lp-dur-slow と同じ) */
export const ZOOM_DRAW_MS = 800;
/** 拡大の箱の動きの始まりの縮み (M-17。marketing.css の --lp-zoom-from と同じ。元の大きさの 85 % から大きくなる) */
export const ZOOM_FROM_SCALE = 0.85;
/** ヘッダーに背景を付けるスクロール量 (px。M-1) */
export const HEADER_SCROLLED_PX = 24;
/** 現れ方 (M-5): 要素のどこか 1 px でも、画面の下の 10 % を除いた範囲に入ったら */
export const REVEAL_ROOT_MARGIN = '0px 0px -10% 0px';
/** 現れ方の子の遅れ (ms。marketing.css の --lp-stagger と同じ) と、遅らせる最大の個数 */
export const REVEAL_STAGGER_MS = 40;
export const REVEAL_STAGGER_MAX = 6;
/** 物語 (M-6): 手順が画面の中央の帯 (上下 40 % を除いた 20 %) にあるとき、その手順の画面を出す */
export const STORY_BAND_ROOT_MARGIN = '-40% 0px -40% 0px';
/** ヘッダーのナビの強調 (M-14): 区切りが画面の上から 40 %〜45 % の帯にあるとき、その区切りを「いま読んでいる」とみなす */
export const NAV_CURRENT_ROOT_MARGIN = '-40% 0px -55% 0px';
/** デモの結果の出入りの時間 (秒) と緩急 (v1.7 と同じ) */
export const DEMO_MOTION_DURATION_S = 0.32;
export const DEMO_MOTION_EASE = [0.2, 0.8, 0.2, 1] as const;
export const DEMO_RESULT_OFFSET_PX = 8;
/** / の viewport の maximum-scale (v1.7 と同じ) */
export const LANDING_VIEWPORT_MAXIMUM_SCALE = 5;
/** next/image の sizes (§5.4 の表) */
export const LANDING_IMAGE_SIZES = {
  heroFront: '(max-width: 639px) 52vw, 270px',
  heroBack: '(max-width: 639px) 42vw, 212px',
  heroFar: '(max-width: 1023px) 26vw, 144px',
  story: '(max-width: 1023px) 60vw, 272px',
  feature: '(max-width: 767px) 50vw, 208px',
  chapter: '(max-width: 767px) 60vw, (max-width: 1023px) 30vw, 200px',
  demoPhoto: '(max-width: 767px) 30vw, 160px',
  /** 拡大の箱の中の画像: 箱 min(100%, 24rem) の幅いっぱい (最大 384 px)。画面の幅 479 px 以下では、箱が列の幅になり、画像は画面の幅より狭い */
  zoom: '(max-width: 479px) 100vw, 384px',
} as const;
/** 著作権表示の年 (日付の計算はしない) */
export const COPYRIGHT_YEAR = 2026;
export const SIGNUP_HREF = '/signup';
export const DEMO_ANCHOR = '#demo';

const ASSURANCES: [string, string, string] = ['無料で始められます', 'クレジットカード不要', 'いつでも退会できます'];
/** 実際の画面を出す区切りの注記 (§7.1) */
export const SCREENS_CAPTION = '実際のアプリの画面です。表示している記録と数値は、撮影用の見本です。';
const PRIMARY_CTA = { label: '無料で始める', href: SIGNUP_HREF };

const CAMERA = { src: '/guide/camera.png', alt: '食事の写真を選んだ撮影の画面' };
const ANALYZE = { src: '/guide/analyze.png', alt: '食事の写真の解析結果の画面' };
const COMMENT = { src: '/guide/comment.png', alt: '解析結果の記録コメント' };
const MENU_REQUEST = { src: '/guide/menu-request.png', alt: '献立表の画面の AI 献立アシスタントのボタン' };
const MENU_SETTING = { src: '/guide/menu-setting.png', alt: 'AI アシスタントで条件を選ぶ画面' };
const MENU_RESULT = { src: '/guide/menu-result.png', alt: '1 週間分の献立が入った献立表' };
const WEIGHT = { src: '/guide/weight.png', alt: '体重を入力する画面' };
const BADGE_GET = { src: '/guide/badge-get.png', alt: '新しいバッジを獲得したお知らせ' };
const BADGE_COLLECTION = { src: '/guide/badge-collection.png', alt: 'トロフィールームのバッジの一覧' };
const SIGNUP = { src: '/guide/signup.png', alt: '新規登録の画面' };
const PROFILE = { src: '/guide/profile.png', alt: '身長と体重を入力する画面' };
/** 新しい画面 (段 0 で撮る)。alt は landing-screens.ts の LANDING_SCREENS と同じ文 (U-4) */
const HOME = { src: '/marketing/screens/home.png', alt: 'ホームの画面' };
const PANTRY = { src: '/marketing/screens/pantry.png', alt: '食材管理の画面' };
const SHOPPING = { src: '/marketing/screens/shopping.png', alt: '献立から作った買い物リスト' };
const FAMILY_SCREEN = { src: '/marketing/screens/family.png', alt: '家族の画面' };
const CHAT = { src: '/marketing/screens/chat.png', alt: 'AI 相談のシート' };
const CONSENT = { src: '/marketing/screens/consent.png', alt: 'AI 機能の同意の画面' };
/** 拡大の画像 (段 0 に、隣の画面と同じ撮影の回の同じ画面から切り出す)。alt は landing-screens.ts の LANDING_ZOOMS と同じ文 (U-4) */
const ZOOM_PHOTO = { src: '/marketing/screens/zoom-photo.png', alt: '解析結果のスコアと記録コメントを拡大した部分' };
const ZOOM_MENU = { src: '/marketing/screens/zoom-menu.png', alt: '献立表の朝食の 1 食を拡大した部分' };

export const LANDING_COPY = {
  header: {
    nav: [
      { key: 'how', label: '仕組み', href: '#how' },
      { key: 'features', label: '機能', href: '#features' },
      { key: 'family', label: '家族と組織', href: '#family' },
      { key: 'pricing', label: '料金', href: '#pricing' },
      { key: 'faq', label: 'よくある質問', href: '#faq' },
    ],
    login: { label: 'ログイン', href: '/login' },
    cta: PRIMARY_CTA,
  },
  hero: {
    eyebrow: '褒めて伸ばす、AI 食事記録アプリ',
    headlineLines: ['食べることを、', 'もっと誇らしく。'],
    lead: '写真を 1 枚撮ると、AI が料理を認識して栄養を推定します。食事の記録の画面では、記録をほめるひと言と栄養のひと言メモが出ます。1週間の献立の提案から買い物リスト、体重や健康診断の記録まで、ひとつのアプリでそろいます。',
    primaryCta: PRIMARY_CTA,
    secondaryCta: { label: 'デモを試す', href: DEMO_ANCHOR },
    assurances: ASSURANCES,
    screens: [CAMERA, ANALYZE, COMMENT, MENU_RESULT, BADGE_COLLECTION],
    screensCaption: SCREENS_CAPTION,
    scrollCue: 'スクロールして、仕組みを見る',
  },
  story: {
    eyebrow: '仕組み',
    title: '写真から、献立まで。',
    lead: '撮る・見る・褒められる・献立へ。4 つの手順が、ひとつの流れでつながります。',
    steps: [
      { title: '写真を撮る', body: '食事の写真を撮るか、選ぶだけ。カロリーの入力も、食材の選択もいりません。献立表の「写真から入力」からも記録できます。', image: CAMERA },
      { title: 'AI が見る', body: 'AI が料理を認識して、カロリー・タンパク質・炭水化物・脂質・野菜の点を推定します。数値はあくまで推定です。', image: ANALYZE },
      { title: '褒められる', body: '食事の記録の画面に、記録をほめるひと言と栄養メモが出ます。献立の振り返りでは、AI が良いところを見つけて言葉にします。', image: COMMENT },
      { title: '献立へつながる', body: 'AI が 1週間の献立を提案します。前後の日の献立（記録した食事を含む）と同じ料理が続かないようにします。献立から買い物リストを作れます。', image: MENU_RESULT },
    ],
    flow: {
      nodes: [
        { id: 'photo', label: '写真' },
        { id: 'analyze', label: '解析' },
        { id: 'record', label: '記録' },
        { id: 'menu', label: '献立' },
        { id: 'shopping', label: '買い物リスト' },
      ],
      note: 'AI を使う手順は、同意と 1 日の利用回数の上限の範囲で動きます。',
    },
    screensCaption: SCREENS_CAPTION,
  },
  demo: {
    eyebrow: '試してみる',
    title: '褒められるって、こういうこと。',
    lead: '写真を 1 枚選ぶと、写真の解析の結果のサンプル（スコア・記録コメント・推定の栄養）が出ます。',
    pickerTitle: '食事の写真を選ぶ',
    analyzingTitle: 'AI が見ています…',
    analyzingBody: '料理を認識して、栄養を推定しています',
    scoreNote: 'スコアは、アプリと同じ計算で、タンパク質・食物繊維・カロリーの推定から出しています。',
    resultTitle: '記録コメント',
    nutritionTitle: '推定の栄養',
    nutritionLabels: { kcal: 'カロリー', proteinG: 'タンパク質', carbsG: '炭水化物', fatG: '脂質', fiberG: '食物繊維' },
    nutritionUnits: { kcal: 'kcal', proteinG: 'g', carbsG: 'g', fatG: 'g', fiberG: 'g' },
    sampleNotice: '表示はサンプルです。実際のアプリでは、写真から AI が認識した料理の名前が入り、数値は推定です。',
    emptyBody: '写真を選ぶと、ここにスコアと記録コメントが出ます。',
    cta: { label: '自分の食事で試す', href: SIGNUP_HREF },
    samples: [
      {
        id: 'salad-bowl',
        name: 'サラダ',
        photo: { src: '/marketing/photos/salad-bowl.webp', alt: '葉野菜とアボカドとミニトマトとひよこ豆のサラダボウル' },
        dishNames: ['サラダボウル'],
        mealTypeLabel: '昼食',
        nutrition: { kcal: 380, proteinG: 12, carbsG: 28, fatG: 22, fiberG: 10 },
      },
      {
        id: 'salmon-plate',
        name: 'サーモン',
        photo: { src: '/marketing/photos/salmon-plate.webp', alt: '焼いたサーモンといんげんとミニトマトを盛り合わせたプレート' },
        dishNames: ['焼きサーモン', 'いんげんとミニトマト'],
        mealTypeLabel: '夕食',
        nutrition: { kcal: 480, proteinG: 30, carbsG: 40, fatG: 20, fiberG: 4 },
      },
      {
        id: 'pesto-pasta',
        name: 'パスタ',
        photo: { src: '/marketing/photos/pesto-pasta.webp', alt: 'バジルソースのファルファッレとミニトマトと葉野菜' },
        dishNames: ['バジルソースのパスタ'],
        mealTypeLabel: '昼食',
        nutrition: { kcal: 610, proteinG: 17, carbsG: 74, fatG: 26, fiberG: 3 },
      },
    ],
  },
  features: {
    title: '写真の記録だけじゃない。',
    lead: '献立から買い物、体重や健康診断の記録、家族や職場での利用まで。ひとつのアプリでそろいます。',
    cards: [
      { id: 'photo', size: 'large', title: '写真で記録', body: '撮るだけで、AI が料理を認識して栄養を推定します。面倒な入力はいりません。', image: ANALYZE, claimId: 'photo-analyze', href: '#photo' },
      { id: 'praise', size: 'large', title: 'ほめるひと言', body: '食事の記録の画面では、写真で記録すると、ほめるひと言と「栄養メモ」が出ます。', image: COMMENT, claimId: 'praise', href: '#photo' },
      { id: 'menu', size: 'medium', title: '1週間の献立を AI が提案', body: '冷蔵庫優先・時短中心・和食多め・ヘルシーなどの条件を選べます。', image: MENU_RESULT, claimId: 'weekly-menu', href: '#menu' },
      { id: 'shopping', size: 'medium', title: '買い物リスト', body: '献立から買い物リストを作ります。スーパーで迷いません。', image: SHOPPING, claimId: 'shopping-list', href: '#menu' },
      { id: 'pantry', size: 'medium', title: '食材の管理', body: '冷蔵庫を撮ると食材を読み取ります。手入力でも追加でき、期限が近い食材に印が付きます。', image: PANTRY, claimId: 'pantry-manage', href: '#menu' },
      { id: 'nutrition', size: 'medium', title: '栄養の見える化', body: '今日の栄養スコアと今週の自炊率をホームで。献立の振り返りも。', image: HOME, claimId: 'today-score', href: '#nutrition' },
      { id: 'health', size: 'medium', title: '体重と健康の記録', body: '体重は体重計の写真からも。健康診断の結果も写真から取り込めます。推移はグラフで。', image: WEIGHT, claimId: 'health-records', href: '#health' },
      { id: 'badges', size: 'medium', title: 'バッジを集める', body: '食べた食事を「完了」にしていくと、バッジが増えていきます。', image: BADGE_COLLECTION, claimId: 'badges', href: '#badges' },
      { id: 'chat', size: 'small', title: 'AI に相談', body: '画面の右下から相談できます。頼むと、献立の作成などを AI がその場で行います。', image: null, claimId: 'ai-chat', href: '#chat' },
      { id: 'family', size: 'small', title: '家族と組織で使う', body: '家族プランで、家族を招待して献立を一緒に見る。職場では、運営が作った組織で、管理者がメンバーを招待できます。', image: null, claimId: 'family', href: '#family' },
    ],
    screensCaption: SCREENS_CAPTION,
  },
  chapters: {
    photo: {
      id: 'photo',
      eyebrow: '写真で記録',
      title: '撮るだけで、栄養の推定まで。',
      lead: '入口は 2 つ。食事の記録の画面と、献立表の「写真から入力」。',
      points: [
        { title: '2 つの入口', body: 'ホームや下のナビの「スキャン」から開く食事の記録の画面と、献立表の 1 食に写真を入れる「写真から入力」。どちらも同じ AI が解析します。', claimIds: ['photo-entrances', 'photo-analyze'] },
        { title: '5 つの値を推定', body: 'カロリー・タンパク質・炭水化物・脂質・野菜の点。数値はあくまで推定で、料理や撮影の条件で実際の値と異なることがあります。', claimIds: ['nutrition-five', 'ai-estimate'] },
        { title: '記録コメントと栄養メモ', body: '食事の記録の画面では、写真で記録すると、記録をほめるひと言と栄養のひと言メモが出ます。献立表の「写真から入力」では、ほめるひと言は後で食事の詳細に出て、栄養メモは出ません。', claimIds: ['praise', 'nutrition-tip', 'photo-entrances'] },
        { title: '撮るものは 4 種類', body: '食事のほかに、冷蔵庫・健康診断の結果・体重計も、同じ画面から撮れます。', claimIds: ['photo-modes'] },
      ],
      screens: [
        { image: CAMERA, label: '撮影の画面' },
        { image: ANALYZE, label: '解析の結果' },
        { image: COMMENT, label: '記録コメント' },
      ],
      // 拡大の画像は comment.png と同じ撮影の回の同じ画面から切り出す (スコアの箱と記録コメントの箱。§5.4・§7.1 の表 3)
      zoom: { image: ZOOM_PHOTO, label: 'スコアと記録コメント' },
      screensCaption: SCREENS_CAPTION,
      cta: PRIMARY_CTA,
    },
    menu: {
      id: 'menu',
      eyebrow: 'AI 献立と買い物',
      title: '「今日なに作ろう」を、引き受ける。',
      lead: '条件を選ぶと、AI が 1週間分の献立を提案します。直したいところは AI か手で修正し、献立から買い物リストへ。',
      points: [
        { title: '条件を選ぶ', body: '作る範囲と、冷蔵庫優先・時短中心・和食多め・ヘルシーの条件、自由なメモを添えて頼めます。', claimIds: ['menu-conditions'] },
        { title: '1週間分の献立表', body: '朝・昼・夕が日ごとに並びます。表の上には自炊率と平均 kcal/日。', claimIds: ['weekly-menu', 'menu-stats'] },
        { title: 'AI で変更・手動で修正・レシピを見る', body: '献立の 1 食は「AIで変更」で作り直すか、「手動で修正」で書き換えられます。「レシピを見る」で材料と作り方を開き、気に入ったレシピはお気に入りに残せます。', claimIds: ['menu-edit', 'favorites'] },
        { title: '買い物リスト', body: '献立の範囲を選んで買い物リストを作ります。作成と AI での作り直しは、1 日の利用回数の上限に数えます。', claimIds: ['shopping-list', 'ai-daily-limit'] },
        { title: '食材の管理', body: '冷蔵庫を撮ると食材を読み取り、手入力でも足せます。期限切れ・期限間近の食材に印が付きます。', claimIds: ['fridge', 'pantry-manage'] },
      ],
      screens: [
        { image: MENU_REQUEST, label: '献立表' },
        { image: MENU_SETTING, label: '条件の選択' },
        { image: MENU_RESULT, label: '1週間分の献立' },
        { image: SHOPPING, label: '買い物リスト' },
        { image: PANTRY, label: '食材の管理' },
      ],
      // 拡大の画像は menu-result.png と同じ撮影の回の同じ画面から切り出す (今日の朝食の 1 食の箱。§5.4・§7.1 の表 3)
      zoom: { image: ZOOM_MENU, label: '朝食の 1 食' },
      screensCaption: SCREENS_CAPTION,
      cta: PRIMARY_CTA,
    },
    nutrition: {
      id: 'nutrition',
      eyebrow: '栄養の見える化',
      title: '数字で、振り返る。',
      lead: '今日のスコア、今週の自炊率、献立の振り返り。がんばりが見える形で残ります。',
      ring: {
        label: '写真の解析のスコア（見本）',
        value: 89,
        note: 'ヒーローの画面に写るスコアと同じ値です。アプリと同じ計算で、タンパク質 24 g・食物繊維 4 g・740 kcal の推定から出しています。',
      },
      points: [
        { title: '今日の栄養スコア', body: 'ホームに、今日の記録から計算した栄養スコアと主要な栄養素のバーが出ます。この計算は 1 日の利用回数の上限に数えません。', claimIds: ['today-score'] },
        { title: '今週の自炊率と統計', body: 'ホームの「今週の自炊率」のグラフと「今週の統計」で、1 週間を振り返れます。', claimIds: ['weekly-stats'] },
        { title: '献立の振り返り', body: '献立表の振り返りでは、AI が良い点を見つけて褒めます。', claimIds: ['praise'] },
      ],
      screens: [
        { image: HOME, label: 'ホーム' },
        { image: COMMENT, label: '解析の結果' },
      ],
      zoom: null,
      screensCaption: SCREENS_CAPTION,
      cta: PRIMARY_CTA,
    },
    health: {
      id: 'health',
      eyebrow: '健康の記録',
      title: '体のことも、同じアプリで。',
      lead: '体重から健康診断の結果まで記録して、推移をグラフで見られます。',
      points: [
        { title: '記録できる項目', body: '体組成・バイタル・生活習慣・体調やメンタルを、1 つの画面で折り畳んで記録します。', claimIds: ['health-items'] },
        { title: '体重計の写真から', body: '体重計を撮ると、AI が数値を読み取ります。', claimIds: ['health-records'] },
        { title: '健康診断・血液検査', body: '健康診断の結果は写真から取り込め、血液検査の結果も記録できます。', claimIds: ['health-records', 'blood-tests'] },
        { title: '推移のグラフ', body: '体重・体脂肪率・血圧・睡眠の推移を、期間を選んで見られます。目標体重を決めると、目標までの差が出ます。', claimIds: ['health-graphs'] },
        { title: '目標の管理', body: '健康の目標を自分で決めて管理します。', claimIds: ['health-goals'] },
      ],
      disclaimer: 'AI の読み取りと分析は推定です。医療目的での使用はお控えください。',
      screens: [{ image: WEIGHT, label: '健康の記録' }],
      zoom: null,
      screensCaption: SCREENS_CAPTION,
      cta: PRIMARY_CTA,
    },
    badges: {
      id: 'badges',
      eyebrow: 'バッジと続ける仕組み',
      title: '集めたくなる、あなたの勲章。',
      lead: '食べた食事を「完了」にした回数や、続けた日数で、バッジが増えていきます。',
      points: [
        { title: 'バッジ', body: '完了にした食事の数や続けた日数、アプリの中の使い方の案内の完走などでバッジが付きます。新しく付くと、お知らせが出ます。', claimIds: ['badges'] },
        { title: 'ランク', body: '獲得したバッジの数で、食の初心者 → 健康ルーキー → バランスの達人 → 栄養マスター → 食のレジェンド とランクが上がり、次のランクまでの数が出ます。', claimIds: ['badge-ranks'] },
      ],
      items: [
        { code: 'first_bite', name: 'はじめの一歩', description: 'はじめて食事を「完了」にすると付きます。' },
        { code: 'streak_3', name: '三日坊主卒業', description: '3日続けて、食事を「完了」にすると付きます。' },
        { code: 'streak_7', name: '週間チャンピオン', description: '1週間続けて、食事を「完了」にすると付きます。' },
        { code: 'tutorial_complete', name: '使い方マスター', description: 'アプリの中の使い方の案内を、最後まで終えると付きます。' },
      ],
      screens: [
        { image: BADGE_GET, label: '新しいバッジ' },
        { image: BADGE_COLLECTION, label: 'トロフィールーム' },
      ],
      zoom: null,
      screensCaption: SCREENS_CAPTION,
      cta: PRIMARY_CTA,
    },
    chat: {
      id: 'chat',
      eyebrow: 'AI に相談',
      title: '迷ったら、聞ける。',
      lead: '画面の右下のボタンから、AI アドバイザーに相談できます。',
      points: [
        { title: 'どの画面からでも', body: 'アプリの画面の右下にある「AIアドバイザー」のボタンから、相談のシートが開きます。', claimIds: ['ai-chat'] },
        { title: '頼めば、その場で', body: '相談の中で頼むと、AI が献立の作成や買い物リストへの追加、食材や目標の変更などを、その場で行います。', claimIds: ['ai-chat'] },
        { title: '相談の要約', body: '相談を終了すると、相談の要約を保存します。', claimIds: ['ai-chat'] },
        { title: '上限と一時停止', body: 'AI 相談は、1 日の利用回数の上限に数えます。運営の判断で一時停止することがあります。', claimIds: ['ai-daily-limit', 'ai-stop'] },
      ],
      screens: [{ image: CHAT, label: 'AI 相談のシート' }],
      zoom: null,
      screensCaption: SCREENS_CAPTION,
      cta: PRIMARY_CTA,
    },
  },
  scenes: {
    title: 'あなたの暮らしに、当てはめると。',
    lead: '使い方は人それぞれ。4 つの場面で、機能の組み合わせを紹介します。',
    items: [
      { id: 'solo', title: '一人暮らし', body: '帰りが遅い日も、写真を撮るだけで AI が料理を認識して栄養を推定します。週末に 1週間分の献立を AI に頼み、買い物リストを持ってスーパーへ。', claimIds: ['photo-analyze', 'weekly-menu', 'shopping-list'] },
      { id: 'family', title: '子育て家庭', body: '家族プランで家族を招待して、献立表で家族の献立を一緒に見られます。アカウントの無い子どもも登録でき、共有する範囲は自分で選べます。', claimIds: ['family-roles', 'family-share', 'family-menu-view'] },
      { id: 'health', title: '健康の記録を続けたい人', body: '体重計や健康診断の結果を写真から取り込み、推移をグラフで確かめます。目標を決めて、目標までの差を見ながら記録します。', claimIds: ['health-records', 'health-graphs', 'health-goals'] },
      { id: 'team', title: '職場とチーム', body: '組織は運営が作り、組織の管理者がメンバーを招待して、部署やチャレンジを管理します。一人ひとりの記録は、管理者に見せません。', claimIds: ['org-admin'] },
    ],
  },
  family: {
    eyebrow: '家族で使う',
    title: '家族の献立を、ひとつの表で。',
    lead: '家族プラン（家族 Basic・家族 Pro）をご契約の代表者が家族を作り、大人を招待し、子どもを登録します。見せる範囲は、ひとりずつ自分で決めます。',
    points: [
      { title: '3 つの立場', body: '代表者・大人・子ども。アカウントの無い子どもも、代表者が登録できます。代表者の役目は、あとから譲れます。', claimIds: ['family-roles'] },
      { title: 'メールで招待', body: '大人のメンバーは、メールの招待リンクから参加します。', claimIds: ['family-roles'] },
      { title: '共有の範囲は自分で', body: '食事の記録・健康・献立の 3 つを、家族に見せるかどうか自分で選びます。はじめは、食事の記録はオン、健康はオフです。', claimIds: ['family-share'] },
      { title: '家族の献立を見る', body: '献立表の「家族の表示」で、共有をオンにしている家族の献立を読み取り専用で見られます。', claimIds: ['family-menu-view', 'family'] },
    ],
    shareFigure: [
      { label: '食事の記録', state: 'on', note: 'はじめはオン' },
      { label: '健康', state: 'off', note: 'はじめはオフ' },
      { label: '献立', state: 'choose', note: '自分で選ぶ' },
    ],
    screen: { image: FAMILY_SCREEN, label: '家族の画面' },
    screensCaption: SCREENS_CAPTION,
    cta: PRIMARY_CTA,
  },
  org: {
    eyebrow: '組織で使う',
    title: '職場の健康づくりにも。',
    lead: '組織は運営が作ります（ご利用はお問い合わせください）。組織の管理者が、メンバーを招待し、部署やチャレンジを管理します。一人ひとりの記録は、管理者に見せません。',
    points: [
      { title: '管理者の画面', body: '組織の管理者（オーナー・管理者）だけが開ける画面で、メンバー・部署・招待・チャレンジを管理します。', claimIds: ['org-admin'] },
      { title: '部署と招待', body: '部署を作り、メールでメンバーを招待します。', claimIds: ['org-admin'] },
      { title: 'チャレンジ', body: '期間を決めたチャレンジを開けます。平均は、チャレンジが終わった後に、終了時点の参加者が最小の人数以上のときだけ出します。', claimIds: ['org-challenge-privacy'] },
      { title: '一人ひとりの記録は見せません', body: '管理者の画面に、一人ひとりの記録は出しません。チャレンジの参加者数と、終わった後の平均のほかに、活力スコアや部署ごとの記録の集計は出しません。', claimIds: ['org-admin'] },
    ],
    figure: { admin: '管理者', managed: ['メンバー', '部署', 'チャレンジ'] },
    cta: { label: '組織での利用について問い合わせる', href: '/contact' },
  },
  trust: {
    title: '正直に、お伝えします。',
    lead: 'できることと、できないこと。データの扱いも、ここに書きます。',
    items: [
      { title: '無料プランと有料プラン', body: `無料プランでは、写真での食事の記録、記録をほめるひと言、献立の作成、健康の記録などをお使いいただけます。AI を使う機能には、1 日にご利用いただける回数の上限があります。${PAID_PLAN_SUMMARY}`, link: null },
      { title: 'データの取り扱い', body: 'AI を使う機能は、日本国外の AI 事業者へのデータ提供について同意をいただいてから使えます。写真や記録の保存と第三者への提供については、プライバシーポリシーをご確認ください。', link: { label: 'プライバシーポリシーを読む', href: '/privacy' } },
      { title: '写真の保存', body: '写真は、公開されない保存領域に保存します。表示するときは、ログインしたご本人のために有効期限つきの URL を発行します。', link: null },
      { title: 'AI の分析は推定です', body: '料理や撮影の条件によって、実際の値と異なることがあります。医療目的での使用はお控えください。', link: null },
      { title: 'ログイン中の端末', body: '設定の「ログイン中の端末」で、ログインしている端末の一覧と最近のログインを確かめ、ほかの端末のログインを個別に解除できます。', link: null },
      { title: '退会・書き出し・請求', body: '設定からいつでも退会できます。記録したデータは JSON 形式で書き出せます。開示・訂正・利用停止の請求も、設定から送れます。', link: null },
    ],
    screen: { image: CONSENT, label: '同意の画面' },
    screensCaption: SCREENS_CAPTION,
  },
  pricing: {
    eyebrow: '料金',
    title: '無料ではじめて、必要になったら有料プランへ。',
    lead: `無料プランで、写真での食事の記録・献立の作成・健康の記録などをお使いいただけます。AI を使う機能には、1 日にご利用いただける回数の上限があります。${PAID_PLAN_SUMMARY}組織でのご利用は、運営が組織を作ってからになります（お問い合わせください）。`,
    plans: [
      {
        id: 'free',
        title: '無料プラン',
        badge: '無料',
        items: ['写真で記録とほめるひと言', '1週間の献立と買い物リスト', '食材の管理', '栄養の見える化', '体重と健康の記録', 'バッジ', 'AI に相談'],
        body: null,
        cta: PRIMARY_CTA,
      },
      {
        id: 'paid',
        title: '有料プラン',
        badge: '無料体験つき',
        // 価格は PLAN_CATALOG (DB の価格の写し) から組む。body は null (PricingSection.tsx は body の前にカレンダーの印のアイコン (CalendarClock) を付けるため。有料で増えるものは lead の PAID_PLAN_SUMMARY で書く。billing/03 §10.5)
        items: PLAN_CATALOG.map(
          (plan) =>
            `${plan.display_name}${plan.max_members === null ? '' : `（${plan.max_members} 人まで）`}　月額 ${formatJpy(plan.monthly_price_jpy)} / 年額 ${formatJpy(plan.yearly_price_jpy)}（税込）`,
        ),
        body: null,
        cta: { label: '料金プランを見る', href: '/pricing' },
      },
    ],
    limits: [
      { title: '1 日の上限', body: 'AI を使う機能（写真の解析・献立の提案・買い物リストの作り直し・AI 相談など）は、1 日に使える回数に上限があり、上限に達した日は翌日 0 時からまた使えます。回数は運営の設定で変わるため、ここには書きません。', claimIds: ['ai-daily-limit', 'ai-features'] },
      { title: '数えない機能', body: '画面を開くと自動で動く機能（ホームの栄養スコアなど）は、上限に数えません。', claimIds: ['ai-daily-limit', 'today-score'] },
      { title: '一時停止', body: '運営の判断で、AI 相談を一時停止することがあります。', claimIds: ['ai-stop'] },
    ],
  },
  guide: {
    eyebrow: '使い方ガイド',
    title: 'はじめ方は、5 つの章で。',
    lead: '登録から、食事の記録、献立、健康の記録、バッジまで。画面の写真つきの使い方ガイドを用意しています。',
    chapters: [
      { title: 'はじめかた', stepCount: 3 },
      { title: '食事を記録する', stepCount: 3 },
      { title: '献立を提案してもらう', stepCount: 3 },
      { title: '健康を記録する', stepCount: 3 },
      { title: 'バッジを集める', stepCount: 3 },
    ],
    points: [
      { title: '登録はメールか Google で', body: 'メールアドレスか Google アカウントで登録できます。クレジットカードは不要です。', claimIds: ['signup-methods', 'no-card'] },
      { title: '初期設定で目標カロリーを計算', body: '身長・体重・目標を入れると、目標カロリーを自動で計算します。根拠を確かめて、自分の感覚に合わせて微調整できます。', claimIds: ['onboarding'] },
      { title: 'アプリの中の案内', body: 'はじめてのときは、アプリの中の使い方の案内（ハンズオンツアー）で、写真の記録と献立とバッジを試せます。最後まで終えると「使い方マスター」のバッジが付きます。', claimIds: ['guide-exists', 'badges'] },
    ],
    screens: [
      { image: SIGNUP, label: '新規登録' },
      { image: PROFILE, label: '初期設定' },
    ],
    screensCaption: SCREENS_CAPTION,
    cta: { label: '使い方ガイドを読む', href: '/guide' },
  },
  faq: {
    title: 'よくある質問',
    lead: '気になることがあれば、ここで。',
    items: [
      { q: '本当に無料で使えますか？', a: `はい。無料プランで、写真の記録、ほめるひと言、献立の作成、健康の記録などをお使いいただけます。AI を使う機能（写真の解析や献立の作成など）は、1 日にご利用いただける回数に上限があり、上限に達した日は翌日 0 時からまたお使いいただけます。${PAID_PLAN_SUMMARY}` },
      { q: 'どんな機能に AI を使っていますか？', a: '食事の写真の解析、献立の作成、買い物リストの作り直し、冷蔵庫や体重計や健康診断の結果の写真の読み取り、健康診断と血液検査の結果へのコメント、料理の画像の作成、AI 相談、献立の振り返りなどです。どれも、日本国外の AI 事業者へのデータ提供について同意をいただいてから使えます。画面を開くと自動で動く機能（ホームの栄養スコアなど）は、1 日の上限に数えません。' },
      // 撮り方は指示するだけにし、撮り方による認識の良し悪しは言わない (確かめていない。公開の FAQ の同じ質問と同じ趣旨)
      { q: 'どんな写真を撮ればいいですか？', a: '食事全体が写っていれば大丈夫です。真上からでも斜めからでも構いません。明るい場所で、料理が重ならないように撮ってください。' },
      { q: 'AI の分析は正確ですか？', a: 'AI による分析はあくまで推定値で、料理や撮影条件によっては実際の値と異なる場合があります。医療目的での使用はお控えください。日々の食生活の参考としてお使いください。' },
      // データの取り扱いの最終的な文言は、プライバシーポリシーの見直しと合わせて決める。それまでは断定せず、プライバシーポリシーへ案内する (tests/public-claims-guard.test.ts がこの行を見る)
      { q: "データは安全ですか？", a: 'データの取り扱い（保存や第三者への提供など）については、プライバシーポリシーをご確認ください。いつでもデータの削除をリクエストできます。' },
      { q: '写真はどこに保存されますか？', a: '公開されない保存領域に保存します。URL を知っているだけでは閲覧できず、表示するときはログインしたご本人のために有効期限つきの URL を発行します。詳しくはプライバシーポリシーをご確認ください。' },
      { q: '家族で使えますか？', a: 'はい。家族プラン（家族 Basic・家族 Pro）をご契約の代表者が家族グループを作り、家族を招待して、献立表で家族の献立を見たり、記録を共有したりできます。見られるのは、相手が共有をオンにしている献立と記録だけです。' },
      { q: '家族の記録は誰に見えますか？', a: '家族のメンバーそれぞれが、食事の記録・健康・献立の 3 つを家族に見せるかどうかを自分で選びます。はじめは、食事の記録はオン、健康はオフです。アカウントの無い子どもの登録もできます。' },
      { q: '会社やチームで使えますか？', a: 'はい。組織は運営が作ります（お問い合わせください）。組織の管理者（オーナー・管理者）が、メンバーを招待し、部署を作り、チャレンジを開けます。個人の記録の集計（活力スコアなど）は出しません。チャレンジの平均は、終わった後に、参加者が最小の人数以上のときだけ出します。' },
      { q: '登録に必要なものは？', a: 'メールアドレスか、Google アカウントです。クレジットカードは不要です。' },
      { q: 'ログインしている端末を確かめられますか？', a: 'はい。設定の「ログイン中の端末」で、ログインしている端末の一覧と最近のログインを確かめ、ほかの端末のログインを個別に解除できます。' },
      { q: '退会やデータの削除はできますか？', a: 'はい。設定からいつでも退会できます。記録したデータは、退会の前に JSON 形式で書き出せます。アカウントを残したまま一部のデータの消去を求めるときは、設定から開示・訂正・利用停止の請求を送れます。' },
    ],
    contactLead: 'ほかに質問がある場合は',
    contact: { label: 'お問い合わせフォームへ', href: '/contact' },
  },
  finalCta: {
    title: '明日の食事が、楽しみになる。',
    lead: 'まずは 3 日、写真で記録してみてください。食事の記録の画面に、記録をほめるひと言が出ます。',
    cta: PRIMARY_CTA,
    assurances: ASSURANCES,
    disclaimer: 'AI の分析は推定値です。医療上の判断には使わず、気になることは医師にご相談ください。',
  },
  footer: {
    tagline: '写真を撮るだけで、AI が料理を認識して、記録をほめてくれる食事記録アプリ。',
    columns: [
      { title: 'サービス', links: [{ label: 'サービスについて', href: '/about' }, { label: '新規登録', href: SIGNUP_HREF }, { label: 'ログイン', href: '/login' }, { label: '料金プラン', href: '/pricing' }] },
      { title: 'サポート', links: [{ label: '使い方ガイド', href: '/guide' }, { label: 'お問い合わせ', href: '/contact' }, { label: 'よくある質問', href: '/faq' }, { label: 'お知らせ', href: '/news' }] },
      { title: '法的情報', links: [{ label: '利用規約', href: '/terms' }, { label: 'プライバシーポリシー', href: '/privacy' }, { label: '特定商取引法に基づく表記', href: '/legal' }, { label: '運営会社', href: '/company' }] },
    ],
    socialLinks: [],
    storeLinks: [],
    copyrightYear: COPYRIGHT_YEAR,
  },
  claims: [
    { id: 'photo-analyze', text: '写真を撮るだけで、AI が料理を認識して栄養を推定する', evidence: ['src/app/api/ai/analyze-meal-photo/route.ts', 'src/app/(main)/meals/new/page.tsx', 'supabase/functions/_shared/nutrition-pipeline.ts'], condition: 'データ提供への同意 (ai-consent) と 1 日の利用回数の上限 (ai-daily-limit) の範囲で使える。数値は推定 (ai-estimate)' },
    { id: 'praise', text: '食事の記録の画面では、写真で記録すると、記録をほめるひと言 (記録コメント) が出る。献立の振り返りでは、AI が良い点を見つけて褒める', evidence: ['supabase/functions/_shared/nutrition-pipeline.ts', 'supabase/functions/analyze-meal-photo/index.ts', 'src/app/(main)/meals/new/page.tsx', 'src/app/api/ai/nutrition/feedback/route.ts', 'src/app/(main)/menus/weekly/page.tsx'], condition: '記録コメントは料理の名前と食事の区分だけが変わる定型の文。記録のときの画面に出すのは食事の記録の画面だけで、献立表の写真から入力では出さず、写真を使わない記録では作らない。同意と 1 日の利用回数の上限の範囲で' },
    { id: 'nutrition-tip', text: '食事の記録の画面では、写真で記録すると、栄養のひと言のメモ (栄養メモ) が出る', evidence: ['supabase/functions/_shared/nutrition-pipeline.ts', 'src/app/(main)/meals/new/page.tsx'], condition: '献立表の写真から入力では保存も表示もしない。同意と 1 日の利用回数の上限の範囲で' },
    { id: 'demo-sample', text: 'デモの結果はサンプル。スコアと記録コメントは、アプリの写真の解析と同じ式と同じ定型の文で、表示する推定の値と料理の名前から作る。栄養の見える化のスコアの輪の値も同じ式で、撮影の見本と同じ', evidence: ['supabase/functions/_shared/nutrition-pipeline.ts'], condition: 'サンプルの値は実際の解析の値ではない。アプリの結果の画面の栄養の 5 つ目は野菜の点で、デモはスコアを再計算できるよう食物繊維を出す' },
    { id: 'weekly-menu', text: '1週間の献立を AI が提案する (条件: 冷蔵庫優先・時短中心・和食多め・ヘルシー)。前後の日の献立 (記録した食事を含む) と同じ料理が続かないようにする', evidence: ['src/app/(main)/menus/weekly/page.tsx', 'src/app/api/ai/menu/weekly/request/route.ts', 'src/components/ai-assistant/V4GenerateModal.tsx', 'src/app/faq/page.tsx'], condition: '同意と 1 日の利用回数の上限の範囲で' },
    { id: 'shopping-list', text: '献立から買い物リストを作る', evidence: ['src/app/api/shopping-list/', 'src/app/(main)/menus/weekly/page.tsx', 'src/app/(main)/menus/weekly/_components/modals/ShoppingModal.tsx', 'tests/regenerate-shopping-list-request-ownership.test.ts'], condition: '生成と AI での作り直しは 1 日の利用回数の上限に数える' },
    { id: 'health-records', text: '体重 (体重計の写真からも) と健康診断の結果 (写真から) を記録し、推移をグラフで見る', evidence: ['src/app/api/ai/analyze-weight-scale/route.ts', 'src/app/api/ai/analyze-health-checkup/route.ts', 'src/app/api/health/checkups/route.ts', 'src/app/(main)/health/'], condition: '写真の読み取りは同意と 1 日の利用回数の上限の範囲で' },
    { id: 'badges', text: '食べた食事を「完了」にした回数と続けた日数、アプリの中の使い方の案内の完走などで、バッジが付く。新しく付くとお知らせが出る', evidence: ['src/app/api/badges/route.ts', 'src/lib/badges/awardable.ts', 'src/lib/jst-day-ranges.ts', 'supabase/migrations/20251126124224_create_meal_planner_tables.sql', 'src/app/api/meal-plans/add-from-photo/route.ts', 'src/app/(main)/badges/page.tsx'], condition: '数えるのは完了にした食事 (使い方の練習のお試しの記録を除く) と、完了した食事のある日の連続日数。写真から献立表に保存しただけの食事は、完了にするまで数えない。付く条件はほかにもあるので、文は「など」で終える。photo_10 は名前が付与の条件と食い違うので載せない。planner は名前と付与の条件が合うが、章 badges の列は 4 枚のまま保ち載せない' },
    { id: 'fridge', text: '冷蔵庫の写真から食材を読み取る', evidence: ['src/app/api/ai/analyze-fridge/route.ts', 'src/app/(main)/pantry/'], condition: '同意と 1 日の利用回数の上限の範囲で' },
    { id: 'family', text: '家族を招待して献立を一緒に見る・記録を共有する', evidence: ['src/app/api/family/groups/route.ts', 'src/app/api/family/invites/route.ts', 'src/app/api/family/members/me/share/route.ts', 'src/app/(main)/family/'], condition: '共有は本人の設定の範囲で (family-share)。家族グループの作成とメンバーの追加は、代表者の家族プランの契約が要る (billing/03 §6.6)' },
    { id: 'free-now', text: '無料プランで使える機能があり、有料プランは 3 つ (個人 Pro / 家族 Basic / 家族 Pro)。家族グループ・究極モード・料理画像の作成は有料プラン', evidence: ['src/app/pricing/PricingPageView.tsx', 'packages/shared/src/billing-plans.ts'], condition: 'AI を使う機能には 1 日の利用回数の上限がある。無料と書く段落には上限の文も入れる。無料の機能の一覧に、家族・究極モード・料理画像の作成と組織を入れない (組織は運営が作るもので、登録しただけでは使えない (org-admin))' },
    { id: 'ai-daily-limit', text: 'AI を使う機能 (写真の解析や献立の提案など) は、1 日に使える回数に上限がある。上限に達した日は、翌日 0 時から使える。画面を開くと自動で動く機能は上限に数えない', evidence: ['src/lib/plan/entitlements.ts', 'supabase/functions/_shared/ai-daily-limit.ts', 'supabase/functions/_shared/ai-usage-core.ts', 'supabase/migrations/20261011020000_ai_daily_limits.sql'], condition: '回数の数字は書かない (運営画面で変えられる。free は 3 回 (billing/03 §6.5))。上限に数えない自動の機能もある' },
    { id: 'ai-consent', text: 'AI を使う機能は、日本国外の AI 事業者へのデータ提供について同意を受けてから使える', evidence: ['src/components/consent/AiDataConsentModal.tsx', 'src/lib/ai/consent-guard.ts', 'src/lib/ai/consent-config.ts'], condition: null },
    { id: 'no-card', text: 'クレジットカード不要', evidence: ['src/app/(auth)/signup/'], condition: null },
    { id: 'delete-export', text: 'いつでも退会できる・データを JSON で書き出せる', evidence: ['src/app/api/account/', 'tests/account-delete-route.test.ts', 'tests/account-export.test.ts'], condition: null },
    { id: 'ai-estimate', text: 'AI の分析は推定で、医療目的に使わない', evidence: ['src/app/faq/page.tsx'], condition: null },
    { id: 'privacy', text: 'データの取り扱いはプライバシーポリシーに書く', evidence: ['src/app/privacy/page.tsx'], condition: '保存と第三者への提供は断定せず、プライバシーポリシーへ案内する' },
    { id: 'photo-entrances', text: '写真で記録する入口は 2 つ: 食事の記録の画面 (ホームと下のナビの「スキャン」から) と、献立表の 1 食に写真を入れる「写真から入力」', evidence: ['src/app/(main)/meals/new/page.tsx', 'src/app/(main)/MainLayout.tsx', 'src/app/(main)/menus/weekly/page.tsx', 'src/app/(main)/menus/weekly/_components/modals/PhotoEditModal.tsx', 'src/app/api/meal-plans/add-from-photo/route.ts'], condition: '献立表の写真から入力では、記録コメントは記録のときの画面に出ず (後で食事の詳細に出る)、栄養メモは保存されない' },
    { id: 'nutrition-five', text: '写真の解析の結果に、カロリー・タンパク質・炭水化物・脂質・野菜の点の 5 つが出る', evidence: ['src/app/(main)/meals/new/page.tsx', 'supabase/functions/_shared/nutrition-pipeline.ts'], condition: '数値は推定 (ai-estimate)' },
    { id: 'photo-modes', text: '撮影の画面は、食事・冷蔵庫・健康診断の結果・体重計の 4 種類を扱う', evidence: ['src/app/(main)/meals/new/page.tsx'], condition: '同意と 1 日の利用回数の上限の範囲で' },
    { id: 'menu-conditions', text: '献立の提案は、作る範囲と、冷蔵庫優先・時短中心・和食多め・ヘルシーの条件、自由なメモを添えて頼める', evidence: ['src/components/ai-assistant/V4GenerateModal.tsx', 'src/app/guide/guide-content.ts'], condition: '同意と 1 日の利用回数の上限の範囲で' },
    { id: 'menu-edit', text: '献立の 1 食は「AIで変更」で作り直すか「手動で修正」で書き換えられ、「レシピを見る」で材料と作り方を開ける', evidence: ['src/app/(main)/menus/weekly/page.tsx', 'src/app/(main)/menus/weekly/_components/modals/RegenerateMealModal.tsx', 'src/app/(main)/menus/weekly/_components/modals/RecipeModal.tsx', 'src/app/api/recipes/[id]/route.ts'], condition: '「AIで変更」は同意と 1 日の利用回数の上限の範囲で' },
    { id: 'menu-stats', text: '献立表の上に、自炊率と平均 kcal/日 が出る', evidence: ['src/app/(main)/menus/weekly/page.tsx'], condition: null },
    { id: 'favorites', text: '気に入ったレシピをお気に入りに残せる (献立のレシピのハートから)', evidence: ['src/app/(main)/favorites/page.tsx', 'src/app/api/favorites/route.ts'], condition: null },
    { id: 'today-score', text: 'ホームに、今日の記録から計算した栄養スコアと主要な栄養素のバーが出る。この計算は 1 日の利用回数の上限に数えない', evidence: ['src/app/(main)/home/page.tsx', 'src/hooks/useHomeData.ts', 'src/app/api/ai/nutrition-analysis/route.ts'], condition: 'スコアは記録した食事と目標から計算する値で、AI の自由な文ではない。AI のアドバイスの部分は同意の範囲で' },
    { id: 'weekly-stats', text: 'ホームの「今週の自炊率」のグラフと「今週の統計」で 1 週間を振り返れる', evidence: ['src/app/(main)/home/page.tsx'], condition: null },
    { id: 'health-items', text: '健康の記録の画面で、体組成・バイタル・生活習慣・体調やメンタルを折り畳みで記録する', evidence: ['src/app/(main)/health/record/page.tsx'], condition: null },
    { id: 'health-graphs', text: '体重・体脂肪率・血圧・睡眠の推移を期間を選んで見られる。目標体重を決めると目標までの差が出る', evidence: ['src/app/(main)/health/graphs/page.tsx', 'src/app/guide/guide-content.ts'], condition: '数値の改善を言わない。「目標までの差」は表示の事実' },
    { id: 'blood-tests', text: '血液検査の結果を記録できる', evidence: ['src/app/(main)/health/blood-tests/page.tsx', 'src/app/api/health/blood-tests/route.ts'], condition: null },
    { id: 'health-goals', text: '健康の目標を自分で決めて管理する', evidence: ['src/app/(main)/health/goals/page.tsx', 'src/app/api/health/goals/route.ts'], condition: null },
    { id: 'badge-ranks', text: '獲得したバッジの数で、食の初心者 → 健康ルーキー → バランスの達人 → 栄養マスター → 食のレジェンド とランクが上がり、次のランクまでの数が出る', evidence: ['src/app/(main)/badges/page.tsx'], condition: 'ランクの名前と数は画面の定義' },
    { id: 'pantry-manage', text: '食材は手入力でも追加・編集・削除でき、期限切れ・期限間近の食材に印が付く', evidence: ['src/app/(main)/pantry/page.tsx', 'src/app/api/pantry/route.ts'], condition: null },
    { id: 'ai-chat', text: 'アプリの画面の右下の「AIアドバイザー」から相談のシートが開く。相談の中で頼むと、AI が献立の作成・買い物リストへの追加・食材や目標の変更などをその場で行う。相談を終了すると要約を保存する', evidence: ['src/components/AIChatBubble.tsx', 'src/app/(main)/MainLayout.tsx', 'src/lib/ai/consultation-action-executor.ts', 'src/app/api/ai/consultation/sessions/route.ts', 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts'], condition: '同意と 1 日の利用回数の上限の範囲で。運営が一時停止できる (ai-stop)。AI の返事の文は画面写真に写さない。実行の前に確かめる手順は無い (頼むとその場で行う) ので、確かめてから行うと読める言い方は書かない' },
    { id: 'ai-features', text: 'AI を使う機能は、食事の写真の解析・献立の作成・買い物リストの作り直し・冷蔵庫の写真・体重計の写真・健康診断の結果の読み取り・健康診断と血液検査の結果へのコメント・料理の画像の作成・AI 相談・献立の振り返りなど', evidence: ['supabase/functions/_shared/ai-usage-core.ts', 'src/app/api/health/checkups/route.ts', 'src/app/api/health/blood-tests/route.ts', 'src/app/api/ai/image/generate/route.ts', 'src/lib/ai/consent-config.ts'], condition: 'すべて同意と上限の範囲で (上限に数えない自動の機能を除く)。AI_FEATURES のすべては挙げないので、文は「など」で終える' },
    { id: 'family-roles', text: '家族は代表者・大人・子どもの 3 つの立場。アカウントの無い子どもも代表者が登録でき、大人はメールの招待リンクから参加する。代表者の役目は譲れる', evidence: ['src/app/(main)/family/members/invite/page.tsx', 'src/app/api/family/invites/route.ts', 'src/app/(main)/family/dashboard/page.tsx', 'src/app/(main)/family/members/child/new/page.tsx', 'src/app/api/family/members/child/route.ts', 'src/app/(main)/family/representative-transfer/page.tsx'], condition: null },
    { id: 'family-share', text: '家族に見せる範囲 (食事の記録・健康・献立) は自分で選ぶ。はじめは食事の記録はオン、健康はオフ', evidence: ['src/schemas/membership/share-settings.ts', 'src/app/api/family/members/me/share/route.ts', 'src/app/(main)/family/members/[id]/page.tsx'], condition: '献立の既定は文に書かない' },
    { id: 'family-menu-view', text: '献立表の「家族の表示」で、共有をオンにしている家族の献立を読み取り専用で見られる', evidence: ['src/hooks/useFamilyMenu.ts', 'src/components/membership/FamilyMenuRows.tsx', 'src/app/api/family/menu/route.ts', 'src/app/(main)/menus/weekly/page.tsx', 'docs/design/family/10-family-menu-view.md'], condition: '相手が share_menu をオンにしている献立だけ' },
    { id: 'org-admin', text: '組織は運営が作り、オーナーを決める (登録しただけでは組織は作れず、組織の画面も使えない)。組織の管理者 (オーナー・管理者) だけが開ける画面で、メンバー・部署・招待・チャレンジを管理する。管理者の画面に、一人ひとりの記録は出さない。チャレンジの参加者数と終了後の平均のほかに、個人の記録の集計 (活力スコアなど) と部署ごとの記録の集計は出していない', evidence: ['src/app/api/admin/organizations/route.ts', 'src/app/(org)/org/page.tsx', 'src/app/(org)/layout.tsx', 'src/app/(org)/org/invites/page.tsx', 'src/app/(org)/org/departments/page.tsx', 'src/app/(org)/org/members/page.tsx', 'src/app/(org)/org/challenges/page.tsx', 'src/app/api/org/invites/route.ts', 'src/app/api/org/departments/route.ts', 'src/app/api/org/challenges/route.ts', 'src/app/(org)/org/dashboard/page.tsx', 'src/app/api/org/stats/route.ts'], condition: '「組織は運営が作り、登録しただけでは使えない」と「一人ひとりの記録は管理者に見せない」を落とさない。管理者に見える数を、チャレンジの参加者数と終了後の平均を落として言わない。組織を無料の機能の一覧に入れない (組織のプランの課金は別の冊)。部署は作成・名前の変更・削除だけで、メンバーの所属の部署を決める手段は無いので、所属を言う文を書かない' },
    { id: 'org-challenge-privacy', text: 'チャレンジの平均は、終了したときに 1 回だけ確定した値を、終了時点の参加者が最小の人数以上のときだけ出す', evidence: ['src/app/(org)/org/challenges/page.tsx', 'docs/design/org/10-challenge-diff-privacy.md'], condition: '開催中は出さない' },
    { id: 'signup-methods', text: 'メールアドレスか Google アカウントで登録できる', evidence: ['src/app/(auth)/signup/page.tsx', 'src/app/faq/page.tsx'], condition: '「30秒」などの時間は書かない' },
    { id: 'onboarding', text: '初期設定で身長・体重・目標を入れると目標カロリーを自動で計算し、根拠を確かめて自分で微調整できる', evidence: ['src/app/onboarding/questions/page.tsx', 'src/app/onboarding/complete/page.tsx'], condition: '到達の予想 (日付) は書かない' },
    { id: 'guide-exists', text: '使い方ガイド (5 つの章・15 の手順・画面の写真つき) と、アプリの中の使い方の案内 (ハンズオンツアー) がある', evidence: ['src/app/guide/guide-content.ts', 'src/app/handson-tour/page.tsx', 'supabase/migrations/20251126124224_create_meal_planner_tables.sql'], condition: null },
    { id: 'sessions', text: '設定の「ログイン中の端末」で、ログインしている端末の一覧と最近のログインを確かめ、ほかの端末のログインを個別に解除できる', evidence: ['src/app/(main)/settings/security/sessions/page.tsx', 'src/lib/auth/sessions/client.ts'], condition: 'いま使っている端末は一覧から解除しない。二段階認証は運営ロールだけの機能なので書かない' },
    { id: 'data-requests', text: '開示・訂正・利用停止の請求を設定から送れる (本人確認のメールが届く)', evidence: ['src/app/api/account/data-requests/', 'src/app/(main)/settings/data-requests/page.tsx', 'src/app/faq/page.tsx'], condition: null },
    { id: 'photo-storage', text: '写真は公開されない保存領域に保存し、表示するときはログインした本人のために有効期限つきの URL を発行する', evidence: ['src/app/faq/page.tsx', 'src/lib/photo-storage-signing.ts', 'src/app/api/storage/signed-urls/route.ts'], condition: '第三者への共有や提供を断定する文は書かず、プライバシーポリシーへ案内する' },
    { id: 'ai-stop', text: '運営の判断で AI 相談を一時停止することがある', evidence: ['src/lib/ai/ai-chat-unavailable.ts', 'supabase/migrations/20261010120000_unify_feature_flags_seed.sql', 'src/components/AIChatBubble.tsx'], condition: null },
  ],
} satisfies LandingCopy;

/** サービスの名前 (ヘッダー・フッター)。直接書かず site-config から */
export const LANDING_SITE_NAME = SITE_NAME;

/** 主張の一覧 (テストから読む) */
export function landingClaims(copy: LandingCopy = LANDING_COPY): readonly LandingClaim[] {
  return copy.claims;
}

/** ページが指す public/ の画像のパス (出てくる順・重複なし。LANDING_COPY では 22 件 = /guide/ 11・/marketing/screens/ 8 (画面 6・拡大 2)・写真 3。U-4) */
export function landingImagePaths(copy: LandingCopy = LANDING_COPY): string[] {
  const chapterScreens = Object.values(copy.chapters).flatMap((chapter) => chapter.screens.map((screen) => screen.image.src));
  const chapterZooms = Object.values(copy.chapters).flatMap((chapter) => (chapter.zoom ? [chapter.zoom.image.src] : []));
  const paths = [
    ...copy.hero.screens.map((image) => image.src),
    ...copy.story.steps.map((step) => step.image.src),
    ...copy.demo.samples.map((sample) => sample.photo.src),
    ...copy.features.cards.flatMap((card) => (card.image ? [card.image.src] : [])),
    ...chapterScreens,
    ...chapterZooms,
    copy.family.screen.image.src,
    copy.trust.screen.image.src,
    ...copy.guide.screens.map((screen) => screen.image.src),
  ];
  return [...new Set(paths)];
}

/** デモの記録コメント (v1.7 と同じ) */
export function demoPraiseComment(sample: Pick<DemoSample, 'dishNames' | 'mealTypeLabel'>): string {
  const dishes = sample.dishNames.slice(0, DEMO_PRAISE_MAX_DISHES).join(DEMO_PRAISE_DISH_SEPARATOR);
  return `${dishes}${DEMO_PRAISE_DISH_SUFFIX}${DEMO_PRAISE_RECORD_PHRASE}${sample.mealTypeLabel}${DEMO_PRAISE_MEAL_PHRASE}${DEMO_PRAISE_END}`;
}

/** デモのスコア (v1.7 と同じ。アプリの overallScore と同じ式・同じ足し算の順) */
export function demoScore(nutrition: Pick<DemoNutrition, 'kcal' | 'proteinG' | 'fiberG'>): number {
  const proteinScore = Math.min(DEMO_SCORE_PROTEIN_CAP, nutrition.proteinG / DEMO_SCORE_PROTEIN_DIVISOR);
  const fiberScore = Math.min(DEMO_SCORE_FIBER_CAP, nutrition.fiberG * DEMO_SCORE_FIBER_FACTOR);
  const caloriesScore =
    nutrition.kcal >= DEMO_SCORE_KCAL_RANGE_MIN && nutrition.kcal <= DEMO_SCORE_KCAL_RANGE_MAX ? DEMO_SCORE_KCAL_IN_RANGE : DEMO_SCORE_KCAL_OUT_OF_RANGE;
  return Math.max(DEMO_SCORE_MIN, Math.min(DEMO_SCORE_MAX, Math.round(DEMO_SCORE_BASE + proteinScore + fiberScore + caloriesScore)));
}
