/**
 * 公開の文とモバイルが読む型の正本 (packages/shared/src/billing-plans.ts) と、価格・AI の上限の正本 (DB の migration) の突き合わせ
 * (billing/03 §14.1 のテスト 37〜40・155)。§0.6 の表の値はテストの中にリテラルで持つ。
 * 段 C で、テスト 37 の後半 (/faq のソースが FREE_PLAN_FAQ_ANSWER・PAID_PLANS_FAQ_ANSWER を逐語で持つ) とテスト 127 (退会の入口) を足した。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FAMILY_PLAN_MAX_MEMBERS,
  FREE_PLAN_AI_LIMIT_NOTE,
  FREE_PLAN_FAQ_ANSWER,
  FREE_PLAN_FEATURES,
  ORG_PLAN_DISPLAY_NAME,
  PAID_PLAN_GENERIC_DISPLAY_NAME,
  PAID_PLANS_FAQ_ANSWER,
  PAID_PLAN_SUMMARY,
  PLAN_AI_DAILY_LIMITS,
  PLAN_CATALOG,
  PLAN_MENU_GENERATION_DAILY_CAPS,
  PLAN_TRIAL_DAYS,
  PLAN_ULTIMATE_DAILY_CAPS,
  STORE_SUBSCRIPTION_DELETION_NOTICE,
  SUBSCRIPTION_STATUS_TEXT_WIRE,
  CANCEL_SCHEDULED_WITHOUT_DATE_TEXT_WIRE,
  planCatalogPriceText,
} from '@homegohan/shared';

/** 未完成や予定を示す語 (billing/03 §14.1 の冒頭。発注者の指示「「まだできてません」みたいなのは書かないで」) */
const UNFINISHED_WORDS = ['準備中', '販売開始前', '近日', '予定', 'まだ', '確定次第', 'これから'] as const;
/** #1867 の Q-12 の共通の文 (tests/public-claims-guard.test.ts の AI_DAILY_LIMIT_PHRASE と同じ) */
const AI_DAILY_LIMIT_PHRASE = '1日にご利用いただける回数に上限があり、上限に達した日は翌日0時からまたお使いいただけます。';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');

function migrationSql(): string {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{14}_billing_paid_plans_iap\.sql$/.test(name));
  expect(files, '本冊の migration はちょうど 1 本').toHaveLength(1);
  // SQL のコメント (-- から行末) を除く
  return fs.readFileSync(path.join(MIGRATIONS_DIR, files[0]), 'utf8').replace(/--[^\n]*/g, '');
}

describe('billing/03 §8.9 PLAN_CATALOG と migration の突き合わせ', () => {
  it('PLAN_CATALOG prices and trial days equal the UPDATE statements in the billing_paid_plans_iap migration', () => {
    const sql = migrationSql();
    const updates = [...sql.matchAll(/UPDATE\s+public\.subscription_plans\s+SET\s+([\s\S]*?)\s+WHERE\s+plan_key\s*=\s*'([a-z_]+)'\s*;/g)].map((match) => {
      const set = match[1];
      const number = (column: string) => Number(new RegExp(`${column}\\s*=\\s*(\\d+)`).exec(set)?.[1]);
      return {
        plan_key: match[2],
        monthly_price_jpy: number('monthly_price_jpy'),
        yearly_price_jpy: number('yearly_price_jpy'),
        trial_days: number('trial_days'),
        display_name: /display_name\s*=\s*'([^']+)'/.exec(set)?.[1],
        max_members: /max_members\s*=\s*(\d+)/.exec(set) ? number('max_members') : null,
      };
    });
    expect(updates).toEqual(
      PLAN_CATALOG.map((plan) => ({
        plan_key: plan.plan_key,
        monthly_price_jpy: plan.monthly_price_jpy,
        yearly_price_jpy: plan.yearly_price_jpy,
        trial_days: plan.trial_days,
        display_name: plan.display_name,
        max_members: plan.max_members,
      })),
    );
    // §0.6 の表 (リテラル)
    expect(PLAN_CATALOG.map((plan) => [plan.plan_key, plan.display_name, plan.monthly_price_jpy, plan.yearly_price_jpy, plan.trial_days, plan.max_members])).toEqual([
      ['pro', '個人 Pro', 580, 5800, 7, null],
      ['family_basic', '家族 Basic', 980, 9800, 7, 4],
      ['family_pro', '家族 Pro', 1480, 14800, 7, 8],
    ]);
    expect(PLAN_TRIAL_DAYS).toBe(7);
    expect(FAMILY_PLAN_MAX_MEMBERS).toEqual({ family_basic: 4, family_pro: 8 });
  });

  it('PLAN_AI_DAILY_LIMITS / PLAN_ULTIMATE_DAILY_CAPS / PLAN_MENU_GENERATION_DAILY_CAPS equal the migration seed rows', () => {
    const sql = migrationSql();
    // 1 日の上限: free は UPDATE、有料の 3 プランは INSERT
    const freeLimit = Number(/UPDATE\s+public\.ai_daily_limits\s+SET\s+daily_limit\s*=\s*(\d+)[^;]*WHERE\s+plan_key\s*=\s*'free'/.exec(sql)?.[1]);
    const paidInsert = /INSERT\s+INTO\s+public\.ai_daily_limits\s*\(plan_key,\s*daily_limit\)\s*VALUES\s*([^;]*?)ON CONFLICT/.exec(sql)?.[1] ?? '';
    const paidLimits = Object.fromEntries([...paidInsert.matchAll(/\('([a-z_]+)',\s*(\d+)\)/g)].map((match) => [match[1], Number(match[2])]));
    expect({ free: freeLimit, ...paidLimits }).toEqual({ ...PLAN_AI_DAILY_LIMITS });
    // 機能ごとの上限の種
    const capsInsert = /INSERT\s+INTO\s+public\.ai_plan_feature_caps\s*\(plan_key,\s*feature,\s*daily_cap\)\s*VALUES\s*([^;]*?)ON CONFLICT/.exec(sql)?.[1] ?? '';
    const caps = [...capsInsert.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)',\s*(\d+)\)/g)].map((match) => ({ plan: match[1], feature: match[2], cap: Number(match[3]) }));
    const capOf = (feature: string) => Object.fromEntries(caps.filter((row) => row.feature === feature).map((row) => [row.plan, row.cap]));
    expect(capOf('menu_generation_ultimate')).toEqual({ ...PLAN_ULTIMATE_DAILY_CAPS });
    expect(capOf('menu_generation')).toEqual({ ...PLAN_MENU_GENERATION_DAILY_CAPS });
    // §0.6 の表 (リテラル)
    expect(PLAN_AI_DAILY_LIMITS).toEqual({ free: 3, pro: 30, family_basic: 30, family_pro: 50 });
    expect(PLAN_ULTIMATE_DAILY_CAPS).toEqual({ free: 0, pro: 2, family_basic: 2, family_pro: 3 });
    expect(PLAN_MENU_GENERATION_DAILY_CAPS).toEqual({ free: 3, pro: 10, family_basic: 10, family_pro: 15 });
    // 無料は料理画像の作成と自動の料理画像を作らない (0)。有料は行なし
    expect(capOf('image_generation')).toEqual({ free: 0 });
    expect(capOf('meal_image_auto')).toEqual({ free: 0 });
  });

  it('planCatalogPriceText renders 3 lines with tax-included prices and the member limits', () => {
    expect(planCatalogPriceText().split('\n')).toEqual([
      '個人 Pro: 月額 580円 / 年額 5,800円 (税込)',
      '家族 Basic: 月額 980円 / 年額 9,800円 (税込)・4 人まで',
      '家族 Pro: 月額 1,480円 / 年額 14,800円 (税込)・8 人まで',
    ]);
  });
});

describe('billing/03 §8.9 公開の文', () => {
  it('no billing-plans.ts text (PLAN_CATALOG features, FREE_PLAN_FEATURES, FREE_PLAN_AI_LIMIT_NOTE, FREE_PLAN_FAQ_ANSWER, PAID_PLANS_FAQ_ANSWER, planCatalogPriceText, status lines) contains any of UNFINISHED_WORDS, and FREE_PLAN_AI_LIMIT_NOTE contains the #1867 Q-12 phrase 1日にご利用いただける回数に上限があり、上限に達した日は翌日0時からまたお使いいただけます。', () => {
    const texts: Array<[string, string]> = [
      ...PLAN_CATALOG.flatMap((plan) => plan.features.map((feature, index): [string, string] => [`${plan.plan_key}.features[${index}]`, feature])),
      ...FREE_PLAN_FEATURES.map((feature, index): [string, string] => [`FREE_PLAN_FEATURES[${index}]`, feature]),
      ['FREE_PLAN_AI_LIMIT_NOTE', FREE_PLAN_AI_LIMIT_NOTE],
      ['FREE_PLAN_FAQ_ANSWER', FREE_PLAN_FAQ_ANSWER],
      ['PAID_PLANS_FAQ_ANSWER', PAID_PLANS_FAQ_ANSWER],
      ['PAID_PLAN_SUMMARY', PAID_PLAN_SUMMARY],
      ['planCatalogPriceText', planCatalogPriceText()],
      ['STORE_SUBSCRIPTION_DELETION_NOTICE', STORE_SUBSCRIPTION_DELETION_NOTICE],
      ['ORG_PLAN_DISPLAY_NAME', ORG_PLAN_DISPLAY_NAME],
      ['PAID_PLAN_GENERIC_DISPLAY_NAME', PAID_PLAN_GENERIC_DISPLAY_NAME],
      ['CANCEL_SCHEDULED_WITHOUT_DATE_TEXT_WIRE', CANCEL_SCHEDULED_WITHOUT_DATE_TEXT_WIRE],
      ...Object.entries(SUBSCRIPTION_STATUS_TEXT_WIRE).map(([status, text]): [string, string] => [`SUBSCRIPTION_STATUS_TEXT_WIRE.${status}`, text]),
    ];
    for (const [name, text] of texts) {
      expect(text.length, name).toBeGreaterThan(0);
      for (const word of UNFINISHED_WORDS) expect(text, `${name}: ${word}`).not.toContain(word);
    }
    expect(FREE_PLAN_AI_LIMIT_NOTE).toContain(AI_DAILY_LIMIT_PHRASE);
    expect(FREE_PLAN_FAQ_ANSWER).toContain(AI_DAILY_LIMIT_PHRASE);
  });

  it('every PLAN_CATALOG plan has exactly one 料理画像の作成 feature line, which says the image is made for the main dish (主菜) and contains none of UNFINISHED_WORDS', () => {
    for (const plan of PLAN_CATALOG) {
      const lines = plan.features.filter((feature) => feature.startsWith('料理画像の作成'));
      expect(lines, plan.plan_key).toHaveLength(1);
      expect(lines[0], plan.plan_key).toContain('主菜');
      for (const word of UNFINISHED_WORDS) expect(lines[0], `${plan.plan_key}: ${word}`).not.toContain(word);
    }
  });
});

/** /faq のソースから、質問 q の答え a を読む (1 項目は 1 行に { category, q, a } で書き、a は一重引用符の文字列。tests/faq-guide-wording-1859.test.ts と同じ読み方) */
function faqAnswerOf(source: string, q: string): string | null {
  const line = source.split('\n').find((l) => l.includes(`q: '${q}'`));
  if (line === undefined) return null;
  return /a:\s*'([^']*)'/.exec(line)?.[1] ?? null;
}

describe('billing/03 §10.5 /faq の料金の答えは @homegohan/shared の文の写し (テスト 37 の後半)', () => {
  it('src/app/faq/page.tsx holds FREE_PLAN_FAQ_ANSWER and PAID_PLANS_FAQ_ANSWER verbatim as the a of 料金はかかりますか？ and 有料プランはありますか？', () => {
    const faq = fs.readFileSync(path.join(ROOT, 'src/app/faq/page.tsx'), 'utf8');
    expect(faqAnswerOf(faq, '料金はかかりますか？')).toBe(FREE_PLAN_FAQ_ANSWER);
    expect(faqAnswerOf(faq, '有料プランはありますか？')).toBe(PAID_PLANS_FAQ_ANSWER);
    // 価格の文字列そのもの (定数を変えたのに写しを直し忘れたら、上の一致で赤になる。ここは値の確かめ)
    expect(PAID_PLANS_FAQ_ANSWER).toContain('個人 Pro (月額 580円 / 年額 5,800円)');
  });
});

/** 退会の入口 (退会の API を呼ぶファイル。billing/03 §10.4 の表の 4 つ) */
const ACCOUNT_DELETION_ENTRY_FILES = [
  'apps/mobile/app/settings/account.tsx',
  'src/app/(main)/settings/page.tsx',
  'src/app/legal-consent/LegalConsentForm.tsx',
  'src/components/account/AccountSelfServicePanel.tsx',
] as const;

/** dir の下の .ts / .tsx を全部 (node_modules とテストのディレクトリ __tests__ は除く)。パスはリポジトリの根からの相対 */
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(child);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(child);
      }
    }
  };
  walk(dir);
  return out;
}

describe('billing/03 §10.4 退会の入口にストアの購読の文 (テスト 127・S35)', () => {
  it('the account deletion entry points are exactly the 3 files under src/app and src/components that call deleteOwnAccount( and the 1 file under apps/mobile/app that posts "/api/account/delete", each imports STORE_SUBSCRIPTION_DELETION_NOTICE from @homegohan/shared and uses it, and the notice contains none of UNFINISHED_WORDS', () => {
    const webEntries = [...sourceFilesUnder('src/app'), ...sourceFilesUnder('src/components')].filter((file) =>
      fs.readFileSync(path.join(ROOT, file), 'utf8').includes('deleteOwnAccount('),
    );
    const mobileEntries = sourceFilesUnder('apps/mobile/app').filter((file) =>
      fs.readFileSync(path.join(ROOT, file), 'utf8').includes('"/api/account/delete"'),
    );
    expect([...webEntries, ...mobileEntries].sort()).toEqual([...ACCOUNT_DELETION_ENTRY_FILES].sort());
    expect(webEntries).toHaveLength(3);
    expect(mobileEntries).toHaveLength(1);

    for (const file of ACCOUNT_DELETION_ENTRY_FILES) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const importLine = source
        .split('\n')
        .find((line) => /^import\s/.test(line) && line.includes('STORE_SUBSCRIPTION_DELETION_NOTICE') && /from\s+["']@homegohan\/shared["']/.test(line));
      expect(importLine, `${file} が @homegohan/shared から STORE_SUBSCRIPTION_DELETION_NOTICE を import していない`).toBeDefined();
      // 使う = import の行の外にも名前がもう 1 回以上ある
      const outsideImport = source.replace(importLine!, '');
      expect(outsideImport, `${file} が STORE_SUBSCRIPTION_DELETION_NOTICE を使っていない`).toContain('STORE_SUBSCRIPTION_DELETION_NOTICE');
      // 文をファイルに直接書かない
      expect(source, `${file} が文を直接書いている`).not.toContain(STORE_SUBSCRIPTION_DELETION_NOTICE);
    }
    for (const word of UNFINISHED_WORDS) expect(STORE_SUBSCRIPTION_DELETION_NOTICE, word).not.toContain(word);
  });
});
