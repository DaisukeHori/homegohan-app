// src/__tests__/app/menus/weekly/state/servingsConfigStore.test.ts
// Issue #1031: page.tsx の servingsConfig/isLoadingServingsConfig local useState を
// useServingsConfigStore に一本化。旧実装は fetchUserSettings の結果を local state に
// しか書かず、ServingsModal が読む store は常に null のままだった (#1031 の症状)。
// この回帰を防ぐため、store への書き込みが正しく読み出せることを固定する。

import { describe, it, expect, beforeEach } from 'vitest';
import { useServingsConfigStore } from '@/app/(main)/menus/weekly/_state/servingsConfigStore';

describe('useServingsConfigStore', () => {
  beforeEach(() => {
    useServingsConfigStore.setState({ servingsConfig: null, isLoadingServingsConfig: false });
  });

  it('初期状態は null / false', () => {
    const s = useServingsConfigStore.getState();
    expect(s.servingsConfig).toBeNull();
    expect(s.isLoadingServingsConfig).toBe(false);
  });

  it('setServingsConfig で書き込んだ値が getState() で読み出せる (page.tsx fetchUserSettings 相当)', () => {
    useServingsConfigStore.getState().setIsLoadingServingsConfig(true);
    useServingsConfigStore.getState().setServingsConfig({ default: 4, byDayMeal: {} });
    useServingsConfigStore.getState().setIsLoadingServingsConfig(false);

    const s = useServingsConfigStore.getState();
    expect(s.servingsConfig).toEqual({ default: 4, byDayMeal: {} });
    expect(s.isLoadingServingsConfig).toBe(false);
  });

  it('ServingsModal onSave 相当: getState().servingsConfig を都度読む', () => {
    useServingsConfigStore.getState().setServingsConfig({ default: 2, byDayMeal: { monday: { breakfast: 3 } } });
    const currentServingsConfig = useServingsConfigStore.getState().servingsConfig;
    expect(currentServingsConfig?.byDayMeal?.monday?.breakfast).toBe(3);
  });
});
