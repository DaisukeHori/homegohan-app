/**
 * 週間献立の「食事タイプを選択」と空きスロットの食事区分 (#1446)
 *
 * 夜食 (midnight_snack) は #1438 で正式な食事区分 (5 値) になったが、モバイルの
 * AddMealSlotModal は 4 値 (朝・昼・夕・おやつ) を手書きしていて夜食を選べなかった。
 * EmptySlot の mealType も 4 値の手書きの型だった。両方とも共有の MealType / MEAL_ORDER から導く。
 */

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

import { MEAL_LABELS, MEAL_ORDER, type MealType } from '@homegohan/shared';
import { AddMealSlotModal } from '../../src/components/menu/AddMealSlotModal';
import { EmptySlot } from '../../src/components/menu/EmptySlot';

const OPTION_TEST_ID_PREFIX = 'add-meal-slot-';
const MODAL_TEST_ID = 'add-meal-slot-modal';

function renderModal() {
  const onSelect = jest.fn<void, [MealType]>();
  const onClose = jest.fn();
  const utils = render(
    <AddMealSlotModal visible onClose={onClose} onSelect={onSelect} dayId="day-1" />,
  );
  return { ...utils, onSelect, onClose };
}

describe('AddMealSlotModal: 食事タイプの選択肢 (#1446)', () => {
  it('選択肢は MEAL_ORDER と同じ 5 件が同じ順に並ぶ (夜食を含む)', () => {
    const { getAllByTestId } = renderModal();

    const optionIds = getAllByTestId(new RegExp(`^${OPTION_TEST_ID_PREFIX}`))
      .map((el) => el.props.testID as string)
      .filter((id) => id !== MODAL_TEST_ID);

    expect(optionIds).toEqual(MEAL_ORDER.map((t) => `${OPTION_TEST_ID_PREFIX}${t}`));
    expect(optionIds).toEqual([
      'add-meal-slot-breakfast',
      'add-meal-slot-lunch',
      'add-meal-slot-dinner',
      'add-meal-slot-snack',
      'add-meal-slot-midnight_snack',
    ]);
  });

  it('各選択肢に共有の MEAL_LABELS の名前が出る', () => {
    const { getByTestId } = renderModal();

    for (const t of MEAL_ORDER) {
      expect(getByTestId(`${OPTION_TEST_ID_PREFIX}${t}`)).toHaveTextContent(MEAL_LABELS[t]);
    }
    expect(getByTestId('add-meal-slot-midnight_snack')).toHaveTextContent('夜食');
  });

  it('夜食を押すと onSelect に midnight_snack が 1 回だけ渡る', () => {
    const { getByTestId, onSelect } = renderModal();

    fireEvent.press(getByTestId('add-meal-slot-midnight_snack'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('midnight_snack');
  });
});

describe('EmptySlot: 夜食の空きスロット (#1446)', () => {
  it('mealType に midnight_snack を渡すと、その区分の空きスロットを描き、押すと onPress が呼ばれる', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <EmptySlot
        mealType="midnight_snack"
        dayId="day-1"
        dayDate="2026-10-14"
        mealLabel={MEAL_LABELS.midnight_snack}
        onPress={onPress}
      />,
    );

    const slot = getByTestId('empty-slot-day-1-midnight_snack');
    expect(slot).toHaveTextContent('+ 夜食を追加');

    fireEvent.press(slot);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
