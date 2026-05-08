// Refactor B Phase B-1: 冷蔵庫 state 集約 store
import { create } from 'zustand';
import type { PantryItem } from '@/types/domain';

interface PantryState {
  fridgeItems: PantryItem[];
}

interface PantryActions {
  setFridgeItems: (items: PantryItem[]) => void;
  addFridgeItem: (item: PantryItem) => void;
  removeFridgeItem: (id: string) => void;
  updateFridgeItem: (id: string, patch: Partial<PantryItem>) => void;
}

export const usePantryStore = create<PantryState & PantryActions>()((set) => ({
  fridgeItems: [],

  setFridgeItems: (items) => set({ fridgeItems: items }),

  addFridgeItem: (item) =>
    set((state) => ({ fridgeItems: [...state.fridgeItems, item] })),

  removeFridgeItem: (id) =>
    set((state) => ({
      fridgeItems: state.fridgeItems.filter((item) => item.id !== id),
    })),

  updateFridgeItem: (id, patch) =>
    set((state) => ({
      fridgeItems: state.fridgeItems.map((item) =>
        item.id === id ? { ...item, ...patch } : item
      ),
    })),
}));
