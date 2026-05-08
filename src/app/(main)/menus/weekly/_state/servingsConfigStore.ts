// Refactor B Phase B-1: 配膳設定 state 集約 store
import { create } from 'zustand';
import type { ServingsConfig } from '@/types/domain';

interface ServingsConfigState {
  servingsConfig: ServingsConfig | null;
  isLoadingServingsConfig: boolean;
}

interface ServingsConfigActions {
  setServingsConfig: (config: ServingsConfig | null) => void;
  setIsLoadingServingsConfig: (isLoading: boolean) => void;
}

export const useServingsConfigStore = create<ServingsConfigState & ServingsConfigActions>()(
  (set) => ({
    servingsConfig: null,
    isLoadingServingsConfig: false,

    setServingsConfig: (config) => set({ servingsConfig: config }),
    setIsLoadingServingsConfig: (isLoading) => set({ isLoadingServingsConfig: isLoading }),
  })
);
