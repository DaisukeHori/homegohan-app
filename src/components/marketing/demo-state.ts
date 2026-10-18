// src/components/marketing/demo-state.ts の型と初期値 (逐語の正典)。
// demoReducer と selectedSampleId の中身は、docs/design/marketing/01-landing-site.md §13.3 のデモの遷移表の全行を満たすように書く
// (U-11 が全行を確かめる)。React に依存しない純関数。DemoSection.tsx が useReducer で使う。
export type DemoSampleKey = 'salad-bowl' | 'salmon-plate' | 'pesto-pasta';

export type DemoState =
  | { phase: 'idle' }
  | { phase: 'analyzing'; sampleId: DemoSampleKey; startedAt: number }
  | { phase: 'result'; sampleId: DemoSampleKey };

export type DemoEvent =
  | { type: 'select'; sampleId: DemoSampleKey; now: number }
  | { type: 'finish'; sampleId: DemoSampleKey }
  | { type: 'reset' };

export const DEMO_INITIAL_STATE: DemoState = { phase: 'idle' };

/** demoReducer の型。「変化なし」の行は、受け取った state をそのまま (同じ参照で) 返す */
export type DemoReducer = (state: DemoState, event: DemoEvent) => DemoState;
/** selectedSampleId の型。idle は null、それ以外は state.sampleId */
export type SelectedSampleIdOf = (state: DemoState) => DemoSampleKey | null;

/**
 * デモの状態機械 (docs/design/marketing/01-landing-site.md §13.3 のデモの遷移表の全行)。
 *  idle      + select(id)            → analyzing(id)
 *  idle      + finish(any)           → idle (変化なし。同じ参照)
 *  analyzing + select(any)           → analyzing (変化なし。同じ参照)
 *  analyzing + finish(同じ id)       → result(id)
 *  analyzing + finish(違う id)       → analyzing (変化なし。古いタイマー)
 *  result    + select(id2)           → analyzing(id2) (もう一度分析する)
 *  result    + finish(any)           → result (変化なし。同じ参照)
 *  any       + reset                 → idle
 */
export const demoReducer: DemoReducer = (state, event) => {
  switch (event.type) {
    case 'select':
      if (state.phase === 'analyzing') return state;
      return { phase: 'analyzing', sampleId: event.sampleId, startedAt: event.now };
    case 'finish':
      if (state.phase !== 'analyzing') return state;
      if (state.sampleId !== event.sampleId) return state;
      return { phase: 'result', sampleId: state.sampleId };
    case 'reset':
      return DEMO_INITIAL_STATE;
  }
};

/** 選ばれている見本の id。idle は null */
export const selectedSampleId: SelectedSampleIdOf = (state) => (state.phase === 'idle' ? null : state.sampleId);
