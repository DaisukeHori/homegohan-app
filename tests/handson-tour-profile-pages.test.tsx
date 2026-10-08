/**
 * #1040 / #1306 ハンズオンツアー (Step1 写真 / Step2 献立) の吹き出しに差し込むプロフィール情報のテスト
 *
 * 従来の問題:
 *   - Step2 (src/app/handson-tour/menu/page.tsx) が user_profiles.allergies / dislikes を select
 *   - Step1 (src/app/handson-tour/photo/page.tsx) が user_profiles.target_kcal_per_day を select
 *   どれも存在しない列なので PostgREST は 42703 で失敗するが、error を見ていなかったため、
 *   ニックネーム・除外食材・目標カロリーのパーソナライズが全員分「空」のままだった。
 *
 * 実際の保存先:
 *   - アレルギー・苦手な食材: user_profiles.diet_flags (jsonb) の allergies / dislikes
 *   - 目標カロリー: nutrition_targets.daily_calories
 *
 * ここでは、存在しない列を select / filter すると 42703 を返すフェイク (tests/helpers/fake-tour-profile-db.ts)
 * の上でページを描画し、吹き出しに実データが出ること・取得失敗が記録されることを確認する。
 * 吹き出しとスポットライトの描画 (framer-motion / focus-trap) はこのテストの関心外なので、
 * TourSandboxWrapper は吹き出しの文言とボタンだけを出す差し替えにしている。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeTourDb, pgError, type FakeTourDb } from './helpers/fake-tour-profile-db';
import { splitTopLevel, parseSelectItem } from './helpers/select-columns';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  fireAnalytics: vi.fn(),
  logToServer: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@/lib/db-logger', () => ({
  logToServer: mocks.logToServer,
}));

vi.mock('@homegohan/handson-tour-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@homegohan/handson-tour-shared')>()),
  fireAnalytics: mocks.fireAnalytics,
}));

vi.mock('@/components/handson-tour/TourSandboxWrapper', () => ({
  TourSandboxWrapper: ({ overlay }: { overlay: any }) => (
    <div>
      <p data-testid="bubble-title">{overlay.bubble.title ?? ''}</p>
      <p data-testid="bubble-body">{overlay.bubble.body}</p>
      {overlay.primaryAction && (
        <button data-testid="primary" onClick={overlay.primaryAction.onPress}>
          {overlay.primaryAction.label}
        </button>
      )}
      {overlay.onAutoAdvance && (
        <button data-testid="auto-advance" onClick={overlay.onAutoAdvance}>
          auto
        </button>
      )}
    </div>
  ),
}));

const { default: HandsonTourMenuPage } = await import('@/app/handson-tour/menu/page');
const { default: HandsonTourPhotoPage } = await import('@/app/handson-tour/photo/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/** 描画し、auth.getUser → プロフィール取得 → setState までを流し切る (strict: 開発時の StrictMode で包む) */
async function mountPage(Page: () => React.ReactElement, { strict = false } = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(strict ? <StrictMode><Page /></StrictMode> : <Page />);
  });
  await flush();
}

/** 解決済みの Promise の連鎖 (フェイクの DB 応答 → setState) を流し切る */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function byTestId(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

async function click(testId: string) {
  const el = byTestId(testId);
  expect(el, `${testId} が見つからない`).not.toBeNull();
  await act(async () => {
    el!.click();
  });
}

function bubbleTitle(): string {
  return byTestId('bubble-title')?.textContent ?? '';
}

function bubbleBody(): string {
  return byTestId('bubble-body')?.textContent ?? '';
}

/** Step2: 2.1(自動) → 2.2 → 2.3 → 2.4(生成する) → 2.5(自動) → 2.6(結果の吹き出し) */
async function advanceMenuToResult() {
  await click('auto-advance');
  await click('primary');
  await click('primary');
  await click('primary');
  await click('auto-advance');
}

/** Step1: 1.1 → 1.2 → 1.3 → 1.4 → 1.5(結果の吹き出し) はすべて自動送り */
async function advancePhotoToResult() {
  for (let i = 0; i < 4; i += 1) await click('auto-advance');
}

/** page が select した列名 (エイリアス等は外す) */
function selectedColumns(select: string): string[] {
  return splitTopLevel(select)
    .map((item) => parseSelectItem(item)?.name)
    .filter((name): name is string => Boolean(name));
}

function tourErrorEvents() {
  return mocks.fireAnalytics.mock.calls.filter(([name]) => name === 'handson_tour_step_error');
}

let db: FakeTourDb;

function useDb(options: Parameters<typeof createFakeTourDb>[0]) {
  db = createFakeTourDb(options);
  mocks.createClient.mockReturnValue(db.supabase);
}

beforeEach(() => {
  mocks.createClient.mockReset();
  mocks.fireAnalytics.mockReset();
  mocks.logToServer.mockReset();
  mocks.push.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('Step2 献立ツアー: プロフィールの取得と吹き出し (#1040)', () => {
  it('存在する列だけを select する (user_profiles は id で絞り、diet_flags から除外食材を読む)', async () => {
    useDb({ profile: { nickname: 'はなこ' } });
    await mountPage(HandsonTourMenuPage);

    expect(db.schemaViolations).toEqual([]);
    expect(db.queries).toHaveLength(1);
    const [query] = db.queries;
    expect(query.table).toBe('user_profiles');
    expect(selectedColumns(query.select).sort()).toEqual(['cooking_experience', 'diet_flags', 'nickname']);
    expect(query.filters).toEqual([['id', db.userId]]);
  });

  it('diet_flags のアレルギー・苦手な食材と料理経験、ニックネームを吹き出しに出す', async () => {
    useDb({
      profile: {
        nickname: 'はなこ',
        diet_flags: { allergies: ['えび', '卵'], dislikes: ['セロリ'] },
        cooking_experience: 'advanced',
      },
    });
    await mountPage(HandsonTourMenuPage);
    await advanceMenuToResult();

    expect(bubbleTitle()).toBe('はなこ さんに合わせた献立');
    expect(bubbleBody()).toBe('えび・卵・セロリ は除外、シェフの腕前を活かせる の手順');
    expect(tourErrorEvents()).toEqual([]);
    expect(mocks.logToServer).not.toHaveBeenCalled();
  });

  it('除外食材は先頭 3 件まで (アレルギー → 苦手な食材の順)', async () => {
    useDb({
      profile: {
        diet_flags: { allergies: ['えび', '卵'], dislikes: ['セロリ', 'ピーマン'] },
        cooking_experience: 'intermediate',
      },
    });
    await mountPage(HandsonTourMenuPage);
    await advanceMenuToResult();

    expect(bubbleBody()).toBe('えび・卵・セロリ は除外、いつもの手順で作れる の手順');
  });

  it('diet_flags が未設定 (NULL) なら除外食材なしの文言にして、取得失敗とは扱わない', async () => {
    useDb({ profile: { nickname: 'はなこ', diet_flags: null, cooking_experience: 'beginner' } });
    await mountPage(HandsonTourMenuPage);
    await advanceMenuToResult();

    expect(bubbleTitle()).toBe('はなこ さんに合わせた献立');
    expect(bubbleBody()).toBe('初心者でも作れる の手順');
    expect(tourErrorEvents()).toEqual([]);
    expect(mocks.logToServer).not.toHaveBeenCalled();
  });

  it('プロフィールの行が無くても (null) 既定の文言で進み、取得失敗とは扱わない', async () => {
    useDb({ profile: null });
    await mountPage(HandsonTourMenuPage);
    await advanceMenuToResult();

    expect(bubbleTitle()).toBe('あなた さんに合わせた献立');
    expect(bubbleBody()).toBe('初心者でも作れる の手順');
    expect(tourErrorEvents()).toEqual([]);
  });

  it('取得に失敗しても既定の文言で進み、失敗を計測とサーバーログに残す', async () => {
    useDb({ profile: { nickname: 'はなこ', diet_flags: { allergies: ['えび'] } } });
    db.failNext('user_profiles', pgError('57014', 'canceling statement due to statement timeout'));
    await mountPage(HandsonTourMenuPage);
    await advanceMenuToResult();

    // パーソナライズは効かないが、ツアーは止まらない
    expect(bubbleTitle()).toBe('あなた さんに合わせた献立');
    expect(bubbleBody()).toBe('初心者でも作れる の手順');

    const events = tourErrorEvents();
    expect(events).toHaveLength(1);
    expect(events[0][1]).toMatchObject({
      user_id: db.userId,
      platform: 'web',
      step: 2,
      error_code: 'profile_fetch_failed',
      error_message: 'user_profiles select failed (57014)',
    });
    expect(mocks.logToServer).toHaveBeenCalledTimes(1);
    expect(mocks.logToServer).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('user_profiles'),
      expect.objectContaining({ step: 2, table: 'user_profiles', code: '57014' }),
    );
  });

  it('取得が例外で失敗しても (ネットワーク断など) ツアーは止まらず、失敗を残す', async () => {
    useDb({ profile: { nickname: 'はなこ' } });
    db.throwNext('user_profiles', new TypeError('Failed to fetch'));
    await mountPage(HandsonTourMenuPage);
    await advanceMenuToResult();

    expect(bubbleBody()).toBe('初心者でも作れる の手順');
    expect(tourErrorEvents()).toHaveLength(1);
    expect(tourErrorEvents()[0][1]).toMatchObject({ step: 2, error_code: 'profile_fetch_failed' });
  });

  it('開発時の StrictMode (effect が 2 回走る) でも、問い合わせと失敗の記録は 1 回ずつで、プロフィールは反映される', async () => {
    useDb({ profile: { nickname: 'はなこ', diet_flags: { allergies: ['えび'] } } });
    await mountPage(HandsonTourMenuPage, { strict: true });
    await advanceMenuToResult();

    expect(db.queries).toHaveLength(1);
    expect(bubbleTitle()).toBe('はなこ さんに合わせた献立');
    expect(bubbleBody()).toBe('えび は除外、初心者でも作れる の手順');

    // 失敗した場合も 1 回だけ
    await act(async () => {
      root.unmount();
    });
    container.remove();
    useDb({ profile: { nickname: 'はなこ' } });
    mocks.fireAnalytics.mockReset();
    mocks.logToServer.mockReset();
    db.failNext('user_profiles', pgError('57014', 'canceling statement due to statement timeout'));
    await mountPage(HandsonTourMenuPage, { strict: true });

    expect(db.queries).toHaveLength(1);
    expect(tourErrorEvents()).toHaveLength(1);
    expect(mocks.logToServer).toHaveBeenCalledTimes(1);
  });

  it('認証情報の取得が失敗しても (getUser が reject)、未処理の例外にならず、既定の文言で進む', async () => {
    useDb({ profile: { nickname: 'はなこ' } });
    db.supabase.auth.getUser.mockRejectedValueOnce(new Error('network down'));
    await mountPage(HandsonTourMenuPage);
    await advanceMenuToResult();

    expect(db.queries).toEqual([]);
    expect(bubbleBody()).toBe('初心者でも作れる の手順');
  });
});

describe('Step1 写真ツアー: プロフィールと目標カロリーの取得と吹き出し (#1040)', () => {
  it('存在する列だけを select する (ニックネームは user_profiles.id、目標は nutrition_targets.user_id)', async () => {
    useDb({ profile: { nickname: 'はなこ' }, nutritionTarget: { daily_calories: 2000 } });
    await mountPage(HandsonTourPhotoPage);

    expect(db.schemaViolations).toEqual([]);
    expect(db.queries).toHaveLength(2);
    const profileQuery = db.queries.find((q) => q.table === 'user_profiles')!;
    const targetQuery = db.queries.find((q) => q.table === 'nutrition_targets')!;
    expect(selectedColumns(profileQuery.select)).toEqual(['nickname']);
    expect(profileQuery.filters).toEqual([['id', db.userId]]);
    expect(selectedColumns(targetQuery.select)).toEqual(['daily_calories']);
    expect(targetQuery.filters).toEqual([['user_id', db.userId]]);
  });

  it('nutrition_targets.daily_calories を目標カロリーとして、サンプル 780 kcal の割合と一緒に出す', async () => {
    useDb({ profile: { nickname: 'はなこ' }, nutritionTarget: { daily_calories: 2000 } });
    await mountPage(HandsonTourPhotoPage);
    await advancePhotoToResult();

    // 780 / 2000 = 39%
    expect(bubbleTitle()).toBe('AI が自動判定');
    expect(bubbleBody()).toBe('はなこ さんの目標 2000 kcal/日 の約 39%');
    expect(tourErrorEvents()).toEqual([]);
    expect(mocks.logToServer).not.toHaveBeenCalled();
  });

  it('目標カロリーの行が無い (オンボーディングの栄養目標計算に失敗した人) 場合は目標なしの文言で、取得失敗とは扱わない', async () => {
    useDb({ profile: { nickname: 'はなこ' }, nutritionTarget: null });
    await mountPage(HandsonTourPhotoPage);
    await advancePhotoToResult();

    expect(bubbleBody()).toBe('AI が自動で料理名と栄養を判定しました');
    expect(tourErrorEvents()).toEqual([]);
    expect(mocks.logToServer).not.toHaveBeenCalled();
  });

  it.each([[null], [0]])('daily_calories が %s でも 0 除算にならず、目標なしの文言にする', async (dailyCalories) => {
    useDb({ profile: { nickname: 'はなこ' }, nutritionTarget: { daily_calories: dailyCalories } });
    await mountPage(HandsonTourPhotoPage);
    await advancePhotoToResult();

    expect(bubbleBody()).toBe('AI が自動で料理名と栄養を判定しました');
    expect(tourErrorEvents()).toEqual([]);
  });

  it('目標カロリーの取得だけ失敗したら、目標なしの文言で進み、nutrition_targets の失敗として残す', async () => {
    useDb({ profile: { nickname: 'はなこ' }, nutritionTarget: { daily_calories: 2000 } });
    db.failNext('nutrition_targets', pgError('42501', 'permission denied for table nutrition_targets'));
    await mountPage(HandsonTourPhotoPage);
    await advancePhotoToResult();

    expect(bubbleBody()).toBe('AI が自動で料理名と栄養を判定しました');
    const events = tourErrorEvents();
    expect(events).toHaveLength(1);
    expect(events[0][1]).toMatchObject({
      step: 1,
      error_code: 'nutrition_target_fetch_failed',
      error_message: 'nutrition_targets select failed (42501)',
    });
    expect(mocks.logToServer).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('nutrition_targets'),
      expect.objectContaining({ step: 1, table: 'nutrition_targets', code: '42501' }),
    );
  });

  it('ニックネームの取得だけ失敗しても、目標カロリーは出す (ニックネームは「あなた」)', async () => {
    useDb({ profile: { nickname: 'はなこ' }, nutritionTarget: { daily_calories: 1560 } });
    db.failNext('user_profiles', pgError('57014', 'canceling statement due to statement timeout'));
    await mountPage(HandsonTourPhotoPage);
    await advancePhotoToResult();

    // 780 / 1560 = 50%
    expect(bubbleBody()).toBe('あなた さんの目標 1560 kcal/日 の約 50%');
    const events = tourErrorEvents();
    expect(events).toHaveLength(1);
    expect(events[0][1]).toMatchObject({ step: 1, error_code: 'profile_fetch_failed' });
  });

  it('ログインしていない (user が null) なら問い合わせず、既定の文言で進む', async () => {
    useDb({ profile: { nickname: 'はなこ' }, nutritionTarget: { daily_calories: 2000 } });
    db.supabase.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    await mountPage(HandsonTourPhotoPage);
    await advancePhotoToResult();

    expect(db.queries).toEqual([]);
    expect(bubbleBody()).toBe('AI が自動で料理名と栄養を判定しました');
    expect(tourErrorEvents()).toEqual([]);
  });

  it('開発時の StrictMode (effect が 2 回走る) でも、問い合わせは 1 組だけで、目標カロリーは反映される', async () => {
    useDb({ profile: { nickname: 'はなこ' }, nutritionTarget: { daily_calories: 2000 } });
    await mountPage(HandsonTourPhotoPage, { strict: true });
    await advancePhotoToResult();

    // user_profiles と nutrition_targets の 2 本だけ (effect の 1 回目は認証の応答前に取り消される)
    expect(db.queries).toHaveLength(2);
    expect(bubbleBody()).toBe('はなこ さんの目標 2000 kcal/日 の約 39%');
  });
});
