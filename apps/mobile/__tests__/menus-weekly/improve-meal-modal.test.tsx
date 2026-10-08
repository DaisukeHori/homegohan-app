/**
 * ImproveMealModal (献立を改善) のテスト (#1138)
 *
 * 以前は存在しない API (POST /api/ai/menu/meal/improve) を直接呼んでいて、押すと必ず
 * 「改善に失敗しました」になっていた。今は API を直接呼ばず、親が渡す onSubmit に
 * {date, mealTypes, nextDay, advice} を渡す (親が既存の v4 生成に委譲する)。
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// モーダルは API を直接呼ばない。呼ばれたら失敗させるために spy を置く。
const mockPost = jest.fn();
const mockGetApi = jest.fn(() => ({ post: mockPost, get: jest.fn() }));
jest.mock('../../src/lib/api', () => ({
  getApi: () => mockGetApi(),
}));

import { ImproveMealModal } from '../../src/components/menu/ImproveMealModal';
import { ImproveMealRejectedError } from '../../src/lib/improve-meal';

const alertMock = Alert.alert as jest.Mock;

function renderModal(props: Partial<React.ComponentProps<typeof ImproveMealModal>> = {}) {
  const onClose = jest.fn();
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  const utils = render(
    <ImproveMealModal
      visible
      onClose={onClose}
      selectedDate="2026-10-08"
      onSubmit={onSubmit}
      {...props}
    />,
  );
  return { ...utils, onClose, onSubmit };
}

beforeEach(() => {
  mockPost.mockReset();
  mockGetApi.mockClear();
  alertMock.mockClear();
});

describe('ImproveMealModal: 送信', () => {
  it('初期状態 (朝・昼・夕) で送信すると onSubmit に選択内容を渡し、成功したら閉じる', async () => {
    const { getByTestId, onSubmit, onClose } = renderModal();

    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      date: '2026-10-08',
      mealTypes: ['breakfast', 'lunch', 'dinner'],
      nextDay: false,
      advice: undefined,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('存在しない API (/api/ai/menu/meal/improve) を直接呼ばない', async () => {
    const { getByTestId, onSubmit } = renderModal();

    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockGetApi).not.toHaveBeenCalled();
  });

  it('昼・夕を外して翌日トグルをオンにすると、朝のみ・翌日で渡す', async () => {
    const { getByTestId, getByText, onSubmit } = renderModal();

    fireEvent.press(getByTestId('improve-meal-type-lunch'));
    fireEvent.press(getByTestId('improve-meal-type-dinner'));
    fireEvent.press(getByTestId('improve-meal-next-day-toggle'));

    expect(getByText('翌日 1 食分を改善')).toBeTruthy();
    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-10-08', mealTypes: ['breakfast'], nextDay: true }),
    );
  });

  it('選んだ順番に関係なく 朝→昼→夕 の順で渡す', async () => {
    const { getByTestId, onSubmit } = renderModal();

    // 全部外してから 夕 → 朝 の順に選び直す
    fireEvent.press(getByTestId('improve-meal-type-breakfast'));
    fireEvent.press(getByTestId('improve-meal-type-lunch'));
    fireEvent.press(getByTestId('improve-meal-type-dinner'));
    fireEvent.press(getByTestId('improve-meal-type-dinner'));
    fireEvent.press(getByTestId('improve-meal-type-breakfast'));
    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].mealTypes).toEqual(['breakfast', 'dinner']);
  });

  it('AI 栄養士の提案 (advice) を onSubmit にそのまま渡す', async () => {
    const { getByTestId, onSubmit } = renderModal({ advice: 'たんぱく質が不足しています' });

    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].advice).toBe('たんぱく質が不足しています');
  });

  it('食事を 1 つも選んでいなければ送信できない', async () => {
    const { getByTestId, onSubmit } = renderModal();

    fireEvent.press(getByTestId('improve-meal-type-breakfast'));
    fireEvent.press(getByTestId('improve-meal-type-lunch'));
    fireEvent.press(getByTestId('improve-meal-type-dinner'));
    fireEvent.press(getByTestId('improve-meal-submit'));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('送信中に連打しても onSubmit は 1 回だけ', async () => {
    let finish: () => void = () => {};
    const onSubmit = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { getByTestId, onClose } = renderModal({ onSubmit });

    fireEvent.press(getByTestId('improve-meal-submit'));
    fireEvent.press(getByTestId('improve-meal-submit'));
    fireEvent.press(getByTestId('improve-meal-submit'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      finish();
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('ImproveMealModal: 失敗時', () => {
  it('onSubmit が失敗したらエラーを表示し、モーダルは開いたまま再試行できる', async () => {
    const onSubmit = jest
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 500 Internal Server Error'))
      .mockResolvedValueOnce(undefined);
    const { getByTestId, onClose } = renderModal({ onSubmit });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(alertMock).toHaveBeenCalledTimes(1));
    expect(alertMock).toHaveBeenCalledWith('エラー', '改善に失敗しました。もう一度お試しください。');
    expect(onClose).not.toHaveBeenCalled();

    // 送信中表示が戻り、もう一度押せる
    await waitFor(() => expect(getByTestId('improve-meal-submit')).toBeTruthy());
    fireEvent.press(getByTestId('improve-meal-submit'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    errorSpy.mockRestore();
  });

  it('利用者向けの理由つきエラー (生成中・過去日など) はその文言を表示する', async () => {
    const onSubmit = jest
      .fn()
      .mockRejectedValue(new ImproveMealRejectedError('別の献立を生成中です。完了してからもう一度お試しください。'));
    const { getByTestId, onClose } = renderModal({ onSubmit });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(alertMock).toHaveBeenCalledTimes(1));
    expect(alertMock).toHaveBeenCalledWith('エラー', '別の献立を生成中です。完了してからもう一度お試しください。');
    expect(onClose).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('ImproveMealModal: その他', () => {
  it('キャンセル (閉じる) で onClose が呼ばれ、onSubmit は呼ばれない', () => {
    const { getByTestId, onClose, onSubmit } = renderModal();

    fireEvent.press(getByTestId('improve-meal-close'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('visible=false のときは何も表示しない', () => {
    const { queryByTestId } = renderModal({ visible: false });
    expect(queryByTestId('improve-meal-modal')).toBeNull();
  });
});
