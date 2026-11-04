// Today's energy (F22). One tap, changeable any time. No level is the "good" one.
import type { EnergyLevel, EnergySetting } from '../model/types';
import { dayKey } from '../programme/programme';

export const DEFAULT_ENERGY: EnergyLevel = 'up-for-it';

export interface EnergyInfo {
  level: EnergyLevel;
  label: string;
  glyph: string;
  line: string;
  /** Default breather length, minutes. */
  breather: number;
  /** Sessions in a row before suggesting a recharge. */
  stretch: number;
  /** Recharge length to suggest, minutes. */
  recharge: number;
}

export const ENERGY: Record<EnergyLevel, EnergyInfo> = {
  steady: {
    level: 'steady',
    label: 'Steady',
    glyph: '☾',
    line: 'Sessions first, easy pace, longer breathers.',
    breather: 30,
    stretch: 2,
    recharge: 30,
  },
  'up-for-it': {
    level: 'up-for-it',
    label: 'Up for it',
    glyph: '◐',
    line: 'A good mix of sessions, people and breathers.',
    breather: 20,
    stretch: 3,
    recharge: 20,
  },
  charged: {
    level: 'charged',
    label: 'Charged',
    glyph: '☀',
    line: 'Feeling good. More suggestions, quick breathers, room for a detour.',
    breather: 15,
    stretch: 4,
    recharge: 15,
  },
};

export const ENERGY_ORDER: EnergyLevel[] = ['steady', 'up-for-it', 'charged'];

/** Today's level: what was set today, or the default. Yesterday's choice doesn't carry over. */
export function energyToday(setting: EnergySetting | undefined, now = Date.now()): { level: EnergyLevel; setToday: boolean } {
  if (setting && dayKey(setting.setAt) === dayKey(now)) return { level: setting.level, setToday: true };
  return { level: DEFAULT_ENERGY, setToday: false };
}
