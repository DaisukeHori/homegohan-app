/**
 * #1049: 健康診断の詳細の画面 (app/health/checkups/[id].tsx)。
 *
 * 以前はこの画面が無く、一覧の行をタップすると「Unmatched Route」の画面が出ていた。
 * Web の詳細と同じ情報 (日付・種別・施設・AI の分析・検査値と基準値と判定・画像) を、同じ基準値・判定
 * (@homegohan/shared の health-blood-test-reference) で出すことを確かめる。
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

const mockGet = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet }),
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '11111111-2222-3333-4444-555555555555' }),
  router: { back: jest.fn(), push: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

import { evaluateStatus, formatRangeText, getRangeForSex } from '@homegohan/shared';

import CheckupDetailPage from '../../app/health/checkups/[id]';

const CHECKUP_ID = '11111111-2222-3333-4444-555555555555';

const CHECKUP = {
  id: CHECKUP_ID,
  checkup_date: '2026-04-01',
  facility_name: '駅前クリニック',
  checkup_type: '定期健診',
  image_url: 'https://example.com/checkup.jpg',
  hemoglobin: 12.5,
  ldl_cholesterol: 150,
  bmi: 22,
  individual_review: {
    summary: '全体として良好です',
    concerns: ['LDL が高め'],
    positives: ['BMI が適正'],
    recommendations: ['脂質を控える'],
    riskLevel: 'medium',
  },
};

/** /api/health/checkups/:id と /api/profile の応答を決める */
function mockResponses(gender: string | null, checkup: unknown = CHECKUP) {
  mockGet.mockImplementation((path: string) => {
    if (path === `/api/health/checkups/${CHECKUP_ID}`) {
      return checkup instanceof Error ? Promise.reject(checkup) : Promise.resolve({ checkup });
    }
    if (path === '/api/profile') return Promise.resolve({ gender });
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

beforeEach(() => {
  mockGet.mockReset();
});

describe('健康診断の詳細の画面 (#1049)', () => {
  it('一覧の行の id で /api/health/checkups/:id を読み、日付・種別・施設・AI の分析・画像を出す', async () => {
    mockResponses('female');
    render(<CheckupDetailPage />);

    await waitFor(() => expect(screen.getByTestId('health-checkup-detail-screen')).toBeTruthy());
    expect(mockGet).toHaveBeenCalledWith(`/api/health/checkups/${CHECKUP_ID}`);
    expect(screen.getByText('2026/04/01')).toBeTruthy();
    expect(screen.getByText('定期健診')).toBeTruthy();
    expect(screen.getByText('駅前クリニック')).toBeTruthy();
    expect(screen.getByText('全体として良好です')).toBeTruthy();
    expect(screen.getByText('LDL が高め')).toBeTruthy();
    expect(screen.getByText('BMI が適正')).toBeTruthy();
    expect(screen.getByText('脂質を控える')).toBeTruthy();
    expect(screen.getByTestId('health-checkup-image').props.source).toEqual({ uri: CHECKUP.image_url });
  });

  it('検査値は、値のある項目だけを、性別の基準値と判定 (Web と同じ shared の判定) つきで出す', async () => {
    mockResponses('male');
    render(<CheckupDetailPage />);

    await waitFor(() => expect(screen.getByTestId('health-checkup-metric-hemoglobin')).toBeTruthy());
    // 12.5 g/dL は男性の下限 (13.5) を下回る → 「基準未満」(女性なら基準内)
    expect(evaluateStatus('hemoglobin', 12.5, 'male')).toBe('low');
    expect(screen.getByText(`基準: ${formatRangeText(getRangeForSex('hemoglobin', 'male'))}`)).toBeTruthy();
    expect(screen.getByText('基準未満')).toBeTruthy();
    expect(screen.getByTestId('health-checkup-metric-ldl_cholesterol')).toBeTruthy();
    expect(screen.getByTestId('health-checkup-metric-bmi')).toBeTruthy();
    // 値の無い項目は出さない
    expect(screen.queryByTestId('health-checkup-metric-ast')).toBeNull();
    // 性別が分かっているときは「一般基準」の注記を出さない
    expect(screen.queryByText('※ 性別未設定のため一般基準で判定しています')).toBeNull();
  });

  it('性別が分からなければ一般基準で判定し、その旨を出す', async () => {
    mockResponses(null);
    render(<CheckupDetailPage />);

    await waitFor(() => expect(screen.getByTestId('health-checkup-metric-hemoglobin')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('※ 性別未設定のため一般基準で判定しています')).toBeTruthy());
    expect(screen.getByText(`基準: ${formatRangeText(getRangeForSex('hemoglobin', null))}`)).toBeTruthy();
  });

  it('記録を読めなければ「記録が見つかりません」を出す', async () => {
    mockResponses('female', new Error('HTTP 404 Not Found: {"error":"Not found"}'));
    render(<CheckupDetailPage />);

    await waitFor(() => expect(screen.getByTestId('health-checkup-detail-not-found')).toBeTruthy());
    expect(screen.getByText('記録が見つかりません')).toBeTruthy();
  });
});
