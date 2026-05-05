export interface Reaction {
  aType: string;
  aState: number;
  bType: string;
  bState: number;
  cType: string;
  cState: number;
  currentAbBond: boolean;
  currentBcBond: boolean;
  currentAcBond: boolean;
  futureAState: number;
  futureBState: number;
  futureCState: number;
  futureAbBond: boolean;
  futureBcBond: boolean;
  futureAcBond: boolean;
  cases: number;
  nInputs: 2 | 3;
}

// 2-input reaction — mirrors the 2-reactant SquirmReaction constructor.
// _aeoa (assignEnzymeOfA) is preserved for signature parity with the original C++ but unused.
export function r2(
  aType: string, aState: number, currentAbBond: boolean,
  bType: string, bState: number,
  futureAState: number, futureAbBond: boolean, futureBState: number,
  _aeoa: boolean,
  cases = 1,
): Reaction {
  return {
    aType, aState, bType, bState, cType: '', cState: 0,
    currentAbBond, currentBcBond: false, currentAcBond: false,
    futureAState, futureBState, futureCState: 0,
    futureAbBond, futureBcBond: false, futureAcBond: false,
    cases, nInputs: 2,
  };
}

// 3-input reaction — mirrors the 3-reactant SquirmReaction constructor
export function r3(
  aType: string, aState: number, currentAbBond: boolean,
  bType: string, bState: number, currentBcBond: boolean,
  cType: string, cState: number, currentAcBond: boolean,
  futureAState: number, futureAbBond: boolean,
  futureBState: number, futureBcBond: boolean,
  futureCState: number, futureAcBond: boolean,
  cases = 1,
): Reaction {
  return {
    aType, aState, bType, bState, cType, cState,
    currentAbBond, currentBcBond, currentAcBond,
    futureAState, futureBState, futureCState,
    futureAbBond, futureBcBond, futureAcBond,
    cases, nInputs: 3,
  };
}
