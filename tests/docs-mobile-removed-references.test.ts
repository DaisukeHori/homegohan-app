/**
 * #1598 CLAUDE.md と apps/mobile/README.md は、消したモバイルのネイティブの画面・部品・関数を、いまアプリにあるものとして書かない
 *
 * #1598 の続きで、通常の操作で届かないネイティブの画面 (週の献立・買い物リスト・全画面の AI 相談・運営の画面など) と、
 * それだけが使う部品・関数を消した。CLAUDE.md は、そのあとも次のように、消したものをアプリの手順として書いていた
 * (このテストの FORMER_TEXTS に元の文を置き、見張りがそれを捕まえることを確かめる)。
 *   - 「アプリは `apps/mobile/src/lib/menu-request-error.ts` の `menuRequestErrorMessageForDisplay` /
 *     `shoppingListRequestErrorMessageForDisplay` を通す」(後者はアプリから消した。Web には同じ名前が残る)
 *   - 「`getApi()` を通らない生の fetch (ストリーミングの AI 相談の送信・1 食の作り直し)」(1 食の作り直しのモーダルは消した)
 *   - 「アプリ (apps/mobile) は … fetch を直接使うなら `isAiConsentRequiredResponse`」(アプリから消した。Web には同じ名前が残る)
 * Web に同じ名前が残るので、名前で grep すると見つかってしまい、古い記述に気づけない。ここで落とす。
 *   1. 文書が名指しする `apps/mobile/<ファイル>` は有る (同じ行で消したことを書いた行は除く)
 *   2. 「`apps/mobile/<ファイル>` の `名前` / `名前`」と書いた名前は、そのファイルが export している
 *   3. アプリについて書いた部分 (「Web」の語が無い文は、「アプリ」「モバイル」「apps/mobile」のどれかがあれば文の全体。
 *      「Web」の語がある文は、アプリの語から次の「Web」か文の終わりまで) に、
 *      #1598 でアプリから消した名前 (Web や共有の側に同じ名前が残るもの) と、消した操作の呼び名を書かない
 *      (同じ文で消したことを書いた文は除く)
 * この検査の限界: 3 は「アプリの話はアプリの語から始まり、Web の話は Web の語から始まる」というよくある書き方の見張りで、
 * 網羅はしない (「Web アプリ」のようにアプリの語が Web を指す文は、消した名前を書かない限り落ちない)。
 * 設計書 (docs/design/) は tests/design-doc-removed-mobile-screens.test.ts が受け持つ。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
/** 見張る文書 (リポジトリの根からの相対) */
const DOCS = ['CLAUDE.md', 'apps/mobile/README.md'] as const;

/** 消したことを書いた行・文の目印 */
const REMOVAL_NOTE = /削除|消した/;

/** 文書が名指しするモバイルのファイル (`apps/mobile/...` のうち、ソースや設定の拡張子を持つもの。node_modules・.env は数えない) */
const MOBILE_FILE_MENTION = /`(apps\/mobile\/[^`\s]+\.(?:tsx?|jsx?|json|ya?ml|md|sh))`/g;

/** 「`apps/mobile/<ファイル>.ts(x)` の `名前` / `名前`」の書き方 */
const MOBILE_EXPORT_MENTION = /`(apps\/mobile\/[^`\s]+\.tsx?)` の ((?:`[A-Za-z_$][\w$]*`)(?: \/ `[A-Za-z_$][\w$]*`)*)/g;

/**
 * #1598 でアプリ (apps/mobile) から消し、Web や共有の側 (src/・packages/・supabase/functions/_shared/・types/) に
 * 同じ名前が残るもの。名前で grep すると Web の側が見つかるので、アプリの記述に残っていても気づけない
 */
const MOBILE_NAMES_REMOVED_IN_1598 = [
  'AddFridgeModal',
  'AddMealModal',
  'AddMealSlotModal',
  'AddShoppingModal',
  'BadgesPage',
  'ConfirmDeleteModal',
  'DishIconKey',
  'FEEDBACK_ERROR_MESSAGE',
  'FEEDBACK_MAX_POLLS',
  'FEEDBACK_POLL_INTERVAL_MS',
  'FEEDBACK_TIMEOUT_MESSAGE',
  'FeedbackRealtimeClient',
  'fetchSignedPhotoUrls',
  'getSignedPhotoUrlResolver',
  'HealthChallengesPage',
  'HealthGoalsPage',
  'HealthGraphsPage',
  'HealthInsightsPage',
  'HealthSettingsPage',
  'ICON_MAP_LUCIDE',
  'ImproveMealModal',
  'isAiConsentRequiredResponse',
  'isOrgAdmin',
  'ManualEditModal',
  'MealDetailPage',
  'NutritionDetailModal',
  'NutritionFeedbackContent',
  'NutritionFeedbackRequest',
  'NutritionFeedbackWatchHandlers',
  'NutritionTotals',
  'ORG_ADMIN_ROLES',
  'OrgAdminRole',
  'OrgChallengesPage',
  'OrgDashboardPage',
  'OrgDepartmentsPage',
  'OrgInvitesPage',
  'OrgLayout',
  'OrgSettingsPage',
  'PantryItem',
  'PantryPage',
  'PhotoEditModal',
  'ProgressTodoCard',
  'QuantityVariant',
  'RecipeModal',
  'RegenerateMealModal',
  'ServingsConfig',
  'ServingsModal',
  'shoppingListRequestErrorMessageForDisplay',
  'SignedPhotoImage',
  'SignedPhotoImageProps',
  'StatsModal',
  'SuperAdminLayout',
  'SupportInquiriesPage',
  'SupportLayout',
  'SupportUsersPage',
  'useNutritionFeedbackWatch',
  'useSignedPhotoUrl',
  'watchNutritionFeedback',
  'WatchNutritionFeedbackOptions',
  'WeeklyMenuPage',
] as const;

/** #1598 で消した操作の呼び名 (アプリの記述に、いまある操作として書かない) */
const REMOVED_MOBILE_OPERATION_WORDS = ['1 食の作り直し'] as const;

/** アプリについて書いた部分の始まりの語と、Web の話に移る語 */
const APP_MARKER = /アプリ|モバイル|apps\/mobile/;
const WEB_MARKER = /Web/;

/** 消した名前・呼び名を、アプリについて書いた部分の中で見つける */
function removedNamesInAppParts(text: string): string[] {
  const found: string[] = [];
  for (const sentence of text.split(/。|\n/)) {
    if (REMOVAL_NOTE.test(sentence)) continue;
    for (const part of appParts(sentence)) {
      for (const name of MOBILE_NAMES_REMOVED_IN_1598) {
        if (new RegExp(`\`${name}[\`(]`).test(part)) found.push(name);
      }
      for (const word of REMOVED_MOBILE_OPERATION_WORDS) {
        if (part.includes(word)) found.push(word);
      }
    }
  }
  return found;
}

/**
 * 文の中の、アプリについて書いた部分。Web の語が無い文は、アプリの語があれば文の全体 (アプリの語の前の
 * 「`getApi()` を通らない生の fetch (…) は、… `apps/mobile/…`」のような書き方も拾う)。Web の語がある文は、
 * アプリの語から次の Web の語 (無ければ文の終わり) までの部分
 */
function appParts(sentence: string): string[] {
  if (!WEB_MARKER.test(sentence)) return APP_MARKER.test(sentence) ? [sentence] : [];
  const parts: string[] = [];
  let rest = sentence;
  for (;;) {
    const start = rest.search(APP_MARKER);
    if (start < 0) return parts;
    const afterStart = rest.slice(start);
    const end = afterStart.search(WEB_MARKER);
    parts.push(end < 0 ? afterStart : afterStart.slice(0, end));
    if (end < 0) return parts;
    rest = afterStart.slice(end);
  }
}

/** 「`apps/mobile/<ファイル>` の `名前`」と書いた名前のうち、そのファイルが export していないもの */
function missingExports(text: string): string[] {
  const missing: string[] = [];
  for (const match of text.matchAll(MOBILE_EXPORT_MENTION)) {
    const [, file, names] = match;
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) {
      missing.push(`${file} (ファイルが無い)`);
      continue;
    }
    const source = fs.readFileSync(full, 'utf8');
    for (const name of names.match(/`[^`]+`/g) ?? []) {
      const bare = name.slice(1, -1);
      const exported = new RegExp(
        `export\\s+(?:default\\s+)?(?:async\\s+)?(?:function|const|let|class|interface|type|enum)\\s+${bare}\\b|export\\s*\\{[^}]*\\b${bare}\\b[^}]*\\}`,
      ).test(source);
      if (!exported) missing.push(`${file} の ${bare}`);
    }
  }
  return missing;
}

/** #1598 の前に CLAUDE.md が書いていた文 (見張りがこれを捕まえることを確かめる) */
const FORMER_TEXTS = {
  menuRequestError:
    'Realtime や直接の select で行を受ける画面 (フック `useV4MenuGeneration`・週の献立の画面・買い物リストの画面) は、Web は `weeklyMenuRequestErrorMessageForDisplay` / `shoppingListRequestErrorMessageForDisplay`、アプリは `apps/mobile/src/lib/menu-request-error.ts` の `menuRequestErrorMessageForDisplay` / `shoppingListRequestErrorMessageForDisplay` を通す (#1576。`tests/request-error-display-screens.test.ts` が画面のソースを見張る)。',
  rawFetch:
    'モバイルは `getApi()` がこの Error を固定の文の `AiDailyLimitError` に置き換える (生の文字列を出さない)。`getApi()` を通らない生の fetch (ストリーミングの AI 相談の送信・1 食の作り直し) は、失敗の応答から `errorOfFailedResponse` (`apps/mobile/src/lib/failed-response.ts`。503 の緊急停止・メンテナンス中も同じ関数で固定の文にする) で Error を作って投げる。',
  consent:
    'アプリ (apps/mobile) は、AI の API を呼ぶ関数の中で `src/lib/ai-consent.ts` の `handleAiConsentRequiredError` (自動で送る処理は `isAiConsentRequiredError`、fetch を直接使うなら `isAiConsentRequiredResponse`) を呼んで同意画面へ案内する。',
} as const;

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('#1598 CLAUDE.md と apps/mobile/README.md は、消したモバイルの画面・部品・関数を、いまアプリにあるものとして書かない', () => {
  describe('見張りの形 (元の文を捕まえ、Web の記述は捕まえない)', () => {
    it('「apps/mobile のファイル の 名前」: アプリから消した export を名指しした元の文を捕まえる', () => {
      expect(missingExports(FORMER_TEXTS.menuRequestError)).toEqual([
        'apps/mobile/src/lib/menu-request-error.ts の shoppingListRequestErrorMessageForDisplay',
      ]);
    });

    it('アプリの記述の中の消した名前・呼び名: 元の文 3 つを捕まえる', () => {
      expect(removedNamesInAppParts(FORMER_TEXTS.menuRequestError)).toEqual(['shoppingListRequestErrorMessageForDisplay']);
      expect(removedNamesInAppParts(FORMER_TEXTS.rawFetch)).toEqual(['1 食の作り直し']);
      expect(removedNamesInAppParts(FORMER_TEXTS.consent)).toEqual(['isAiConsentRequiredResponse']);
    });

    it('Web の記述と、消したことを書いた文は捕まえない', () => {
      expect(
        removedNamesInAppParts(
          '利用者の操作で AI に送る fetch は `aiFetch` を使い、`isAiConsentRequiredResponse(res)` なら自分のエラー表示を出さない。',
        ),
      ).toEqual([]);
      expect(
        removedNamesInAppParts(
          '画面は、Web は `shoppingListRequestErrorMessageForDisplay`、アプリは `menuRequestErrorMessageForDisplay` を通す。',
        ),
      ).toEqual([]);
      expect(removedNamesInAppParts('アプリの `RegenerateMealModal` は #1598 で消した。')).toEqual([]);
    });
  });

  describe.each(DOCS)('%s', (doc) => {
    const text = read(doc);

    it('名指しする apps/mobile のファイルは有る (同じ行で消したことを書いた行は除く)', () => {
      const missing = text
        .split('\n')
        .filter((line) => !REMOVAL_NOTE.test(line))
        .flatMap((line) => [...line.matchAll(MOBILE_FILE_MENTION)].map((match) => match[1]))
        .filter((file) => !fs.existsSync(path.join(ROOT, file)));
      expect(missing).toEqual([]);
    });

    it('「apps/mobile のファイル の 名前」と書いた名前は、そのファイルが export している', () => {
      expect(missingExports(text)).toEqual([]);
    });

    it('アプリについて書いた部分に、#1598 でアプリから消した名前・操作を書かない', () => {
      expect(removedNamesInAppParts(text)).toEqual([]);
    });
  });

  describe('走査が空振りしていない', () => {
    const claude = read('CLAUDE.md');

    it('CLAUDE.md の apps/mobile のファイルの名指しを見つける', () => {
      expect([...claude.matchAll(MOBILE_FILE_MENTION)].length).toBeGreaterThan(0);
    });

    it('CLAUDE.md の「apps/mobile/src/lib/menu-request-error.ts の menuRequestErrorMessageForDisplay」を見つける', () => {
      const files = [...claude.matchAll(MOBILE_EXPORT_MENTION)].map((match) => match[1]);
      expect(files).toContain('apps/mobile/src/lib/menu-request-error.ts');
    });

    it('CLAUDE.md の、アプリについて書いた部分を見つける', () => {
      const parts = claude.split(/。|\n/).flatMap((sentence) => appParts(sentence));
      expect(parts.length).toBeGreaterThan(0);
    });
  });
});
