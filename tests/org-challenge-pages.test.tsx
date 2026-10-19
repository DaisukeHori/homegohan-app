/**
 * #1132 組織チャレンジの画面の表示テスト
 *
 * 対象:
 *   - ホーム画面の入り口 (src/components/org-challenges/OrgChallengeEntry.tsx)
 *   - メンバー向けの一覧 (/challenges) と詳細 (/challenges/[id])
 *   - 管理者向けの画面 (/org/challenges): 集計 (参加者数・平均) だけを見せる
 *
 * 確かめること:
 *   - 入り口: 組織に所属していない人 (403)・チャレンジが無い組織・通信の失敗では何も出さない。あれば開催中と参加中の件数を出す
 *   - 一覧: 状態ごとの表示 (読み込み中・組織に所属していない・失敗して再読み込み・空)。自分の参加状況 (順位・集計待ち・未参加)。
 *     記録の扱いの説明 (参加は自由・順位は参加者だけ・管理者には人数と平均だけ)
 *   - 詳細: 数え方の説明。参加する前に、順位表に表示名が出るかを説明する。参加する / 参加をやめる (確認つき)。
 *     順位表は API が返したときだけ出す (参加していない人には出さない)。終了したチャレンジには参加ボタンを出さない
 *     #1688: API が reason = 'org_admin' を返したとき (組織の管理者・管理者だった人) は、順位表を出さない旨を説明する
 *   - 参加者数は、最小人数に満たない (API が null で返す) とき「10人未満」と出す
 *   - 管理者向け: 平均は API が出してよいと判断した、終了したチャレンジだけに出す (#1688: 開催中は「終了後に表示」・
 *     終了して出さないときは「表示なし」・中止は欄なし)。参加者数は延べ数。状態のボタンは下書きに「開始」・開催中に「終了」だけ。
 *     歩数・体重・カスタムは選べない (準備中)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rankingSectionSchema } from '@/lib/org-challenge-privacy';

const nav = vi.hoisted(() => ({ id: '00000000-0000-4000-8000-0000000000c1', push: vi.fn() }));

vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: nav.id }),
  useRouter: () => ({ push: nav.push }),
}));

const { OrgChallengeEntry } = await import('@/components/org-challenges/OrgChallengeEntry');
const { default: ChallengesListPage } = await import('@/app/(main)/challenges/page');
const { default: ChallengeDetailPage } = await import('@/app/(main)/challenges/[id]/page');
const { default: OrgChallengesAdminPage } = await import('@/app/(org)/org/challenges/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let consoleError: ReturnType<typeof vi.spyOn>;

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** 本文が JSON でない応答 */
function brokenResponse(status: number): FakeResponse {
  return { ok: false, status, json: () => Promise.reject(new SyntaxError('Unexpected token <')) };
}

const text = () => container.textContent ?? '';

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
  // 初回の読み込み (fetch → setState) を流す
  await act(async () => {});
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
  expect(found, `ボタン「${label}」が見つからない`).toBeDefined();
  return found as HTMLButtonElement;
}

const hasButton = (label: string) => Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.trim() === label);

async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
  await act(async () => {});
}

beforeEach(() => {
  nav.push.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  consoleError.mockRestore();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// 入り口
// ─────────────────────────────────────────────────────────────────────────────

describe('ホーム画面の入り口 (OrgChallengeEntry)', () => {
  it('開催中のチャレンジと参加中の件数を出し、/challenges へのリンクにする', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        challenges: [
          { status: 'active', joined: true },
          { status: 'active', joined: false },
          { status: 'completed', joined: true },
        ],
      }),
    );

    await render(<OrgChallengeEntry />);

    expect(fetchMock).toHaveBeenCalledWith('/api/org/my-challenges', expect.anything());
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/challenges');
    expect(text()).toContain('組織チャレンジ');
    expect(text()).toContain('開催中 2件');
    expect(text()).toContain('参加中 2件');
  });

  it('参加しているチャレンジが無ければ「参加は自由です」と添える。開催中が無ければ終了したチャレンジがあると出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ challenges: [{ status: 'completed', joined: false }] }));

    await render(<OrgChallengeEntry />);

    expect(text()).toContain('終了したチャレンジがあります');
    expect(text()).toContain('参加は自由です');
  });

  it.each([
    ['組織に所属していない (403)', jsonResponse({ error: { code: 'FORBIDDEN' } }, 403)],
    ['未ログイン (401)', jsonResponse({ error: { code: 'UNAUTHORIZED' } }, 401)],
    ['サーバーの失敗 (500)', jsonResponse({ error: { code: 'INTERNAL_ERROR' } }, 500)],
    ['チャレンジが 1 つも無い', jsonResponse({ challenges: [] })],
    ['想定外の形の応答', jsonResponse({ challenges: 'none' })],
  ])('何も出さない: %s', async (_label, response) => {
    fetchMock.mockResolvedValue(response);

    await render(<OrgChallengeEntry />);

    expect(container.innerHTML).toBe('');
  });

  it('通信の失敗でも何も出さない (エラーを画面に出さない)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await render(<OrgChallengeEntry />);

    expect(container.innerHTML).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 一覧
// ─────────────────────────────────────────────────────────────────────────────

function listChallenge(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    title: '朝食チャレンジ',
    description: null,
    challengeType: 'breakfast_rate',
    targetValue: 80,
    targetUnit: '%',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    status: 'active',
    participantCount: 12,
    joined: false,
    me: null,
    ...overrides,
  };
}

describe('メンバー向けの一覧 (/challenges)', () => {
  it('読み込み中を出し、チャレンジの一覧に切り替える。各チャレンジは詳細へのリンク', async () => {
    let resolve!: (value: FakeResponse) => void;
    fetchMock.mockReturnValue(new Promise<FakeResponse>((r) => (resolve = r)));

    await render(<ChallengesListPage />);
    expect(text()).toContain('読み込み中');

    await act(async () => {
      resolve(jsonResponse({ challenges: [listChallenge()], minParticipants: 10 }));
    });
    await act(async () => {});

    expect(text()).not.toContain('読み込み中');
    const link = container.querySelector('a[href="/challenges/00000000-0000-4000-8000-0000000000c1"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('朝食チャレンジ');
    expect(link!.textContent).toContain('朝食をとれた日の割合');
    expect(link!.textContent).toContain('10/1〜10/31');
    expect(link!.textContent).toContain('開催中');
    expect(link!.textContent).toContain('参加者 12人');
  });

  it('記録の扱いを説明する: 参加は自由・順位は参加した人だけ・管理者には参加した人数と終了後の平均だけ・いつでもやめられる', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ challenges: [listChallenge()] }));

    await render(<ChallengesListPage />);

    expect(text()).toContain('参加するかどうかは、あなたの自由です');
    expect(text()).toContain('順位が見えるのは、参加した人だけです');
    expect(text()).toContain(
      '会社の管理者には、参加した人数と、チャレンジが終了したあとの平均だけが表示されます (参加した人が少ない間は表示されません)',
    );
    expect(text()).not.toContain('参加者全体の人数と平均');
    expect(text()).toContain('あなたの記録や順位は表示されません');
    expect(text()).toContain('参加は、いつでもやめられます');
  });

  it('参加者が最小人数に満たない (API が null) ときは「10人未満」。API が返した最小人数があればそれを使う', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ challenges: [listChallenge({ participantCount: null })], minParticipants: 10 }));
    await render(<ChallengesListPage />);
    expect(text()).toContain('参加者 10人未満');

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    fetchMock.mockResolvedValue(jsonResponse({ challenges: [listChallenge({ participantCount: null })], minParticipants: 15 }));
    await render(<ChallengesListPage />);
    expect(text()).toContain('参加者 15人未満');
  });

  it('自分の参加状況: 順位つき / 集計待ち / 未参加 (開催中) / 未参加 (終了)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        challenges: [
          listChallenge({ id: 'a', title: '参加中 (順位あり)', joined: true, me: { currentValue: 66.7, rank: 2, joinedAt: '2026-10-02T00:00:00Z' } }),
          listChallenge({ id: 'b', title: '参加中 (集計待ち)', joined: true, me: { currentValue: 0, rank: null, joinedAt: '2026-10-08T00:00:00Z' } }),
          listChallenge({ id: 'c', title: '未参加 (開催中)' }),
          listChallenge({ id: 'd', title: '未参加 (終了)', status: 'completed' }),
        ],
      }),
    );

    await render(<ChallengesListPage />);

    const item = (title: string) =>
      Array.from(container.querySelectorAll('li')).find((li) => li.textContent?.includes(title))!.textContent ?? '';
    expect(item('参加中 (順位あり)')).toContain('参加中 ・ 2位 ・ 66.7%');
    expect(item('参加中 (集計待ち)')).toContain('参加中 ・ 集計待ち');
    expect(item('未参加 (開催中)')).toContain('まだ参加していません');
    expect(item('未参加 (終了)')).toContain('参加していません');
    expect(item('未参加 (終了)')).toContain('終了');
  });

  it('チャレンジが無ければ、その旨を出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ challenges: [] }));

    await render(<ChallengesListPage />);

    expect(text()).toContain('いま参加できるチャレンジはありません');
  });

  it('組織に所属していない (403) 人には、組織向けの機能だと説明する', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'FORBIDDEN' } }, 403));

    await render(<ChallengesListPage />);

    expect(text()).toContain('組織に所属している方のための機能です');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('失敗したらエラーと「もう一度読み込む」を出し、押すと読み直す', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'INTERNAL_ERROR' } }, 500));
    await render(<ChallengesListPage />);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('チャレンジを読み込めませんでした');

    fetchMock.mockResolvedValueOnce(jsonResponse({ challenges: [listChallenge()] }));
    await click(button('もう一度読み込む'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(text()).toContain('朝食チャレンジ');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('通信そのものが失敗しても、エラーを出す (画面を壊さない)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await render(<ChallengesListPage />);

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('ホームへ戻るボタンで /home へ移る (リンク <a> にしない: アプリの WebView では、タブの画面へ向かう <a> を NativeAppTabRouter が横取りして何も起きなくなる)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ challenges: [] }));

    await render(<ChallengesListPage />);

    expect(container.querySelector('a[href="/home"]')).toBeNull();
    expect(nav.push).not.toHaveBeenCalled();
    await click(button('← ホームへ戻る'));
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith('/home');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 詳細
// ─────────────────────────────────────────────────────────────────────────────

function detailBody(overrides: Record<string, unknown> = {}) {
  return {
    challenge: {
      id: nav.id,
      title: '朝食チャレンジ',
      description: '毎日の朝食を記録しよう',
      challengeType: 'breakfast_rate',
      targetValue: 80,
      targetUnit: '%',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      rewardDescription: 'スペシャルバッジ',
      status: 'active',
    },
    participantCount: 12,
    minParticipants: 10,
    joined: false,
    me: null,
    ranking: { available: false, showNames: false, reason: 'not_joined' },
    ...overrides,
  };
}

const joinedBody = (overrides: Record<string, unknown> = {}) =>
  detailBody({
    joined: true,
    me: { currentValue: 50, rank: 2, joinedAt: '2026-10-02T00:00:00Z' },
    ranking: {
      available: true,
      showNames: false,
      rankedCount: 3,
      truncated: false,
      entries: [
        { rank: 1, value: 80, isMe: false, label: '参加者' },
        { rank: 2, value: 50, isMe: true, label: 'あなた' },
        { rank: 3, value: 20, isMe: false, label: '参加者' },
      ],
    },
    ...overrides,
  });

describe('メンバー向けの詳細 (/challenges/[id])', () => {
  it('チャレンジの情報と、数え方の説明を出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(detailBody()));

    await render(<ChallengeDetailPage />);

    expect(fetchMock).toHaveBeenCalledWith(`/api/org/challenges/${nav.id}`, expect.anything());
    expect(text()).toContain('朝食チャレンジ');
    expect(text()).toContain('毎日の朝食を記録しよう');
    expect(text()).toContain('10/1〜10/31');
    expect(text()).toContain('参加者 12人');
    expect(text()).toContain('目標80%');
    expect(text()).toContain('スペシャルバッジ');
    expect(text()).toContain('数え方');
    expect(text()).toContain('朝食を食べた');
    expect(text()).toContain('参加する前の記録も、チャレンジの期間内なら数えます');
    expect(text()).toContain('お試し (ハンズオン) の記録は数えません');
  });

  it('参加者が最小人数に満たない (null) ときは「10人未満」', async () => {
    fetchMock.mockResolvedValue(jsonResponse(detailBody({ participantCount: null })));

    await render(<ChallengeDetailPage />);

    expect(text()).toContain('参加者 10人未満');
  });

  it('参加する前に、見え方を説明する (表示名は出ない / 管理者には参加した人数と終了後の平均だけ / いつでもやめられる)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(detailBody()));

    await render(<ChallengeDetailPage />);

    expect(text()).toContain('参加は自由です');
    expect(text()).toContain('参加した人どうしにだけ表示されます');
    expect(text()).toContain('ほかの参加者のニックネームは表示されません');
    expect(text()).toContain(
      '会社の管理者には、参加した人数と、チャレンジが終了したあとの平均だけが表示されます (参加した人が少ない間は表示されません)',
    );
    expect(text()).not.toContain('参加者全体の人数と平均');
    expect(text()).toContain('いつでも参加をやめられます');
  });

  it('表示名を出す設定のときは、順位表にニックネームが表示されると説明する', async () => {
    fetchMock.mockResolvedValue(jsonResponse(detailBody({ ranking: { available: false, showNames: true, reason: 'not_joined' } })));

    await render(<ChallengeDetailPage />);

    expect(text()).toContain('順位表には、参加した人のニックネームが表示されます');
    expect(text()).not.toContain('ほかの参加者のニックネームは表示されません');
  });

  it('参加していなければ「参加する」ボタンを出し、順位表と自分の記録は出さない', async () => {
    fetchMock.mockResolvedValue(jsonResponse(detailBody()));

    await render(<ChallengeDetailPage />);

    expect(hasButton('このチャレンジに参加する')).toBe(true);
    // 順位表と自分の記録の区画は出ない (参加前の説明の文には「順位表」「あなたの記録」という言葉が出る)
    expect(container.querySelector('#ranking-title')).toBeNull();
    expect(container.querySelector('#my-record')).toBeNull();
    expect(container.querySelector('ol')).toBeNull();
    expect(hasButton('参加をやめる')).toBe(false);
    // 参加していない (reason = not_joined) ときは、管理者向けの「順位表を表示しません」の説明も出さない
    expect(container.querySelector('#ranking-hidden-title')).toBeNull();
    expect(text()).not.toContain('順位表を表示しません');
  });

  it('「参加する」を押すと POST /join を呼び、読み直して参加中の表示になる', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/join')) return jsonResponse({ joined: true, alreadyJoined: false });
      return jsonResponse(fetchMock.mock.calls.some((c) => c[0].endsWith('/join')) ? joinedBody() : detailBody());
    });
    await render(<ChallengeDetailPage />);

    await click(button('このチャレンジに参加する'));

    const joinCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/join'))!;
    expect(joinCall[0]).toBe(`/api/org/challenges/${nav.id}/join`);
    expect(joinCall[1]).toMatchObject({ method: 'POST' });
    expect(container.querySelector('#my-record')).not.toBeNull();
    expect(container.querySelector('#ranking-title')).not.toBeNull();
    expect(hasButton('このチャレンジに参加する')).toBe(false);
  });

  it('参加に失敗したら、API のメッセージを出す (参加状態は変えない)', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/join')
        ? jsonResponse({ error: { code: 'CHALLENGE_ENDED', message: 'このチャレンジは終了しました' } }, 409)
        : jsonResponse(detailBody()),
    );
    await render(<ChallengeDetailPage />);

    await click(button('このチャレンジに参加する'));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('このチャレンジは終了しました');
    expect(hasButton('このチャレンジに参加する')).toBe(true);
  });

  it('参加に失敗して本文が読めないときは、既定の文を出す', async () => {
    fetchMock.mockImplementation(async (url: string) => (url.endsWith('/join') ? brokenResponse(502) : jsonResponse(detailBody())));
    await render(<ChallengeDetailPage />);

    await click(button('このチャレンジに参加する'));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('参加できませんでした');
  });

  it('終了したチャレンジには「参加する」ボタンを出さない', async () => {
    const body = detailBody();
    (body.challenge as Record<string, unknown>).status = 'completed';
    fetchMock.mockResolvedValue(jsonResponse(body));

    await render(<ChallengeDetailPage />);

    expect(hasButton('このチャレンジに参加する')).toBe(false);
    expect(text()).toContain('このチャレンジは終了しました');
  });

  it('参加者本人には、自分の順位・記録と順位表を出す。本人の行は「あなた」で強調し、ほかの参加者は「参加者」', async () => {
    fetchMock.mockResolvedValue(jsonResponse(joinedBody()));

    await render(<ChallengeDetailPage />);

    expect(container.querySelector('#my-record')).not.toBeNull();
    expect(text()).toContain('参加中');
    expect(text()).toContain('2位');
    expect(text()).toContain('/ 3人');
    expect(text()).toContain('50%');
    const rows = Array.from(container.querySelectorAll('ol li'));
    expect(rows.map((r) => r.textContent)).toEqual(['1位参加者80%', '2位あなた50%', '3位参加者20%']);
    expect(rows[1].getAttribute('aria-current')).toBe('true');
    expect(rows[0].getAttribute('aria-current')).toBeNull();
    expect(text()).toContain('ほかの参加者のニックネームは表示されません');
  });

  it('表示名を出す設定のときは、順位表にニックネームを出す (本人は「あなた」)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        joinedBody({
          ranking: {
            available: true,
            showNames: true,
            rankedCount: 2,
            truncated: false,
            entries: [
              { rank: 1, value: 80, isMe: false, label: '高橋二郎' },
              { rank: 2, value: 50, isMe: true, label: 'あなた' },
            ],
          },
        }),
      ),
    );

    await render(<ChallengeDetailPage />);

    const rows = Array.from(container.querySelectorAll('ol li')).map((r) => r.textContent);
    expect(rows).toEqual(['1位高橋二郎80%', '2位あなた50%']);
    expect(text()).not.toContain('ほかの参加者のニックネームは表示されません');
  });

  it('参加したばかりで順位がまだ無いときは、集計待ちだと説明する', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        joinedBody({
          me: { currentValue: 0, rank: null, joinedAt: '2026-10-08T00:00:00Z' },
          ranking: { available: true, showNames: false, rankedCount: 0, truncated: false, entries: [] },
        }),
      ),
    );

    await render(<ChallengeDetailPage />);

    expect(text()).toContain('参加したばかりのため、まだ集計されていません');
    expect(text()).toContain('まだ集計された参加者がいません');
  });

  it('順位表が上位と本人だけのとき (truncated) は、その旨を添える', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        joinedBody({
          ranking: {
            available: true,
            showNames: false,
            rankedCount: 40,
            truncated: true,
            entries: [{ rank: 1, value: 80, isMe: false, label: '参加者' }, { rank: 31, value: 20, isMe: true, label: 'あなた' }],
          },
        }),
      ),
    );

    await render(<ChallengeDetailPage />);

    expect(text()).toContain('上位の人とあなたの順位を表示しています');
  });

  it('「参加をやめる」は確認つき: 押すと確認を出し、「続ける」で戻り、「やめる」で DELETE /join を呼ぶ', async () => {
    let left = false;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/join')) {
        left = true;
        return jsonResponse({ joined: false });
      }
      return jsonResponse(left ? detailBody() : joinedBody());
    });
    await render(<ChallengeDetailPage />);

    await click(button('参加をやめる'));
    expect(text()).toContain('本当に参加をやめますか?');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/join'))).toBe(false);

    await click(button('続ける'));
    expect(text()).not.toContain('本当に参加をやめますか?');

    await click(button('参加をやめる'));
    await click(button('やめる'));

    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/join'))!;
    expect(call[1]).toMatchObject({ method: 'DELETE' });
    expect(hasButton('このチャレンジに参加する')).toBe(true);
    expect(container.querySelector('#my-record')).toBeNull();
    expect(container.querySelector('#ranking-title')).toBeNull();
  });

  it('組織に所属していない (403) 人には、組織向けの機能だと説明する', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'FORBIDDEN' } }, 403));

    await render(<ChallengeDetailPage />);

    expect(text()).toContain('組織に所属している方のための機能です');
  });

  it('チャレンジが見つからない (404) ときは、その旨を出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'CHALLENGE_NOT_FOUND' } }, 404));

    await render(<ChallengeDetailPage />);

    expect(text()).toContain('チャレンジが見つかりませんでした');
  });

  it('失敗したらエラーと「もう一度読み込む」を出し、押すと読み直す', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'INTERNAL_ERROR' } }, 500));
    await render(<ChallengeDetailPage />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('チャレンジを読み込めませんでした');

    fetchMock.mockResolvedValueOnce(jsonResponse(detailBody()));
    await click(button('もう一度読み込む'));

    expect(text()).toContain('朝食チャレンジ');
  });

  it('一覧へ戻るリンクがある', async () => {
    fetchMock.mockResolvedValue(jsonResponse(detailBody()));

    await render(<ChallengeDetailPage />);

    expect(container.querySelector('a[href="/challenges"]')).not.toBeNull();
  });

  // #1688: 組織の管理者 (参加している owner / admin と、このチャレンジがある間に管理者になったことがある人) には、
  // API が順位表を返さず reason = 'org_admin' を返す。自分の記録と順位 (me) は返る
  const orgAdminBody = (overrides: Record<string, unknown> = {}) =>
    detailBody({
      joined: true,
      me: { currentValue: 50, rank: 2, joinedAt: '2026-10-02T00:00:00Z' },
      ranking: { available: false, showNames: false, reason: 'org_admin' },
      ...overrides,
    });

  it('reason が org_admin のときは、順位表を出さず、管理者には順位表を表示しない旨を説明する。自分の記録と順位は出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(orgAdminBody()));

    await render(<ChallengeDetailPage />);

    const hidden = container.querySelector('section[aria-labelledby="ranking-hidden-title"]');
    expect(hidden).not.toBeNull();
    expect(hidden!.textContent).toContain(
      '組織の管理者 (このチャレンジがある間に管理者になったことがある人を含む) には、順位表を表示しません (あなたの記録と順位だけが表示されます)',
    );
    // 順位表 (ol) と、その区画は出さない
    expect(container.querySelector('ol')).toBeNull();
    expect(container.querySelector('#ranking-title')).toBeNull();
    // 自分の記録と順位は出す。順位表の人数 (「/ n人」) は返らないので出さない
    expect(container.querySelector('#my-record')).not.toBeNull();
    expect(container.querySelector('#my-record')!.closest('section')!.textContent).toContain('2位');
    expect(text()).toContain('50%');
    expect(text()).not.toMatch(/\/ \d+人/);
    // 参加中なので、やめる操作は出す
    expect(hasButton('参加をやめる')).toBe(true);
  });

  it('reason が org_admin で、まだ集計されていない (rank が null) ときも、集計待ちの説明と順位表を出さない旨を出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(orgAdminBody({ me: { currentValue: 0, rank: null, joinedAt: '2026-10-08T00:00:00Z' } })));

    await render(<ChallengeDetailPage />);

    expect(text()).toContain('参加したばかりのため、まだ集計されていません');
    expect(text()).toContain('には、順位表を表示しません');
    expect(container.querySelector('ol')).toBeNull();
  });

  it('参加をやめて reason が not_joined に変わると、管理者向けの説明は消え、参加ボタンに戻る', async () => {
    let left = false;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/join')) {
        left = true;
        return jsonResponse({ joined: false });
      }
      return jsonResponse(left ? detailBody() : orgAdminBody());
    });
    await render(<ChallengeDetailPage />);
    expect(container.querySelector('#ranking-hidden-title')).not.toBeNull();

    await click(button('参加をやめる'));
    await click(button('やめる'));

    expect(container.querySelector('#ranking-hidden-title')).toBeNull();
    expect(text()).not.toContain('順位表を表示しません');
    expect(hasButton('このチャレンジに参加する')).toBe(true);
  });

  it('このファイルの模擬の応答の ranking は、API の正本の形 (rankingSectionSchema) に合う', () => {
    const rankings = [
      detailBody().ranking,
      joinedBody().ranking,
      orgAdminBody().ranking,
      { available: false, showNames: true, reason: 'not_joined' },
    ];
    for (const ranking of rankings) expect(rankingSectionSchema.safeParse(ranking).success).toBe(true);
    // reason の無い available = false は正本の形ではない (画面は reason で出し分ける)
    expect(rankingSectionSchema.safeParse({ available: false, showNames: false }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 管理者向け
// ─────────────────────────────────────────────────────────────────────────────

function adminChallenge(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000d1',
    title: '朝食チャレンジ',
    description: null,
    challengeType: 'breakfast_rate',
    targetValue: 80,
    targetUnit: '%',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    rewardDescription: null,
    // 平均 (visible = true) を出すのは終了したチャレンジだけなので、既定は終了 (completed)
    status: 'completed',
    departmentId: null,
    departmentName: null,
    participantCount: 12,
    aggregate: { minParticipants: 10, visible: true, averageValue: 63.2 },
    createdAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

/** 管理者の画面のカードの、参加した人の数の欄 (見出し「参加した人」の直前の値) */
function participantCountCell(): string {
  const heading = Array.from(container.querySelectorAll('p')).find((el) => el.textContent === '参加した人');
  expect(heading, '見出し「参加した人」が見つからない').toBeDefined();
  return heading!.previousElementSibling?.textContent ?? '';
}

function setNativeValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
}

async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    setNativeValue(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

describe('管理者向けの画面 (/org/challenges): 集計だけ', () => {
  it('終了したチャレンジは、参加した人の数と確定した平均を出す (平均は単位つき)。個人の記録・順位は出さない', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ challenges: [adminChallenge()] }));

    await render(<OrgChallengesAdminPage />);

    expect(text()).toContain('朝食チャレンジ');
    expect(participantCountCell()).toBe('12');
    expect(text()).toContain('63.2%');
    expect(text()).toContain('参加者の平均 (終了時点)');
    expect(text()).not.toContain('終了後に表示');
    expect(text()).not.toContain('表示なし');
    // 個人の順位 (「2位」など)・順位表は出ない
    expect(text()).not.toMatch(/\d+位/);
    expect(text()).not.toContain('順位表');
    expect(container.querySelector('ol')).toBeNull();
  });

  it('管理者向けの説明: 参加は社員の自由・見えるのは集計だけ・順位は参加者どうしにだけ・参加者数は延べ数・平均は終了後だけ・重なるチャレンジは先の 1 本だけ', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ challenges: [] }));

    await render(<OrgChallengesAdminPage />);

    expect(text()).toContain('参加は社員の自由です');
    expect(text()).toContain('管理者に見えるのは、チャレンジごとの集計 (参加者数と平均) だけです');
    expect(text()).toContain('順位は、参加した社員どうしにだけ表示されます');
    expect(text()).toContain(
      '参加者数は、これまでに参加した人の数で、やめた人や組織を離れた人を引きません。10人以上になるまでは表示しません。',
    );
    expect(text()).toContain(
      '平均は、チャレンジが終了したあとに、終了時点の参加者が10人以上のときだけ表示します (開催中は表示しません)。',
    );
    expect(text()).toContain('同じ種類で期間が重なるチャレンジは、先に終了したものの平均だけを表示します');
    // 旧の説明 (集計が済んだ参加者で平均を出す) は残さない
    expect(text()).not.toContain('集計が済んだ参加者');
  });

  it('開催中は、参加した人が最小人数に満たない (null) ときは「10人未満」。平均は「終了後に表示」で、終了時点の人数の条件を説明する', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        challenges: [
          adminChallenge({ status: 'active', participantCount: null, aggregate: { minParticipants: 10, visible: false, averageValue: null } }),
        ],
      }),
    );

    await render(<OrgChallengesAdminPage />);

    expect(participantCountCell()).toBe('10人未満');
    expect(text()).toContain('終了後に表示');
    expect(text()).toContain('チャレンジが終了すると、終了時点の参加者 (10人以上) の平均を表示します');
    expect(text()).not.toContain('参加者の平均');
    expect(text()).not.toContain('表示なし');
    expect(text()).not.toContain('集計中');
  });

  it('開催中は、参加した人が 10 人以上でも平均は「終了後に表示」。API の最小人数があればそれを使う', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        challenges: [adminChallenge({ status: 'active', participantCount: 16, aggregate: { minParticipants: 15, visible: false, averageValue: null } })],
      }),
    );

    await render(<OrgChallengesAdminPage />);

    expect(participantCountCell()).toBe('16');
    expect(text()).toContain('終了後に表示');
    expect(text()).toContain('終了時点の参加者 (15人以上) の平均を表示します');
  });

  it('開催中・下書きのチャレンジは、API が平均を返しても終了前の値としては出さない (平均は終了時に確定した値だけ)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        challenges: [
          adminChallenge({ id: 'a', status: 'active', aggregate: { minParticipants: 10, visible: true, averageValue: 63.2 } }),
          adminChallenge({ id: 'd', status: 'draft', aggregate: { minParticipants: 10, visible: true, averageValue: 41.5 } }),
        ],
      }),
    );

    await render(<OrgChallengesAdminPage />);

    expect(text()).not.toContain('63.2%');
    expect(text()).not.toContain('41.5%');
    expect(text()).not.toContain('参加者の平均');
    expect(text().match(/終了後に表示/g)).toHaveLength(2);
  });

  it('終了して平均を出さない (API の visible = false) ときは「表示なし」と、終了時点の人数か重なるチャレンジのためだと説明する。人数は出す', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        challenges: [adminChallenge({ status: 'completed', participantCount: 11, aggregate: { minParticipants: 10, visible: false, averageValue: null } })],
      }),
    );

    await render(<OrgChallengesAdminPage />);

    expect(participantCountCell()).toBe('11');
    expect(text()).toContain('表示なし');
    expect(text()).toContain(
      '終了時点の参加者が10人未満か、同じ種類で期間が重なるチャレンジの平均をすでに表示しているため、平均は表示しません',
    );
    expect(text()).not.toContain('参加者の平均');
    expect(text()).not.toContain('終了後に表示');
  });

  it('終了して平均が 0 のときも「表示なし」ではなく 0 を出す', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ challenges: [adminChallenge({ aggregate: { minParticipants: 10, visible: true, averageValue: 0 } })] }),
    );

    await render(<OrgChallengesAdminPage />);

    expect(text()).toContain('0%');
    expect(text()).toContain('参加者の平均 (終了時点)');
    expect(text()).not.toContain('表示なし');
  });

  it('中止したチャレンジには、平均の欄を出さない (中止は平均を確定しない)。参加した人の数は出す', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        challenges: [adminChallenge({ status: 'cancelled', participantCount: 12, aggregate: { minParticipants: 10, visible: false, averageValue: null } })],
      }),
    );

    await render(<OrgChallengesAdminPage />);

    expect(text()).toContain('中止');
    expect(participantCountCell()).toBe('12');
    expect(text()).not.toContain('終了後に表示');
    expect(text()).not.toContain('表示なし');
    expect(text()).not.toContain('参加者の平均');
  });

  it('計算できない種類 (歩数) のチャレンジには、平均の欄を出さない', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        challenges: [adminChallenge({ challengeType: 'steps', aggregate: { minParticipants: 10, visible: false, averageValue: null } })],
      }),
    );

    await render(<OrgChallengesAdminPage />);

    expect(text()).toContain('歩数');
    expect(text()).not.toContain('終了後に表示');
    expect(text()).not.toContain('表示なし');
    expect(text()).not.toContain('参加者の平均');
  });

  it.each([
    ['draft', ['開始']],
    ['active', ['終了']],
    ['completed', []],
    ['cancelled', []],
  ] as const)('状態のボタンは、%s のカードには %j だけを出す (終わった状態には押すと 409 になるボタンを置かない)', async (status, expected) => {
    fetchMock.mockResolvedValue(jsonResponse({ challenges: [adminChallenge({ status })] }));

    await render(<OrgChallengesAdminPage />);

    const statusButtons = ['開始', '終了'].filter((label) => hasButton(label));
    expect(statusButtons).toEqual(expected);
  });

  it('「終了」を押すと PUT /api/org/challenges に status = completed を送り、一覧を読み直す', async () => {
    let completed = false;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') {
        completed = true;
        return jsonResponse({ success: true });
      }
      return jsonResponse({
        challenges: [
          completed
            ? adminChallenge({ status: 'completed' })
            : adminChallenge({ status: 'active', aggregate: { minParticipants: 10, visible: false, averageValue: null } }),
        ],
      });
    });
    await render(<OrgChallengesAdminPage />);
    expect(text()).toContain('終了後に表示');

    await click(button('終了'));

    const put = fetchMock.mock.calls.find((c) => c[1]?.method === 'PUT')!;
    expect(put[0]).toBe('/api/org/challenges');
    expect(JSON.parse(put[1].body)).toEqual({ id: '00000000-0000-4000-8000-0000000000d1', status: 'completed' });
    expect(text()).toContain('63.2%');
    expect(text()).toContain('参加者の平均 (終了時点)');
    expect(hasButton('終了')).toBe(false);
  });

  it('状態を変えられない (409 CHALLENGE_STATUS_LOCKED) ときは、API のメッセージを出す', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) =>
      init?.method === 'PUT'
        ? jsonResponse({ error: 'このチャレンジの状態は変えられません', code: 'CHALLENGE_STATUS_LOCKED' }, 409)
        : jsonResponse({ challenges: [adminChallenge({ status: 'active', aggregate: { minParticipants: 10, visible: false, averageValue: null } })] }),
    );
    await render(<OrgChallengesAdminPage />);

    await click(button('終了'));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('このチャレンジの状態は変えられません');
  });

  it('作成フォーム: 選択肢は使える 3 種類だけ。歩数・体重・カスタムは選択肢に出さず、「準備中」や予定の文も出さない (#1911)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ challenges: [] }));
    await render(<OrgChallengesAdminPage />);

    await click(button('+ 新規チャレンジ'));

    const options = Array.from(container.querySelectorAll('select option')) as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual(['breakfast_rate', 'veg_score', 'cooking_rate']);
    expect(options.every((o) => !o.disabled)).toBe(true);
    expect(text()).not.toContain('準備中');
    expect(text()).not.toContain('選べるようになります');
  });

  it('種類を選ぶと、単位と目標値の初期値が変わる (野菜スコアは初期値なし、0〜100 まで)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ challenges: [] }));
    await render(<OrgChallengesAdminPage />);
    await click(button('+ 新規チャレンジ'));
    const select = container.querySelector('select') as HTMLSelectElement;
    const target = container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(target.value).toBe('80');
    expect(text()).toContain('目標値 (%)');

    await change(select, 'veg_score');
    expect(target.value).toBe('');
    expect(target.min).toBe('0');
    expect(target.max).toBe('100');
    expect(text()).toContain('目標値 (点)');

    await change(select, 'cooking_rate');
    expect(target.value).toBe('60');
    expect(text()).toContain('目標値 (%)');
  });

  it('作成すると POST /api/org/challenges に、選んだ種類・目標値・期間を送り、一覧を読み直してフォームを閉じる', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return jsonResponse({ success: true, challenge: { id: 'x', title: 't', status: 'draft' } });
      return jsonResponse({ challenges: [] });
    });
    await render(<OrgChallengesAdminPage />);
    await click(button('+ 新規チャレンジ'));
    const [title] = Array.from(container.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
    const [startDate, endDate] = Array.from(container.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    await change(title, '秋の朝食チャレンジ');
    await change(startDate, '2026-11-01');
    await change(endDate, '2026-11-30');

    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});

    const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(post[0]).toBe('/api/org/challenges');
    expect(JSON.parse(post[1].body)).toMatchObject({
      title: '秋の朝食チャレンジ',
      challengeType: 'breakfast_rate',
      targetValue: 80,
      targetUnit: '%',
      startDate: '2026-11-01',
      endDate: '2026-11-30',
    });
    // 一覧を読み直す (作成のあとの GET)。フォームを閉じる動き (終了アニメーション) は jsdom では確かめない
    const listCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === undefined);
    expect(listCalls).toHaveLength(2);
  });

  it('作成に失敗したら、API のメッセージを出す', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) =>
      init?.method === 'POST'
        ? jsonResponse({ error: 'この種類のチャレンジは作成できません', code: 'CHALLENGE_TYPE_DISABLED' }, 400)
        : jsonResponse({ challenges: [] }),
    );
    await render(<OrgChallengesAdminPage />);
    await click(button('+ 新規チャレンジ'));
    const [title] = Array.from(container.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
    const [startDate, endDate] = Array.from(container.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    await change(title, 't');
    await change(startDate, '2026-11-01');
    await change(endDate, '2026-11-30');

    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('この種類のチャレンジは作成できません');
    expect(container.querySelector('form')).not.toBeNull();
  });

  it('状態の変更に失敗したら、API のメッセージを出す', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) =>
      init?.method === 'PUT'
        ? jsonResponse({ error: 'この種類のチャレンジは開始できません', code: 'CHALLENGE_TYPE_DISABLED' }, 400)
        : jsonResponse({ challenges: [adminChallenge({ status: 'draft' })] }),
    );
    await render(<OrgChallengesAdminPage />);

    await click(button('開始'));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('この種類のチャレンジは開始できません');
  });
});
