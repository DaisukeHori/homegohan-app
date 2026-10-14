/**
 * challenges-screen.test.tsx
 * モバイルの組織管理画面「チャレンジ」(apps/mobile/app/(org)/org/challenges.tsx) の参加者数の表示 (#1132)
 *
 * 管理者には、参加者が最小人数に満たないチャレンジの人数を出さない (API が participantCount を null で返す)。
 * そのときの「n人未満」の n は、API が返した最小人数 (aggregate.minParticipants)。来ないときは
 * Web と同じ定数 ORG_CHALLENGE_MIN_PARTICIPANTS (@homegohan/shared。DB の関数と同じ値) を使う。
 * 画面に数値を直に書くと、DB の関数の値を変えたときにモバイルだけ古い人数を出すため、定数から作ることを確かめる。
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { ORG_CHALLENGE_MIN_PARTICIPANTS } from '@homegohan/shared';

import OrgChallengesPage from '../../../app/(org)/org/challenges';

// 画面が参加者数の表示を共通の整形 (formatParticipantCount) に任せていることを確かめるため、本物を呼ぶ見張りで包む
const mockFormatParticipantCount = jest.fn();
jest.mock('@homegohan/shared', () => {
  const actual = jest.requireActual('@homegohan/shared');
  return {
    ...actual,
    formatParticipantCount: (...args: unknown[]) => {
      mockFormatParticipantCount(...args);
      return actual.formatParticipantCount(...args);
    },
  };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const mockGet = jest.fn();
jest.mock('../../../src/lib/api', () => ({
  getApi: () => ({ get: (...args: unknown[]) => mockGet(...args), post: jest.fn(), put: jest.fn() }),
}));

function challenge(overrides: Record<string, unknown>) {
  return {
    id: 'c1',
    title: '朝ごはんチャレンジ',
    description: null,
    challengeType: 'breakfast_rate',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    status: 'active',
    participantCount: 7,
    ...overrides,
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockFormatParticipantCount.mockReset();
});

describe('組織管理のチャレンジ一覧の参加者数', () => {
  it('人数があればそのまま出す', async () => {
    mockGet.mockResolvedValue({ challenges: [challenge({ participantCount: 7, aggregate: { minParticipants: 5 } })] });
    render(<OrgChallengesPage />);
    await waitFor(() => expect(screen.getByText('参加 7人')).toBeTruthy());
    expect(mockGet).toHaveBeenCalledWith('/api/org/challenges');
  });

  it('人数が null のときは、API が返した最小人数で「未満」と出す', async () => {
    const min = ORG_CHALLENGE_MIN_PARTICIPANTS + 5;
    mockGet.mockResolvedValue({ challenges: [challenge({ participantCount: null, aggregate: { minParticipants: min } })] });
    render(<OrgChallengesPage />);
    await waitFor(() => expect(screen.getByText(`参加 ${min}人未満`)).toBeTruthy());
  });

  it('人数が null で API が最小人数を返さないときは、共通の定数 (DB の関数と同じ値) で「未満」と出す', async () => {
    mockGet.mockResolvedValue({ challenges: [challenge({ participantCount: null })] });
    render(<OrgChallengesPage />);
    await waitFor(() => expect(screen.getByText(`参加 ${ORG_CHALLENGE_MIN_PARTICIPANTS}人未満`)).toBeTruthy());
    // 画面は数値を直に持たず、API の値 (無ければ undefined) を共通の整形に渡す (既定値は整形の側の定数)
    expect(mockFormatParticipantCount).toHaveBeenCalledWith(null, undefined);
  });
});
