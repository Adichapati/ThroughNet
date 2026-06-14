// The logical sensing state the live view renders. In Phase A this is driven by
// the mock control panel; later it comes from GET /api/v1/throughnet/status +
// the /ws/sensing push (ADR-151).
export interface SensingState {
  present: boolean;
  moving: boolean;
  breathing: boolean;
  bpm: number;
}

export const defaultState: SensingState = {
  present: true,
  moving: false,
  breathing: true,
  bpm: 15,
};

// Derived label for the hero state banner.
export function fusedState(s: SensingState): 'absent' | 'present_moving' | 'present_still' {
  if (!s.present) return 'absent';
  return s.moving ? 'present_moving' : 'present_still';
}
