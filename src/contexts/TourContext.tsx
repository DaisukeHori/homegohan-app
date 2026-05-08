'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import type { TourState } from '@homegohan/handson-tour-shared';

type TourContextValue = TourState & {
  setCurrentStep: (step: TourState['currentStep']) => void;
  recordStepDwell: (step: number, ms: number) => void;
};

const TourContext = createContext<TourContextValue | null>(null);

interface TourProviderProps {
  children: React.ReactNode;
  entrySource?: TourState['entrySource'];
  forceMode?: boolean;
}

export function TourProvider({ children, entrySource = 'auto', forceMode = false }: TourProviderProps) {
  const [currentStep, setCurrentStepState] = useState<TourState['currentStep']>(0);
  const [stepDwellMs, setStepDwellMs] = useState<Record<number, number>>({});
  const tourStartTimestampRef = useState<number>(() => Date.now())[0];

  const setCurrentStep = useCallback((step: TourState['currentStep']) => {
    setCurrentStepState(step);
  }, []);

  const recordStepDwell = useCallback((step: number, ms: number) => {
    setStepDwellMs((prev) => ({ ...prev, [step]: ms }));
  }, []);

  const value: TourContextValue = {
    currentStep,
    tourStartTimestamp: tourStartTimestampRef,
    entrySource,
    stepDwellMs,
    forceMode,
    setCurrentStep,
    recordStepDwell,
  };

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) {
    throw new Error('useTour must be used within a TourProvider');
  }
  return ctx;
}
