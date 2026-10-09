/**
 * day-menu-consent.test.tsx
 * 1日献立の作成 (AIDayMenuModal) の失敗の扱い (T15 / #1154)
 *
 * 1. 「同意が必要です」(403 AI_CONSENT_REQUIRED) で止められたら、エラーの Alert は出さず、モーダルを閉じてから
 *    同意画面への案内を 1 回だけ出す。作成ボタンの処理 (handleGenerate) は例外を外へ出さない (未処理の reject にしない)
 * 2. それ以外の失敗は、これまでどおりフックの onError が「エラー」を出す。作成ボタンの処理はこの場合も例外を外へ出さない
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockPost = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: jest.fn(), post: mockPost, del: jest.fn(), patch: jest.fn() }),
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: { channel: jest.fn(), from: jest.fn(), removeChannel: jest.fn() },
}));

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

import React from 'react';
import { AIDayMenuModal } from '../../src/components/ai/AIDayMenuModal';
import { resetAiConsentPromptForTests } from '../../src/lib/ai-consent';
import { AI_CONSENT_REQUIRED_CODE, AI_CONSENT_REQUIRED_MESSAGE } from '../../../../supabase/functions/_shared/ai-consent';

// 最初の描画 (RN の Modal の初回描画) は読み込むモジュールが多く、キャッシュの無い環境では 5 秒の既定を超えることがある
jest.setTimeout(30000);

const alertMock = Alert.alert as jest.Mock;

beforeEach(() => {
  mockPost.mockReset();
  alertMock.mockClear();
  resetAiConsentPromptForTests();
});

function alertTitles(): string[] {
  return alertMock.mock.calls.map((call) => call[0] as string);
}

describe('AIDayMenuModal: 作成の失敗', () => {
  it('「同意が必要です」で止められたら、エラーは出さず、モーダルを閉じてから案内を 1 回だけ出す', async () => {
    mockPost.mockRejectedValue(
      new Error(`HTTP 403 Forbidden: ${JSON.stringify({ error: AI_CONSENT_REQUIRED_MESSAGE, code: AI_CONSENT_REQUIRED_CODE })}`),
    );
    const onClose = jest.fn();
    render(<AIDayMenuModal visible onClose={onClose} />);

    // 作成ボタンの処理は例外を外へ出さない (ボタンの onPress から呼ばれるため)
    await expect(fireEvent.press(screen.getByText('作成する'))).resolves.toBeUndefined();

    await waitFor(() => expect(alertTitles()).toEqual(['同意が必要です']));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(alertTitles()).not.toContain('エラー');
  });

  it('それ以外の失敗は「エラー」を 1 回出し、作成ボタンの処理は例外を外へ出さない', async () => {
    mockPost.mockRejectedValue(new Error('HTTP 500 Internal Server Error'));
    const onClose = jest.fn();
    render(<AIDayMenuModal visible onClose={onClose} />);

    await expect(fireEvent.press(screen.getByText('作成する'))).resolves.toBeUndefined();

    await waitFor(() => expect(alertTitles()).toEqual(['エラー']));
    expect(alertMock).toHaveBeenCalledWith('エラー', 'HTTP 500 Internal Server Error');
    expect(onClose).not.toHaveBeenCalled();
  });
});
