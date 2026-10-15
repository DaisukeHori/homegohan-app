/**
 * resume-guest-name.test.tsx
 * apps/mobile/app/onboarding/resume.tsx の呼びかけ (#1635)
 *
 * 名前が無いときにアプリが入れる仮置きの 'Guest' を「おかえりなさい、Guestさん！」と呼ばない。
 * 判定は Web と同じ @homegohan/shared の normalizeProfileName (前後の空白を除いて 'Guest' と厳密一致・空・空白だけは名前なし)。
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getUser: jest.fn() }, from: jest.fn() },
}));

let mockNickname: string | null = null;
jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({
    profile: {
      nickname: mockNickname,
      onboardingProgress: { currentStep: 1, totalQuestions: 4, answers: {} },
    },
    refresh: jest.fn(),
  }),
}));

jest.mock('../../src/components/ui', () => {
  const { View } = require('react-native');
  return {
    Card: ({ children }: { children?: React.ReactNode }) => <View>{children}</View>,
    ProgressBar: () => null,
  };
});

import OnboardingResume from '../../app/onboarding/resume';

beforeEach(() => {
  mockNickname = null;
});

describe('初期設定の再開画面の呼びかけ (#1635)', () => {
  it.each(['Guest', ' Guest ', 'Guest\n'])("仮置き '%s' は名前として呼ばず「おかえりなさい！」だけにする", (nickname) => {
    mockNickname = nickname;
    render(<OnboardingResume />);

    expect(screen.getByText('おかえりなさい！')).toBeTruthy();
    expect(screen.queryByText(/Guest/)).toBeNull();
  });

  it.each([null, '', '   '])('名前が無い (%j) ときも「おかえりなさい！」', (nickname) => {
    mockNickname = nickname;
    render(<OnboardingResume />);

    expect(screen.getByText('おかえりなさい！')).toBeTruthy();
  });

  it.each(['太郎', 'guest', 'ゲスト'])("'%s' は本人が付けた名前として呼ぶ", (nickname) => {
    mockNickname = nickname;
    render(<OnboardingResume />);

    expect(screen.getByText(`おかえりなさい、\n${nickname}さん！`)).toBeTruthy();
  });

  it('本人が付けた名前は前後の空白を除いて呼ぶ', () => {
    mockNickname = '  太郎 ';
    render(<OnboardingResume />);

    expect(screen.getByText('おかえりなさい、\n太郎さん！')).toBeTruthy();
  });
});
