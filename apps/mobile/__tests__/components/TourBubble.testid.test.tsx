/**
 * TourBubble.testid.test.tsx
 *
 * #846: 各 Step の最初の intro 吹き出しの testID (tour-step-1-intro など) を、モバイルの吹き出し (src/handson-tour/TourBubble.tsx) が
 * 中身を包む View に付けることを確かめる。Maestro (E2E) はこの名前で intro の吹き出しを見分ける (設計書 09-onboarding-handson-tour の testID 一覧)。
 * testId を渡さない吹き出しは、今までと同じ並び (包む View を足さない) のままであることも確かめる。
 */

import React from 'react';
import { render } from '@testing-library/react-native';

import { TourBubble } from '../../src/handson-tour/TourBubble';

const INTRO_TEST_ID = 'tour-step-1-intro';
const BODY = 'まずは食事の写真を追加してみましょう';
/** 吹き出しと Spotlight の対象との距離 (TourOverlay の既定と同じ) */
const BUBBLE_OFFSET = 12;

describe('TourBubble (モバイル): intro 吹き出しの testID (#846)', () => {
  it('bubble.testId を渡すと、その testID の要素が吹き出しの中にあり、本文を含む', () => {
    const { getByTestId } = render(
      <TourBubble
        target={null}
        bubble={{ body: BODY, testId: INTRO_TEST_ID }}
        position="auto"
        offset={BUBBLE_OFFSET}
        primaryAction={{ label: '次へ', onPress: jest.fn() }}
      />,
    );

    const intro = getByTestId(INTRO_TEST_ID);
    // testID の要素の中に、本文と主ボタンがある (吹き出しの中身を包んでいる)
    expect(getByTestId('tour-bubble')).toContainElement(intro);
    expect(intro).toContainElement(getByTestId('tour-bubble-body'));
    expect(intro).toContainElement(getByTestId('tour-next-button'));
    expect(getByTestId('tour-bubble-body')).toHaveTextContent(BODY);
  });

  it('bubble.testId を渡さないと、intro の testID は付かず、本文はそのまま吹き出しの中にある', () => {
    const { getByTestId, queryByTestId } = render(
      <TourBubble target={null} bubble={{ body: BODY }} position="auto" offset={BUBBLE_OFFSET} />,
    );

    expect(queryByTestId(INTRO_TEST_ID)).toBeNull();
    expect(getByTestId('tour-bubble')).toContainElement(getByTestId('tour-bubble-body'));
  });
});
