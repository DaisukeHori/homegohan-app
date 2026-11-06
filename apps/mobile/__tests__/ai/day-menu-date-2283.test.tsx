/**
 * day-menu-date-2283.test.tsx
 * #2283 モバイルの AI 相談の「1日献立変更」のモーダル (AIDayMenuModal) の日付を、Web の AI 相談 (#2245 K1・L1) にそろえる
 *
 * 以前のモーダルは、既定が今日で、日付の形と実在だけを見ていたので、過去の日も遠い先の日も依頼できた。
 * 1. 既定は明日 (JST の今日の翌日)。そのまま「作成する」を押すと、明日の朝・昼・夕を依頼する
 * 2. 範囲 (今日〜14 日後) の外・空・形の崩れ・実在しない日は、「作成する」が止まり、理由の一文が出る (依頼しない)
 * 3. 範囲の中 (端の今日と 14 日後を含む) は、今まで通り依頼でき、理由の一文は出ない
 * 4. 開くたびに既定の日を求め直す (前に開いたときに打った日・日をまたいだ前の日の明日が残らない)
 * 5. 欄の下に、選べる範囲の案内を出す
 * 文と値が Web と同じことは tests/mobile-ai-day-menu-date-2283.test.ts が Web の部品と突き合わせて確かめる。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockPost = jest.fn();
/** モーダルが読む JST の今日 (todayLocal) */
let mockToday = '2026-11-06';

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: jest.fn(), post: mockPost, del: jest.fn(), patch: jest.fn() }),
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: { channel: jest.fn(), from: jest.fn(), removeChannel: jest.fn() },
}));

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

jest.mock('@homegohan/shared', () => ({
  ...jest.requireActual('@homegohan/shared'),
  todayLocal: () => mockToday,
}));

import React from 'react';
import { AIDayMenuModal } from '../../src/components/ai/AIDayMenuModal';
import { DAY_MENU_DATE_RANGE_HINT, DAY_MENU_DATE_UNSELECTABLE_MESSAGE } from '../../src/lib/ai-day-menu-date';
import { resetAiConsentPromptForTests } from '../../src/lib/ai-consent';

const DAY_MENU_GENERATE_PATH = '/api/ai/menu/v4/generate';
const TODAY = '2026-11-06';
const TOMORROW = '2026-11-07';
const DAY_AFTER_TOMORROW = '2026-11-08';
/** 範囲の上の端 (今日の 14 日後) と、その翌日 */
const LAST_SELECTABLE_DAY = '2026-11-20';
const FIRST_DAY_AFTER_RANGE = '2026-11-21';
const YESTERDAY = '2026-11-05';
/** 作成ボタン */
const GENERATE_BUTTON_ID = 'ai-day-menu-generate';
const UNSELECTABLE_MESSAGE_ID = 'ai-day-menu-date-unselectable';

const alertMock = Alert.alert as jest.Mock;

beforeEach(() => {
  mockToday = TODAY;
  mockPost.mockReset();
  // 依頼の中身だけを見る (応答は失敗にして、購読などの後ろの処理に進ませない)
  mockPost.mockRejectedValue(new Error('HTTP 500 Internal Server Error'));
  alertMock.mockClear();
  resetAiConsentPromptForTests();
});

const generateCalls = () => mockPost.mock.calls.filter(([requestPath]) => requestPath === DAY_MENU_GENERATE_PATH);

/** 依頼した日 (朝・昼・夕の targetSlots の日付) */
function requestedDates(): string[] {
  return generateCalls().flatMap(([, body]) =>
    (body as { targetSlots: { date: string }[] }).targetSlots.map((slot) => slot.date),
  );
}

function renderModal() {
  return render(<AIDayMenuModal visible onClose={jest.fn()} onAiConsentRequired={jest.fn()} />);
}

function dateInput() {
  return screen.getByPlaceholderText('YYYY-MM-DD');
}

describe('#2283 1 既定は明日', () => {
  it('開いたときの日付の欄は明日で、そのまま押すと明日の朝・昼・夕を依頼する', async () => {
    renderModal();
    expect(dateInput().props.value).toBe(TOMORROW);
    expect(screen.queryByTestId(UNSELECTABLE_MESSAGE_ID)).toBeNull();

    fireEvent.press(screen.getByTestId(GENERATE_BUTTON_ID));
    await waitFor(() => expect(generateCalls()).toHaveLength(1));
    expect(requestedDates()).toEqual([TOMORROW, TOMORROW, TOMORROW]);
  });
});

describe('#2283 2 範囲の外・空・形の崩れは「作成する」が止まり、理由の一文が出る', () => {
  it.each([
    ['昨日 (範囲の下の外)', YESTERDAY],
    ['15 日後 (範囲の上の外)', FIRST_DAY_AFTER_RANGE],
    ['空', ''],
    ['形の崩れ', '2026/11/10'],
    ['打ちかけ', '2026-11-1'],
    ['実在しない日', '2026-11-31'],
  ])('%s (%s)', async (_label, value) => {
    renderModal();
    fireEvent.changeText(dateInput(), value);

    expect(screen.getByTestId(UNSELECTABLE_MESSAGE_ID)).toHaveTextContent(DAY_MENU_DATE_UNSELECTABLE_MESSAGE);
    expect(screen.getByTestId(GENERATE_BUTTON_ID)).toBeDisabled();

    fireEvent.press(screen.getByTestId(GENERATE_BUTTON_ID));
    // 押しても依頼しない (止める前は、過去の日・遠い先の日もそのまま依頼していた)
    await new Promise((resolve) => setImmediate(resolve));
    expect(generateCalls()).toHaveLength(0);
  });
});

describe('#2283 3 範囲の中は今まで通り依頼できる', () => {
  it.each([
    ['今日 (範囲の下の端)', TODAY],
    ['14 日後 (範囲の上の端)', LAST_SELECTABLE_DAY],
  ])('%s (%s)', async (_label, value) => {
    renderModal();
    fireEvent.changeText(dateInput(), value);

    expect(screen.queryByTestId(UNSELECTABLE_MESSAGE_ID)).toBeNull();
    expect(screen.getByTestId(GENERATE_BUTTON_ID)).not.toBeDisabled();

    fireEvent.press(screen.getByTestId(GENERATE_BUTTON_ID));
    await waitFor(() => expect(generateCalls()).toHaveLength(1));
    expect(requestedDates()).toEqual([value, value, value]);
  });

  it('範囲の外から範囲の中へ打ち直すと、理由の一文が消えて押せる', async () => {
    renderModal();
    fireEvent.changeText(dateInput(), YESTERDAY);
    expect(screen.getByTestId(UNSELECTABLE_MESSAGE_ID)).toBeTruthy();

    fireEvent.changeText(dateInput(), LAST_SELECTABLE_DAY);
    expect(screen.queryByTestId(UNSELECTABLE_MESSAGE_ID)).toBeNull();
    fireEvent.press(screen.getByTestId(GENERATE_BUTTON_ID));
    await waitFor(() => expect(generateCalls()).toHaveLength(1));
  });
});

describe('#2283 4 開くたびに既定の日を求め直す', () => {
  it('打ち直した日は閉じて開き直すと明日に戻り、日をまたいだら新しい明日になる', () => {
    const view = render(<AIDayMenuModal visible onClose={jest.fn()} onAiConsentRequired={jest.fn()} />);
    fireEvent.changeText(dateInput(), LAST_SELECTABLE_DAY);

    view.rerender(<AIDayMenuModal visible={false} onClose={jest.fn()} onAiConsentRequired={jest.fn()} />);
    // 閉じている間に日をまたいだ (JST の今日が明日になった)
    mockToday = TOMORROW;
    view.rerender(<AIDayMenuModal visible onClose={jest.fn()} onAiConsentRequired={jest.fn()} />);

    expect(dateInput().props.value).toBe(DAY_AFTER_TOMORROW);
  });

  it('日をまたいで、開いたままの欄の日が範囲の外になったら止める (押した時点の今日で見る)', async () => {
    const view = renderModal();
    fireEvent.changeText(dateInput(), TODAY);
    mockToday = TOMORROW;
    view.rerender(<AIDayMenuModal visible onClose={jest.fn()} onAiConsentRequired={jest.fn()} />);

    expect(screen.getByTestId(UNSELECTABLE_MESSAGE_ID)).toBeTruthy();
    fireEvent.press(screen.getByTestId(GENERATE_BUTTON_ID));
    await new Promise((resolve) => setImmediate(resolve));
    expect(generateCalls()).toHaveLength(0);
  });
});

describe('#2283 5 選べる範囲の案内', () => {
  it('欄の下に、Web と同じ案内を出す', () => {
    renderModal();
    expect(screen.getByText(DAY_MENU_DATE_RANGE_HINT)).toBeTruthy();
  });
});
