/**
 * #1132 組織チャレンジの API 共通部品 (src/lib/org-challenge-api.ts) のテスト
 *
 * 確かめること:
 *   - 管理者向けの集計 (fetchChallengeAggregates): DB の関数 get_org_challenge_aggregates の応答を、人数・平均だけの形にする。
 *     最小人数に満たないとき DB の関数が返す null を、0 や空にせずそのまま通す (「0 人」と「5 人未満」を取り違えない)
 *   - 参加者向けの順位表 (fetchChallengeRanking): 本人は「あなた」。ほかの参加者は、表示名を出す設定のときだけニックネーム、
 *     そうでなければ「参加者」。表示名を出さない設定のときは、DB の関数にも表示名を求めない
 *   - メンバーに見せるチャレンジの判定 (isVisibleToMember) と、メンバー向けに返す形 (toMemberChallengeDto)
 *   - メンバー向け API のエラー応答 (handleMemberError): 401 / 403 はそのまま、それ以外は 500 の汎用メッセージ (生のエラー文は返さない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

const mockLoggerError = vi.fn();

vi.mock('@/lib/db-logger', () => ({
  createLogger: (routeName: string) => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(routeName, ...args),
    withUser: vi.fn(),
  }),
  generateRequestId: () => 'req_test',
}));

const {
  CHALLENGE_COLUMNS,
  challengeError,
  fetchChallengeAggregates,
  fetchChallengeRanking,
  handleMemberError,
  isVisibleToMember,
  toMemberChallengeDto,
  toNumber,
} = await import('@/lib/org-challenge-api');

const CHALLENGE_ID = '00000000-0000-4000-8000-0000000000c1';
const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_ID = '00000000-0000-4000-8000-0000000000b1';
const OTHER_USER_ID = '00000000-0000-4000-8000-0000000000b2';

function rpcReturning(data: unknown, error: { code?: string; message: string } | null = null) {
  return vi.fn(async () => ({ data, error }));
}

beforeEach(() => {
  mockLoggerError.mockReset();
});

describe('toNumber', () => {
  it('数・数字の文字列は数にする。空・null・数でないものは null', () => {
    expect(toNumber(5)).toBe(5);
    expect(toNumber('12.5')).toBe(12.5);
    expect(toNumber(0)).toBe(0);
    expect(toNumber('0')).toBe(0);
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber('')).toBeNull();
    expect(toNumber('abc')).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
    expect(toNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('fetchChallengeAggregates', () => {
  it('組織 ID だけを渡して DB の関数を呼び、チャレンジごとの人数・最小人数・平均にする', async () => {
    const rpc = rpcReturning([
      { challenge_id: 'c-1', participant_count: 12, min_participants: 5, average_value: '63.2' },
      { challenge_id: 'c-2', participant_count: '7', min_participants: 5, average_value: null },
    ]);

    const result = await fetchChallengeAggregates({ rpc } as never, ORG_ID);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_org_challenge_aggregates', { p_organization_id: ORG_ID });
    expect(result.get('c-1')).toEqual({ participantCount: 12, minParticipants: 5, averageValue: 63.2 });
    expect(result.get('c-2')).toEqual({ participantCount: 7, minParticipants: 5, averageValue: null });
  });

  it('最小人数に満たないとき DB の関数が返す null は、0 にせず null のまま通す', async () => {
    const rpc = rpcReturning([{ challenge_id: 'c-1', participant_count: null, min_participants: 5, average_value: null }]);

    const result = await fetchChallengeAggregates({ rpc } as never, ORG_ID);

    expect(result.get('c-1')).toEqual({ participantCount: null, minParticipants: 5, averageValue: null });
  });

  it('0 人・平均 0 は null と区別する', async () => {
    const rpc = rpcReturning([{ challenge_id: 'c-1', participant_count: 0, min_participants: 5, average_value: 0 }]);

    const result = await fetchChallengeAggregates({ rpc } as never, ORG_ID);

    expect(result.get('c-1')).toEqual({ participantCount: 0, minParticipants: 5, averageValue: 0 });
  });

  it('行が無い (チャレンジが無い組織) ときは空の Map', async () => {
    expect((await fetchChallengeAggregates({ rpc: rpcReturning([]) } as never, ORG_ID)).size).toBe(0);
    expect((await fetchChallengeAggregates({ rpc: rpcReturning(null) } as never, ORG_ID)).size).toBe(0);
  });

  it('DB の関数が失敗したら例外にする (呼び出し側の catch で 500 にして記録する)', async () => {
    const rpc = rpcReturning(null, { code: '42883', message: 'function does not exist' });

    await expect(fetchChallengeAggregates({ rpc } as never, ORG_ID)).rejects.toThrow(/get_org_challenge_aggregates/);
  });
});

describe('fetchChallengeRanking', () => {
  const rows = [
    { rank: 1, current_value: '100', is_me: false, nickname: '太郎', ranked_count: 5 },
    { rank: 2, current_value: 50, is_me: true, nickname: '花子', ranked_count: 5 },
    { rank: 2, current_value: 50, is_me: false, nickname: null, ranked_count: 5 },
    { rank: 4, current_value: 25, is_me: false, nickname: '   ', ranked_count: 5 },
  ];

  it('表示名を出さない設定: 本人は「あなた」、ほかの人は「参加者」。DB の関数にも表示名を求めない', async () => {
    const rpc = rpcReturning(rows.map((r) => ({ ...r, nickname: null })));

    const view = await fetchChallengeRanking({ rpc } as never, { challengeId: CHALLENGE_ID, userId: USER_ID, showNames: false });

    expect(rpc).toHaveBeenCalledWith('get_org_challenge_ranking', {
      p_challenge_id: CHALLENGE_ID,
      p_user_id: USER_ID,
      p_limit: 20,
      p_with_names: false,
    });
    expect(view.entries.map((e) => e.label)).toEqual(['参加者', 'あなた', '参加者', '参加者']);
    expect(view.entries.map((e) => [e.rank, e.value, e.isMe])).toEqual([
      [1, 100, false],
      [2, 50, true],
      [2, 50, false],
      [4, 25, false],
    ]);
    expect(view.rankedCount).toBe(5);
  });

  it('表示名を出さない設定のとき、DB の関数が万一ニックネームを返しても、画面に渡さない', async () => {
    const rpc = rpcReturning(rows);

    const view = await fetchChallengeRanking({ rpc } as never, { challengeId: CHALLENGE_ID, userId: USER_ID, showNames: false });

    const text = JSON.stringify(view);
    expect(text).not.toContain('太郎');
    expect(text).not.toContain('花子');
  });

  it('表示名を出す設定: ほかの人はニックネーム (空・空白だけ・無しは「参加者」)。本人は常に「あなた」', async () => {
    const rpc = rpcReturning(rows);

    const view = await fetchChallengeRanking({ rpc } as never, { challengeId: CHALLENGE_ID, userId: USER_ID, showNames: true });

    expect(rpc).toHaveBeenCalledWith('get_org_challenge_ranking', expect.objectContaining({ p_with_names: true }));
    expect(view.entries.map((e) => e.label)).toEqual(['太郎', 'あなた', '参加者', '参加者']);
    // 本人の行に、本人のニックネームを出さない (「あなた」だけ)
    expect(JSON.stringify(view)).not.toContain('花子');
  });

  it('上位の人数を指定できる', async () => {
    const rpc = rpcReturning([]);

    await fetchChallengeRanking({ rpc } as never, { challengeId: CHALLENGE_ID, userId: USER_ID, showNames: false, limit: 3 });

    expect(rpc).toHaveBeenCalledWith('get_org_challenge_ranking', expect.objectContaining({ p_limit: 3 }));
  });

  it('返す形に、ほかの参加者の ID は含まれない', async () => {
    const rpc = rpcReturning(rows);

    const view = await fetchChallengeRanking({ rpc } as never, { challengeId: CHALLENGE_ID, userId: USER_ID, showNames: true });

    expect(Object.keys(view.entries[0]).sort()).toEqual(['isMe', 'label', 'rank', 'value']);
    expect(JSON.stringify(view)).not.toContain(OTHER_USER_ID);
  });

  it('参加していない人 (DB の関数が 0 行) には、空の順位表', async () => {
    const view = await fetchChallengeRanking({ rpc: rpcReturning([]) } as never, {
      challengeId: CHALLENGE_ID,
      userId: USER_ID,
      showNames: false,
    });

    expect(view).toEqual({ entries: [], rankedCount: 0 });
  });

  it('DB の関数が失敗したら例外にする', async () => {
    const rpc = rpcReturning(null, { code: '42501', message: 'permission denied' });

    await expect(
      fetchChallengeRanking({ rpc } as never, { challengeId: CHALLENGE_ID, userId: USER_ID, showNames: false }),
    ).rejects.toThrow(/get_org_challenge_ranking/);
  });
});

describe('メンバーに見せるチャレンジ', () => {
  const base = {
    id: CHALLENGE_ID,
    title: '朝食チャレンジ',
    description: '説明',
    challenge_type: 'breakfast_rate',
    target_value: '80',
    target_unit: '%',
    start_date: '2026-10-01',
    end_date: '2026-10-31',
    reward_description: '景品',
    status: 'active',
    department_id: null as string | null,
  };

  it('食事の記録から計算できる種類で、部署の限定が無ければ、誰にでも見せる', () => {
    expect(isVisibleToMember(base, { department_id: null })).toBe(true);
    expect(isVisibleToMember(base, { department_id: 'd-1' })).toBe(true);
  });

  it('部署を限定したチャレンジは、その部署のメンバーにだけ見せる', () => {
    const limited = { ...base, department_id: 'd-1' };
    expect(isVisibleToMember(limited, { department_id: 'd-1' })).toBe(true);
    expect(isVisibleToMember(limited, { department_id: 'd-2' })).toBe(false);
    expect(isVisibleToMember(limited, { department_id: null })).toBe(false);
  });

  it.each(['steps', 'weight_loss', 'custom'])('使えない種類 (%s) は見せない', (type) => {
    expect(isVisibleToMember({ ...base, challenge_type: type }, { department_id: null })).toBe(false);
  });

  it('メンバー向けの形には、部署 ID など管理用の項目を含めない。目標値は数にする', () => {
    const dto = toMemberChallengeDto({ ...base, department_id: 'd-1' }, '2026-10-08');

    expect(dto).toEqual({
      id: CHALLENGE_ID,
      title: '朝食チャレンジ',
      description: '説明',
      challengeType: 'breakfast_rate',
      targetValue: 80,
      targetUnit: '%',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      rewardDescription: '景品',
      status: 'active',
    });
    expect(JSON.stringify(dto)).not.toContain('d-1');
  });

  it('状態: 開催中のままでも、終了日 (JST) を過ぎていれば「終了」として返す。終了日の当日はまだ開催中', () => {
    expect(toMemberChallengeDto(base, '2026-10-31').status).toBe('active'); // 終了日の当日
    expect(toMemberChallengeDto(base, '2026-11-01').status).toBe('completed'); // 終了日の翌日
    expect(toMemberChallengeDto(base, '2026-09-30').status).toBe('active'); // 開始前
    // DB が終了にしたものは、そのまま
    expect(toMemberChallengeDto({ ...base, status: 'completed' }, '2026-10-05').status).toBe('completed');
  });

  it('読む列は organization_challenges の実在する列だけ', () => {
    const columns = CHALLENGE_COLUMNS.split(',').map((c) => c.trim());
    expect(columns).toEqual([
      'id',
      'title',
      'description',
      'challenge_type',
      'target_value',
      'target_unit',
      'start_date',
      'end_date',
      'reward_description',
      'status',
      'department_id',
    ]);
  });
});

describe('メンバー向け API のエラー応答', () => {
  it('challengeError は { error: { code, message } } の形', async () => {
    const res = challengeError('CHALLENGE_NOT_FOUND', 'チャレンジが見つかりません', 404);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'CHALLENGE_NOT_FOUND', message: 'チャレンジが見つかりません' } });
  });

  it('未ログイン (AuthError) は 401', async () => {
    const res = handleMemberError('GET /x', new AuthError('AUTH_UNAUTHENTICATED'));

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHORIZED');
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('組織に所属していない (ForbiddenError) は 403', async () => {
    const res = handleMemberError('GET /x', new ForbiddenError('PERM_NOT_ORG_MEMBER', '組織に所属していません'));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'FORBIDDEN', message: '組織に所属していません' } });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('想定外のエラーは 500 の汎用メッセージだけ。生のエラー文は返さず、記録にだけ残す (#1172)', async () => {
    const secret = 'relation "organization_challenge_participants" does not exist; password=hunter2';

    const res = handleMemberError('GET /x', new Error(secret));

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('organization_challenge_participants');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe('GET /x');
    expect(mockLoggerError.mock.calls[0][2]).toBeInstanceOf(Error);
  });
});
