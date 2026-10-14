import { describe, it, expect, vi } from 'vitest';
import {
  FAMILY_MEMBER_NAMES_API_PATH,
  PROFILE_NAME_PLACEHOLDER,
  applyFamilyMemberNames,
  buildFamilyMemberNames,
  fetchFamilyMemberNames,
  userIdsNeedingProfileName,
} from '@/lib/membership/family-member-names';

// 家族の画面に出すメンバーの名前の決め方 (#1584)。
// display_name → 本人のプロフィールの今の名前 (仮置きの 'Guest' は名前とみなさない) → null (画面は「名前未設定」) の順。

const M1 = '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01';
const M2 = '20eebc99-9c0b-4ef8-bb6d-6bb9bd380a02';
const M3 = '30eebc99-9c0b-4ef8-bb6d-6bb9bd380a03';
const U1 = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const U2 = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';

describe('userIdsNeedingProfileName', () => {
  it('display_name が無い (NULL・空・空白だけ) アカウントのあるメンバーの user_id だけを、重複なしで返す', () => {
    expect(
      userIdsNeedingProfileName([
        { id: M1, user_id: U1, display_name: null },
        { id: M2, user_id: U2, display_name: '  ' },
        { id: M3, user_id: U1, display_name: '' },
        { id: 'named', user_id: 'u-named', display_name: 'パパ' },
        { id: 'child', user_id: null, display_name: null },
      ]),
    ).toEqual([U1, U2]);
  });
});

describe('buildFamilyMemberNames', () => {
  const profileNames = new Map([
    [U1, '太郎'],
    [U2, '  '],
  ]);

  it('display_name があればそれ、無ければプロフィールの名前、両方無ければ null', () => {
    expect(
      buildFamilyMemberNames(
        [
          { id: M1, user_id: U1, display_name: ' パパ ' },
          { id: M2, user_id: U1, display_name: null },
          { id: M3, user_id: U2, display_name: null },
          { id: 'child', user_id: null, display_name: null },
          { id: 'unknown', user_id: 'u-missing', display_name: null },
        ],
        profileNames,
      ),
    ).toEqual([
      { id: M1, name: 'パパ' },
      { id: M2, name: '太郎' },
      { id: M3, name: null },
      { id: 'child', name: null },
      { id: 'unknown', name: null },
    ]);
  });

  it("プロフィールの名前が仮置きの 'Guest' (初期設定より前に招待を承諾した人) なら、名前が無い人と同じく null", () => {
    // 初期設定より前に承諾すると user_profiles は nickname='Guest' で作られる。英語の 'Guest' を家族の画面に出さない
    expect(PROFILE_NAME_PLACEHOLDER).toBe('Guest');
    expect(
      buildFamilyMemberNames(
        [
          { id: M1, user_id: U1, display_name: null },
          { id: M2, user_id: U2, display_name: null },
          // display_name を付けていれば、プロフィールが仮置きでもその呼び名を出す
          { id: M3, user_id: U1, display_name: 'パパ' },
        ],
        new Map([
          [U1, 'Guest'],
          [U2, '  Guest  '],
        ]),
      ),
    ).toEqual([
      { id: M1, name: null },
      { id: M2, name: null },
      { id: M3, name: 'パパ' },
    ]);
  });

  it("仮置きの判定は 'Guest' との厳密一致 (onboarding/status と同じ) で、それ以外の名前はそのまま出す", () => {
    expect(
      buildFamilyMemberNames(
        [
          { id: M1, user_id: U1, display_name: null },
          { id: M2, user_id: U2, display_name: null },
        ],
        new Map([
          [U1, 'guest'],
          [U2, 'Guest太郎'],
        ]),
      ),
    ).toEqual([
      { id: M1, name: 'guest' },
      { id: M2, name: 'Guest太郎' },
    ]);
  });
});

describe('fetchFamilyMemberNames', () => {
  function respond(body: unknown, status = 200) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }));
  }

  it('API の名前を member id → 名前の Map にする (名前が null の人は入れない)', async () => {
    const fetchImpl = respond({ data: { members: [{ id: M1, name: '太郎' }, { id: M2, name: null }] } });

    const names = await fetchFamilyMemberNames(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(FAMILY_MEMBER_NAMES_API_PATH, { cache: 'no-store' });
    expect([...names.entries()]).toEqual([[M1, '太郎']]);
  });

  it('失敗の応答・形の違う応答・通信の失敗では、例外を投げず空の Map を返す', async () => {
    expect((await fetchFamilyMemberNames(respond({ error: { code: 'NOT_AUTHENTICATED' } }, 401))).size).toBe(0);
    expect((await fetchFamilyMemberNames(respond({ data: { members: [{ id: M1, name: 1 }] } }))).size).toBe(0);
    expect(
      (await fetchFamilyMemberNames(vi.fn(async () => new Response('not json', { status: 200 })))).size,
    ).toBe(0);
    expect(
      (
        await fetchFamilyMemberNames(
          vi.fn(async () => {
            throw new TypeError('fetch failed');
          }),
        )
      ).size,
    ).toBe(0);
  });
});

describe('applyFamilyMemberNames', () => {
  it('名前が決まった人だけ display_name を置き換え、ほかの列と名前が決まらない人はそのまま', () => {
    const members = [
      { id: M1, display_name: null, role: 'adult' },
      { id: M2, display_name: 'パパ', role: 'adult' },
      { id: M3, display_name: null, role: 'child' },
    ];

    const applied = applyFamilyMemberNames(members, new Map([[M1, '太郎'], [M2, 'パパ']]));

    expect(applied).toEqual([
      { id: M1, display_name: '太郎', role: 'adult' },
      { id: M2, display_name: 'パパ', role: 'adult' },
      { id: M3, display_name: null, role: 'child' },
    ]);
    // 元の配列は書き換えない
    expect(members[0].display_name).toBeNull();
  });
});
