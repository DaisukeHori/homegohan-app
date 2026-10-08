/**
 * useResetInitialPathOnBlur.test.tsx
 * 他のタブへ移ったときに initialPath を消す処理 (useResetInitialPathOnBlur) のテスト (#1049 F7-15)
 *
 * initialPath は「そのページを開いてこのタブに入る」ための一回きりの指定だが、
 * タブの route の params に残ったままで、同じ指定を渡し直しても WebView が動かない、
 * タブの先頭へ移りたいだけでも古い指定が優先される、という状態だった。
 * タブを離れたら消す。ただし、タブ画面の上にネイティブの画面を重ねたときの 'blur' では消さない。
 */

import { renderHook } from '@testing-library/react-native';

let mockInitialPath: string | undefined;
let mockParentFocused: boolean | undefined;
let mockHasParent = true;
const mockBlurListeners: Array<() => void> = [];
const mockUnsubscribe = jest.fn();

const mockNavigation = {
  addListener: jest.fn((_type: string, listener: () => void) => {
    mockBlurListeners.push(listener);
    return mockUnsubscribe;
  }),
  setParams: jest.fn(),
  getParent: jest.fn(() => (mockHasParent ? { isFocused: () => mockParentFocused } : undefined)),
};

jest.mock('expo-router', () => ({
  useNavigation: () => mockNavigation,
  useLocalSearchParams: () => (mockInitialPath === undefined ? {} : { initialPath: mockInitialPath }),
}));

import { useResetInitialPathOnBlur } from '../../src/components/web/useResetInitialPathOnBlur';

function blur() {
  for (const listener of [...mockBlurListeners]) listener();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBlurListeners.length = 0;
  mockInitialPath = '/menus/weekly?date=2026-10-08';
  mockParentFocused = true;
  mockHasParent = true;
});

describe('useResetInitialPathOnBlur', () => {
  it('別のタブへ移ったとき (タブを持つ親の画面は手前のまま) に、initialPath を消す', () => {
    renderHook(() => useResetInitialPathOnBlur());

    blur();

    expect(mockNavigation.setParams).toHaveBeenCalledTimes(1);
    expect(mockNavigation.setParams).toHaveBeenCalledWith({ initialPath: undefined });
  });

  it('タブ画面の上にネイティブの画面が重なったとき (親の画面が手前でなくなった) は消さない', () => {
    mockParentFocused = false;
    renderHook(() => useResetInitialPathOnBlur());

    blur();

    expect(mockNavigation.setParams).not.toHaveBeenCalled();
  });

  it('親の画面が取れない・状態が分からないときは消さない (今までどおりの挙動に倒す)', () => {
    mockHasParent = false;
    renderHook(() => useResetInitialPathOnBlur());
    blur();
    expect(mockNavigation.setParams).not.toHaveBeenCalled();

    mockHasParent = true;
    mockParentFocused = undefined;
    blur();
    expect(mockNavigation.setParams).not.toHaveBeenCalled();
  });

  it('initialPath が無いなら、何も購読しない', () => {
    mockInitialPath = undefined;

    renderHook(() => useResetInitialPathOnBlur());

    expect(mockNavigation.addListener).not.toHaveBeenCalled();
  });

  it('アンマウントすると購読を解除する', () => {
    const { unmount } = renderHook(() => useResetInitialPathOnBlur());

    unmount();

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
