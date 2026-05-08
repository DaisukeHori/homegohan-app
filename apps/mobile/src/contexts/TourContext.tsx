// TourContext — Mobile 版
// Canonical: docs/design/family/09-onboarding-handson-tour/16-files-structure.md §1.3

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { TourState } from '@homegohan/handson-tour-shared';

type TourContextValue = {
  /** 現在のツアー state */
  tourState: TourState;
  /** Step を進める */
  advanceStep: () => void;
  /** ツアーをスキップ */
  skipTour: () => void;
  /** analytics 用 dwell 時間を記録 */
  recordStepDwell: (step: number, ms: number) => void;
  /** entrySource をセット */
  setEntrySource: (source: 'auto' | 'settings_force') => void;
};

const TourContext = createContext<TourContextValue | null>(null);

interface TourProviderProps {
  children: React.ReactNode;
  initialEntrySource?: 'auto' | 'settings_force';
}

export function TourProvider({ children, initialEntrySource = 'auto' }: TourProviderProps) {
  const [tourState, setTourState] = useState<TourState>({
    currentStep: 0,
    tourStartTimestamp: Date.now(),
    entrySource: initialEntrySource,
    stepDwellMs: {},
    forceMode: initialEntrySource === 'settings_force',
  });

  const advanceStep = useCallback(() => {
    setTourState((prev) => ({
      ...prev,
      currentStep: Math.min(prev.currentStep + 1, 5) as TourState['currentStep'],
    }));
  }, []);

  const skipTour = useCallback(() => {
    setTourState((prev) => ({
      ...prev,
      currentStep: 5,
    }));
  }, []);

  const recordStepDwell = useCallback((step: number, ms: number) => {
    setTourState((prev) => ({
      ...prev,
      stepDwellMs: { ...prev.stepDwellMs, [step]: ms },
    }));
  }, []);

  const setEntrySource = useCallback((source: 'auto' | 'settings_force') => {
    setTourState((prev) => ({
      ...prev,
      entrySource: source,
      forceMode: source === 'settings_force',
    }));
  }, []);

  const value = useMemo(
    () => ({
      tourState,
      advanceStep,
      skipTour,
      recordStepDwell,
      setEntrySource,
    }),
    [tourState, advanceStep, skipTour, recordStepDwell, setEntrySource]
  );

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTourContext(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTourContext must be used within <TourProvider>');
  return ctx;
}
