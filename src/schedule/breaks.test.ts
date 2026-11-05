import { describe, expect, it } from 'vitest';
import { planDay, type Busy } from './breaks';
import { energyToday } from './energy';

const DAY = new Date(2027, 3, 12).getTime(); // local midnight
const t = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return DAY + (h! * 60 + m!) * 60_000;
};
const hm = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
let n = 0;
const session = (from: string, to: string): Busy => ({ id: `s${n++}`, start: t(from), end: t(to), kind: 'session' });

describe('planDay', () => {
  it('puts lunch in the midday gap and breathers in the others, leaving time to walk', () => {
    const plan = planDay([session('09:00', '10:30'), session('11:00', '12:00'), session('13:30', '15:00'), session('15:30', '17:00')], DAY, 'up-for-it');
    expect(plan.breaks.map((b) => `${b.kind} ${hm(b.start)}-${hm(b.end)}`)).toEqual([
      'breather 10:35-10:55',
      'meal 12:05-12:50',
      'breather 15:05-15:25',
    ]);
    expect(plan.headsUps).toEqual([]);
  });

  it('starts lunch no earlier than the lunch window', () => {
    const plan = planDay([session('09:00', '10:30'), session('13:00', '14:00')], DAY, 'up-for-it');
    expect(plan.breaks.map((b) => `${b.kind} ${hm(b.start)}-${hm(b.end)}`)).toEqual(['meal 11:30-12:15']);
  });

  it('scales breathers with energy', () => {
    const day = [session('09:00', '10:00'), session('11:00', '12:00')];
    const len = (e: 'steady' | 'up-for-it' | 'charged') => {
      const b = planDay(day, DAY, e).breaks[0]!;
      return (b.end - b.start) / 60_000;
    };
    expect([len('steady'), len('up-for-it'), len('charged')]).toEqual([30, 20, 15]);
  });

  it('gives a heads-up when there is no room for lunch', () => {
    const plan = planDay([session('09:00', '11:00'), session('11:00', '13:00'), session('13:05', '15:00')], DAY, 'up-for-it');
    expect(plan.breaks.some((b) => b.kind === 'meal')).toBe(false);
    expect(plan.headsUps).toContainEqual({ kind: 'no-lunch' });
  });

  it('flags a long stretch sooner when energy is steady, and suggests a recharge that fits', () => {
    const day = [session('09:00', '10:00'), session('10:00', '11:00'), session('11:05', '12:00'), session('13:30', '15:00')];
    const steady = planDay(day, DAY, 'steady').headsUps.find((h) => h.kind === 'long-stretch');
    expect(steady).toMatchObject({ kind: 'long-stretch', from: t('09:00'), until: t('12:00'), sessions: 3 });
    expect(steady && 'recharge' in steady && steady.recharge && hm(steady.recharge.start)).toBe('12:05');
    expect(planDay(day, DAY, 'charged').headsUps.find((h) => h.kind === 'long-stretch')).toBeUndefined();
  });

  it('treats protected time as busy and counts only sessions towards a stretch', () => {
    const plan = planDay(
      [session('09:00', '10:00'), { id: 'p', start: t('10:00'), end: t('12:30'), kind: 'protected' }, session('13:30', '14:30')],
      DAY,
      'steady',
    );
    expect(plan.breaks.map((b) => b.kind)).toEqual(['meal']);
    expect(hm(plan.breaks[0]!.start)).toBe('12:35');
    expect(plan.headsUps.find((h) => h.kind === 'long-stretch')).toBeUndefined();
  });

  it('adds no breather straight after protected downtime, but lunch still can go there', () => {
    const recharge: Busy = { id: 'r', start: t('09:00'), end: t('09:30'), kind: 'protected' };
    expect(planDay([recharge, session('10:30', '12:00')], DAY, 'up-for-it').breaks).toEqual([]);
    const lunchy: Busy = { id: 'r2', start: t('11:30'), end: t('12:00'), kind: 'protected' };
    expect(planDay([lunchy, session('13:30', '15:00')], DAY, 'up-for-it').breaks.map((b) => b.kind)).toEqual(['meal']);
  });

  it('leaves out breaks the person skipped', () => {
    const day = [session('09:00', '10:00'), session('11:00', '12:00')];
    const first = planDay(day, DAY, 'up-for-it').breaks[0]!;
    expect(planDay(day, DAY, 'up-for-it', undefined, new Set([first.key])).breaks).toEqual([]);
  });

  it('handles an empty day and overlapping sessions', () => {
    expect(planDay([], DAY, 'charged')).toEqual({ breaks: [], headsUps: [] });
    const plan = planDay([session('09:00', '10:30'), session('10:00', '11:00'), session('11:30', '12:00')], DAY, 'up-for-it');
    expect(plan.breaks.map((b) => hm(b.start))).toEqual(['11:05']);
  });
});

describe('energyToday', () => {
  it('uses what was set today, and resets to the default on a new day', () => {
    const now = t('15:00');
    expect(energyToday({ level: 'charged', setAt: t('08:00') }, now)).toEqual({ level: 'charged', setToday: true });
    expect(energyToday({ level: 'charged', setAt: t('08:00') - 86_400_000 }, now)).toEqual({ level: 'up-for-it', setToday: false });
    expect(energyToday(undefined, now)).toEqual({ level: 'up-for-it', setToday: false });
  });

  it('offers one recharge for a long stretch, not a new one after each accepted recharge', () => {
    const day = [session('09:00', '10:00'), session('10:05', '11:00'), session('11:05', '12:00')];
    const later = session('13:30', '15:00');
    const first = planDay([...day, later], DAY, 'steady').headsUps.find((h) => h.kind === 'long-stretch');
    expect(first && first.kind === 'long-stretch' && first.recharge).toBeTruthy();
    const r = first!.kind === 'long-stretch' ? first!.recharge! : null;
    const accepted: Busy = { id: 'r1', start: r!.start, end: r!.end, kind: 'protected' };
    expect(planDay([...day, accepted, later], DAY, 'steady').headsUps.filter((h) => h.kind === 'long-stretch')).toEqual([]);
  });

  it('offers no recharge when the stretch is already followed by protected time later in the gap', () => {
    const day = [session('09:00', '10:00'), session('10:05', '11:00'), session('11:05', '12:00')];
    const recharge: Busy = { id: 'r2', start: t('13:00'), end: t('13:20'), kind: 'protected' };
    expect(planDay([...day, recharge, session('14:00', '15:00')], DAY, 'steady').headsUps.filter((h) => h.kind === 'long-stretch')).toEqual([]);
  });

  it('turns the breather after a stretch into the recharge instead of adding a second break', () => {
    const day = [session('13:15', '14:00'), session('14:05', '14:45'), session('14:50', '15:30'), session('16:30', '17:30')];
    const plan = planDay(day, DAY, 'steady');
    const h = plan.headsUps.find((x) => x.kind === 'long-stretch');
    const rc = h && h.kind === 'long-stretch' ? h.recharge : undefined;
    expect(rc?.replaces).toBe('breather');
    expect(plan.breaks.some((b) => b.kind === 'breather' && b.start === rc!.start)).toBe(true);
  });
});
