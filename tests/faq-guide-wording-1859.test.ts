// @vitest-environment node
/**
 * #1859: よくある質問 (/faq) と使い方ガイド (/guide) の言葉が、今の画面の文言とずれないことの見張り
 *
 * 以前の /faq は「メニュー画面から「AIに献立を提案してもらう」をタップ」「予算や調理時間などの条件」と書いていたが、
 * 今の献立表の画面のボタンは「AI献立アシスタント」(空欄があるときは「AIに埋めてもらう」) で、
 * 条件の選択肢 (V4 のモーダル) に予算・調理時間は無い。使い方ガイドは #1852 で画面に合わせて直してあった。
 *
 *   1. 画面に無い言い回しが、FAQ とガイドに戻らないこと
 *   2. FAQ とガイドが「」で名前を挙げる画面の項目 (ボタン名など) が、画面のソースの文言に実在すること
 *      (#1870: Web の名前は Web の画面のソース、モバイルアプリの名前はアプリのソースで確かめる。
 *       文の中の「Web版では」「モバイルアプリでは」で、その後ろの名前がどちらの画面のものかを決める。決まりは platformOfQuotedNames)
 *   3. FAQ とガイドが挙げる献立の条件の名前が、条件の選択肢 (V4 のモーダル) に実在すること
 *   4. (#1870) FAQ が挙げる献立の提案の基準が、献立の生成の実コードで使われていること
 *   5. (#1870) FAQ のデータの削除の手順が、請求の画面で送信に要る項目 (請求の種類・請求の内容) をすべて案内していること
 *
 * 画面の文言を変えたら、FAQ (src/app/faq/page.tsx) とガイド (src/app/guide/guide-content.ts) も見直す。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDES } from '@/app/guide/guide-content';

const ROOT = path.resolve(__dirname, '..');
const FAQ_FILE = 'src/app/faq/page.tsx';
const GUIDE_FILE = 'src/app/guide/guide-content.ts';
/** 献立の条件の選択肢 (Web の V4 のモーダル。モバイルの献立のタブは同じ Web の画面を WebView で出す) */
const V4_MODAL_FILE = 'src/components/ai-assistant/V4GenerateModal.tsx';

/** 画面のソースを探す場所 (FAQ とガイドそのもの・API・テストは除く)。Web とモバイルアプリで分ける (#1870) */
const WEB_SCREEN_SOURCE_DIRS = ['src/app', 'src/components', 'src/hooks'];
const MOBILE_SCREEN_SOURCE_DIRS = ['apps/mobile/app', 'apps/mobile/src'];
/**
 * Web とアプリで共用する画面の文言の定数を置く場所 (例: 請求の入口の見出し DSR_SETTINGS_ENTRY_TITLE)。
 * ここの `export const 名前 = '文'` の文は、その名前を画面のソースが使っている側 (Web / アプリ) の文言として数える
 */
const SHARED_CONSTANT_DIRS = ['packages/shared/src'];
const SCREEN_SOURCE_EXCLUDED_DIRS = ['src/app/faq', 'src/app/guide', 'src/app/api', '__tests__', 'node_modules'];
const SCREEN_SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/**
 * FAQ の項目数の下限 (読み取りが空振りしていないことの確かめ。2026-10-17 時点で 28 項目)。
 * 項目を減らしたときはこの値も見直す
 */
const MIN_FAQ_ENTRY_COUNT = 20;

/** FAQ とガイドのどこにも書いてはいけない言い回しと、その理由 */
const FORBIDDEN_PHRASES: { text: string; reason: string }[] = [
  { text: 'AIに献立を提案してもらう', reason: '画面のボタンは「AI献立アシスタント」(空欄があるときは「AIに埋めてもらう」)' },
  { text: 'メニュー画面', reason: '献立の画面の名前は「献立」(ナビゲーション) / 「献立表」' },
  {
    text: '設定画面からいつでもデータを削除できます',
    reason: '設定画面にデータだけを消す項目は無い。あるのはアカウントの削除と「開示・訂正・利用停止の請求」(消去の請求) (#1870)',
  },
];

/** 文の中で、後ろの名前がどちらの画面のものかを示す言葉 (#1870) */
const PLATFORM_MARKERS: { text: string; platform: Platform }[] = [
  { text: 'Web版では', platform: 'web' },
  { text: 'モバイルアプリでは', platform: 'mobile' },
];
/** 文の区切り (ここで、名前の画面は既定の Web に戻る) */
const SENTENCE_END = '。';
/** 括弧 (中で変えた画面は、括弧を閉じたら外の画面に戻る) */
const OPEN_PARENS = ['（', '('];
const CLOSE_PARENS = ['）', ')'];

/**
 * FAQ の答えにある名前を、Web とアプリでそれぞれ確かめる項目 (書き分けが見張りから漏れていないことの確かめ)。
 * Web の名前とアプリの名前が違うものは、どちらの画面のソースで確かめたかがここで決まる
 */
const PLATFORM_NAMED_IN_FAQ: { q: string; web: string[]; mobile: string[] }[] = [
  {
    q: 'データをエクスポートできますか？',
    web: ['データとプライバシー', 'データをエクスポート', '献立をCSVエクスポート'],
    mobile: ['データとプライバシー', 'JSONでエクスポート', 'CSVでエクスポート'],
  },
  {
    q: 'データを削除できますか？',
    web: ['データとプライバシー', '開示・訂正・利用停止の請求', '請求の内容'],
    mobile: ['アカウント', 'アカウント管理', '開示・訂正・利用停止の請求'],
  },
  { q: 'パスワードを忘れました', web: ['忘れた場合'], mobile: ['パスワードを忘れた？'] },
];

/**
 * FAQ「献立提案はどういう基準で作られますか？」が挙げる情報と、献立の生成でそれを使っている実コード (#1870)。
 * 答えに書いた言葉 (inAnswer) があり、根拠のファイル (file) のコメントを除いたソースに needle があること
 */
const MENU_CRITERIA_EVIDENCE: { inAnswer: string; file: string; needle: string }[] = [
  { inAnswer: 'アレルギー', file: 'supabase/functions/_shared/user-context.ts', needle: 'diet_flags?.allergies' },
  { inAnswer: '苦手な食材', file: 'supabase/functions/_shared/user-context.ts', needle: 'diet_flags?.dislikes' },
  { inAnswer: '好きな食材', file: 'supabase/functions/_shared/user-context.ts', needle: 'favorite_ingredients' },
  { inAnswer: '料理のジャンル', file: 'supabase/functions/_shared/user-context.ts', needle: 'cuisine_preferences' },
  { inAnswer: '持病', file: 'supabase/functions/_shared/user-context.ts', needle: 'p?.health_conditions' },
  { inAnswer: '目標', file: 'supabase/functions/_shared/user-context.ts', needle: 'p?.nutrition_goal' },
  { inAnswer: '健康診断の結果', file: 'supabase/functions/generate-menu-v4/index.ts', needle: '.from("health_checkups")' },
  { inAnswer: '健康診断の結果', file: 'supabase/functions/generate-menu-v5/index.ts', needle: '.from("health_checkups")' },
  { inAnswer: '冷蔵庫の食材', file: 'supabase/functions/generate-menu-v4/index.ts', needle: '.from("pantry_items")' },
  { inAnswer: '冷蔵庫の食材', file: 'supabase/functions/generate-menu-v5/index.ts', needle: '.from("pantry_items")' },
  { inAnswer: '前後の日の献立', file: 'supabase/functions/generate-menu-v4/index.ts', needle: 'selectRecentMenusForVariety({' },
  { inAnswer: '前後の日の献立', file: 'supabase/functions/generate-menu-v5/index.ts', needle: 'selectRecentMenusForVariety({' },
  // 記録した食事は planned_meals の is_completed = true の行 (写真からの記録も planned_meals に入る)。前後の日の献立を読むときに一緒に読む
  { inAnswer: '記録した食事', file: 'supabase/functions/generate-menu-v4/index.ts', needle: 'status: meal.is_completed ? "completed"' },
  { inAnswer: '記録した食事', file: 'supabase/functions/generate-menu-v5/index.ts', needle: 'status: meal.is_completed ? "completed"' },
];
const MENU_CRITERIA_QUESTION = '献立提案はどういう基準で作られますか？';

/** 消去などを請求する Web の画面 (FAQ「データを削除できますか？」が手順を案内する画面) */
const DSR_FORM_FILE = 'src/app/(main)/settings/data-requests/page.tsx';
const DATA_DELETION_QUESTION = 'データを削除できますか？';
/**
 * 請求の画面で、送信ボタンを押せるようになるまでに入れる項目 (#1870)。
 * name は画面の見出し (legend / label)、guard は送信できるかの式 (canSubmit) にあるその項目の条件。
 * FAQ の手順がどれかを書き落とすと、手順どおりに操作してもボタンが押せないまま止まる
 */
const DSR_FORM_REQUIRED_INPUTS: { name: string; guard: string }[] = [
  { name: '請求の種類', guard: 'requestType !== null' },
  { name: '請求の内容', guard: 'detailsLength > 0' },
];

/** 献立の話の中で書いてはいけない条件 (条件の選択肢に無い) */
const FORBIDDEN_MENU_CONDITIONS = ['予算', '調理時間'];

const readSource = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

type Platform = 'web' | 'mobile';

interface FaqEntry {
  category: string;
  q: string;
  a: string;
}

/** FAQ のページのソースから、項目 (category・q・a) を読み取る */
function readFaqEntries(): { entries: FaqEntry[]; declaredCount: number } {
  const source = readSource(FAQ_FILE);
  const start = source.indexOf('const faqs = [');
  const end = source.indexOf('];', start);
  if (start < 0 || end < 0) throw new Error(`${FAQ_FILE} に const faqs = [ ... ]; が見つからない`);
  const block = source.slice(start, end);
  const entries = [...block.matchAll(/\{\s*category:\s*'([^']+)',\s*q:\s*'([^']*)',\s*a:\s*'([^']*)'\s*\}/g)].map(
    ([, category, q, a]) => ({ category, q, a }),
  );
  const declaredCount = [...block.matchAll(/category:\s*'/g)].length;
  return { entries, declaredCount };
}

/** ガイドの文 (章の題・手順の題・説明・画像の代替テキスト) */
function guideTexts(): { where: string; text: string }[] {
  return GUIDES.flatMap((guide) => [
    { where: `guide ${guide.id} の題`, text: guide.title },
    ...guide.steps.flatMap((step) => [
      { where: `guide ${guide.id}「${step.title}」の題`, text: step.title },
      { where: `guide ${guide.id}「${step.title}」の説明`, text: step.desc },
      { where: `guide ${guide.id}「${step.title}」の画像の代替テキスト`, text: step.imageAlt },
    ]),
  ]);
}

function faqTexts(entries: FaqEntry[]): { where: string; text: string }[] {
  return entries.flatMap((entry) => [
    { where: `faq「${entry.q}」の質問`, text: entry.q },
    { where: `faq「${entry.q}」の答え`, text: entry.a },
  ]);
}

/** 「」で囲んだ名前をすべて取り出す */
function quotedNames(text: string): string[] {
  return [...text.matchAll(/「([^「」]+)」/g)].map(([, name]) => name);
}

/**
 * 「」で囲んだ名前を、どちらの画面 (Web / モバイルアプリ) の名前かと組にして取り出す (#1870)。
 *   - 文の頭は Web (この FAQ とガイドは Web のページ。アプリで違うときは「モバイルアプリでは」と書き分けている)
 *   - 「Web版では」「モバイルアプリでは」の後ろは、その画面の名前
 *   - 括弧の中で変えた画面は、括弧を閉じたら外の画面に戻る (例:「忘れた場合」（モバイルアプリでは「パスワードを忘れた？」）)
 *   - 文の区切り「。」で Web に戻る
 */
function platformOfQuotedNames(text: string): { name: string; platform: Platform }[] {
  const result: { name: string; platform: Platform }[] = [];
  const stack: Platform[] = [];
  let platform: Platform = 'web';
  let i = 0;
  while (i < text.length) {
    const marker = PLATFORM_MARKERS.find((m) => text.startsWith(m.text, i));
    if (marker) {
      platform = marker.platform;
      i += marker.text.length;
      continue;
    }
    const ch = text[i];
    if (ch === '「') {
      const close = text.indexOf('」', i + 1);
      if (close < 0) throw new Error(`「 が閉じていない: ${text}`);
      result.push({ name: text.slice(i + 1, close), platform });
      i = close + 1;
      continue;
    }
    if (OPEN_PARENS.includes(ch)) {
      stack.push(platform);
    } else if (CLOSE_PARENS.includes(ch)) {
      platform = stack.pop() ?? 'web';
    } else if (ch === SENTENCE_END && stack.length === 0) {
      platform = 'web';
    }
    i += 1;
  }
  return result;
}

/** コメント (ブロックと行) を取り除く。コメントにだけ書かれた言葉を「画面の文言」と数えないため */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Web とアプリで共用する定数 (`export const 名前 = '文'`) を、名前 → 文の表にする */
function sharedStringConstants(): Map<string, string> {
  const constants = new Map<string, string>();
  for (const file of SHARED_CONSTANT_DIRS.flatMap(listSourceFiles)) {
    const source = stripComments(readSource(file));
    for (const [, name, , value] of source.matchAll(/export const ([A-Z][A-Z0-9_]*)\s*=\s*(['"])([^'"\n]*)\2/g)) {
      constants.set(name, value);
    }
  }
  return constants;
}

/**
 * 画面のソースの文言 (コメントを除く) に、そのソースが名前で使っている共用の定数の文を足したもの。
 * Web とアプリで別々に作る (#1870)
 */
function screenText(dirs: string[], sharedConstants: Map<string, string>): string {
  const source = dirs
    .flatMap(listSourceFiles)
    .map((file) => stripComments(readSource(file)))
    .join('\n');
  const usedShared = [...sharedConstants]
    .filter(([name]) => new RegExp(`\\b${name}\\b`).test(source))
    .map(([, value]) => value);
  return [source, ...usedShared].join('\n');
}

function listSourceFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const result: string[] = [];
  for (const dirent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, dirent.name);
    if (SCREEN_SOURCE_EXCLUDED_DIRS.some((excluded) => rel === excluded || rel.split(path.sep).includes(excluded))) continue;
    if (dirent.isDirectory()) {
      result.push(...listSourceFiles(rel));
    } else if (SCREEN_SOURCE_EXTENSIONS.includes(path.extname(dirent.name)) && !/\.test\.tsx?$/.test(dirent.name)) {
      result.push(rel);
    }
  }
  return result;
}

describe('#1859 FAQ とガイドの言葉が今の画面と合っている', () => {
  const { entries: faqEntries, declaredCount } = readFaqEntries();
  const allTexts = [...faqTexts(faqEntries), ...guideTexts()];

  it('FAQ の項目をすべて読み取れている (読み取りの空振りで見張りが素通りしない)', () => {
    expect(faqEntries.length).toBe(declaredCount);
    expect(faqEntries.length).toBeGreaterThanOrEqual(MIN_FAQ_ENTRY_COUNT);
  });

  it('画面に無い言い回しが FAQ とガイドに無い', () => {
    for (const { text: phrase, reason } of FORBIDDEN_PHRASES) {
      for (const { where, text } of allTexts) {
        expect(text, `${where} に「${phrase}」がある (${reason})`).not.toContain(phrase);
      }
    }
  });

  it('献立の話 (FAQ の献立の項目・ガイドの献立の章) に、条件の選択肢に無い条件 (予算・調理時間) が無い', () => {
    const menuTexts = [
      ...faqTexts(faqEntries.filter((entry) => entry.q.includes('献立') || entry.a.includes('献立'))),
      ...guideTexts().filter(({ where }) => where.startsWith('guide menu')),
    ];
    expect(menuTexts.length).toBeGreaterThan(0);
    for (const condition of FORBIDDEN_MENU_CONDITIONS) {
      for (const { where, text } of menuTexts) {
        expect(text, `${where} に「${condition}」がある (献立の条件の選択肢に無い)`).not.toContain(condition);
      }
    }
  });

  it('FAQ とガイドが挙げる献立の条件の名前は、条件の選択肢 (V4 のモーダル) に実在する', () => {
    const modal = stripComments(readSource(V4_MODAL_FILE));
    const named = allTexts.flatMap(({ where, text }) =>
      [...text.matchAll(/([^、。（）()]+?)などの条件/g)].flatMap(([, list]) =>
        list.split('・').map((name) => ({ where, name: name.trim() })),
      ),
    );
    // FAQ の「献立提案機能はどう使いますか？」とガイドの「条件を設定」の 2 か所が挙げている
    expect(new Set(named.map(({ where }) => where)).size).toBeGreaterThanOrEqual(2);
    for (const { where, name } of named) {
      expect(modal, `${where} の条件「${name}」が ${V4_MODAL_FILE} の選択肢に無い`).toContain(`label: '${name}'`);
    }
  });

  it('「」の名前の画面 (Web / モバイルアプリ) の決まり: 文の頭は Web・「モバイルアプリでは」の後ろはアプリ・括弧と文の区切りで戻る', () => {
    expect(
      platformOfQuotedNames(
        'Web版では「A」→「B」。モバイルアプリでは「C」を開き（項目は「D」）、「E」へ。「F」（モバイルアプリでは「G」）から「H」。「I」',
      ),
    ).toEqual([
      { name: 'A', platform: 'web' },
      { name: 'B', platform: 'web' },
      { name: 'C', platform: 'mobile' },
      { name: 'D', platform: 'mobile' },
      { name: 'E', platform: 'mobile' },
      { name: 'F', platform: 'web' },
      { name: 'G', platform: 'mobile' },
      { name: 'H', platform: 'web' },
      { name: 'I', platform: 'web' },
    ]);
  });

  it('FAQ とガイドが「」で挙げる画面の項目の名前は、その画面 (Web は Web・モバイルアプリはアプリ) のソースの文言に実在する', () => {
    const sharedConstants = sharedStringConstants();
    // 共用の定数の読み取りが空振りしていない (請求の入口の見出しは packages/shared にだけある)
    expect(sharedConstants.get('DSR_SETTINGS_ENTRY_TITLE')).toBe('開示・訂正・利用停止の請求');
    const sources: Record<Platform, { label: string; text: string }> = {
      web: { label: `Web の画面のソース (${WEB_SCREEN_SOURCE_DIRS.join(', ')})`, text: screenText(WEB_SCREEN_SOURCE_DIRS, sharedConstants) },
      mobile: {
        label: `モバイルアプリのソース (${MOBILE_SCREEN_SOURCE_DIRS.join(', ')})`,
        text: screenText(MOBILE_SCREEN_SOURCE_DIRS, sharedConstants),
      },
    };
    const named = allTexts.flatMap(({ where, text }) =>
      platformOfQuotedNames(text).map(({ name, platform }) => ({ where, name, platform })),
    );
    // 少なくとも、献立表の画面のボタン名と設定画面の項目名を挙げている
    expect(named.filter(({ platform }) => platform === 'web').map(({ name }) => name)).toEqual(
      expect.arrayContaining(['AI献立アシスタント', 'AIに埋めてもらう', 'データをエクスポート']),
    );
    // Web とアプリで書き分けた名前が、それぞれの画面の名前として読み取れている (書き分けが見張りから漏れていない)
    for (const { q, web, mobile } of PLATFORM_NAMED_IN_FAQ) {
      const entry = faqEntries.find((faq) => faq.q === q);
      expect(entry, `${FAQ_FILE} に「${q}」が無い`).toBeDefined();
      const byPlatform = platformOfQuotedNames(entry?.a ?? '');
      const namesOf = (platform: Platform) => byPlatform.filter((n) => n.platform === platform).map(({ name }) => name);
      expect(namesOf('web'), `faq「${q}」の Web の名前`).toEqual(expect.arrayContaining(web));
      expect(namesOf('mobile'), `faq「${q}」のモバイルアプリの名前`).toEqual(expect.arrayContaining(mobile));
    }
    for (const { where, name, platform } of named) {
      expect(sources[platform].text.includes(name), `${where} の「${name}」が ${sources[platform].label} に無い`).toBe(true);
    }
  });

  it('アプリにだけある書き出しの名前 (JSONでエクスポート・CSVでエクスポート) は、Web の画面の名前として書いていない', () => {
    // 見張りが Web とアプリを分けて確かめていることの確かめ: アプリの名前は Web の画面のソースに無い
    const webText = screenText(WEB_SCREEN_SOURCE_DIRS, sharedStringConstants());
    const mobileText = screenText(MOBILE_SCREEN_SOURCE_DIRS, sharedStringConstants());
    for (const name of ['JSONでエクスポート', 'CSVでエクスポート']) {
      expect(webText.includes(name), `「${name}」が Web の画面のソースにある (アプリにだけある名前のはず)`).toBe(false);
      expect(mobileText.includes(name), `「${name}」がモバイルアプリのソースに無い`).toBe(true);
    }
  });

  it('FAQ の献立の提案の基準は、献立の生成の実コードが使う情報だけを挙げる (#1870)', () => {
    const criteria = faqEntries.find((entry) => entry.q === MENU_CRITERIA_QUESTION);
    expect(criteria, `${FAQ_FILE} に「${MENU_CRITERIA_QUESTION}」が無い`).toBeDefined();
    for (const { inAnswer, file, needle } of MENU_CRITERIA_EVIDENCE) {
      expect(criteria?.a, `FAQ の献立の提案の基準に「${inAnswer}」が無い`).toContain(inAnswer);
      expect(stripComments(readSource(file)), `${file} に ${needle} が無い (FAQ の「${inAnswer}」の根拠)`).toContain(needle);
    }
  });

  it('FAQ のデータの削除の手順は、請求の画面で送信に要る項目 (請求の種類・請求の内容) をすべて案内する (#1870)', () => {
    const deletion = faqEntries.find((entry) => entry.q === DATA_DELETION_QUESTION);
    expect(deletion, `${FAQ_FILE} に「${DATA_DELETION_QUESTION}」が無い`).toBeDefined();
    const form = stripComments(readSource(DSR_FORM_FILE));
    const canSubmit = form.match(/const canSubmit\s*=([^;]+);/)?.[1];
    expect(canSubmit, `${DSR_FORM_FILE} に const canSubmit = ...; が無い`).toBeDefined();
    for (const { name, guard } of DSR_FORM_REQUIRED_INPUTS) {
      // 画面の側: その項目が見出しとしてあり、送信の条件に入っている (画面が変わったら FAQ の手順も見直す)
      expect(form, `${DSR_FORM_FILE} に見出し「${name}」が無い`).toContain(name);
      expect(canSubmit, `${DSR_FORM_FILE} の canSubmit に「${name}」の条件 ${guard} が無い`).toContain(guard);
      // FAQ の側: 手順にその項目がある
      expect(deletion?.a, `FAQ「${DATA_DELETION_QUESTION}」の手順に「${name}」が無い (送信ボタンが押せないまま止まる)`).toContain(name);
    }
  });

  it('FAQ の献立の使い方は、ガイドと同じ画面の名前 (献立表の「AI献立アシスタント」) を案内する', () => {
    const howTo = faqEntries.find((entry) => entry.q === '献立提案機能はどう使いますか？');
    expect(howTo, `${FAQ_FILE} に「献立提案機能はどう使いますか？」が無い`).toBeDefined();
    const guideRequest = GUIDES.find((guide) => guide.id === 'menu')?.steps[0];
    expect(guideRequest, `${GUIDE_FILE} に献立の章の最初の手順が無い`).toBeDefined();
    for (const name of quotedNames(guideRequest?.desc ?? '')) {
      expect(howTo?.a, `FAQ の献立の使い方に、ガイドが挙げる「${name}」が無い`).toContain(`「${name}」`);
    }
    expect(howTo?.a).toContain('献立表');
  });
});
