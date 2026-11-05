import { afterEach, describe, expect, it } from 'vitest';
import { atMinutes, nextDay, startOfDay } from './programme';

const original = process.env.TZ;
afterEach(() => {
  process.env.TZ = original;
});

describe('day arithmetic on clock-change days', () => {
  it('finds the next midnight on a 23-hour and a 25-hour day', () => {
    process.env.TZ = 'Europe/Brussels';
    const spring = new Date(2026, 2, 29, 12).getTime(); // clocks go forward that night
    expect(new Date(nextDay(spring)).getDate()).toBe(30);
    expect(new Date(nextDay(spring)).getHours()).toBe(0);
    expect(nextDay(spring) - startOfDay(spring)).toBe(23 * 3_600_000);
    const autumn = new Date(2026, 9, 25, 12).getTime(); // clocks go back
    expect(nextDay(autumn) - startOfDay(autumn)).toBe(25 * 3_600_000);
  });

  it('puts wall-clock times at the right hour on those days', () => {
    process.env.TZ = 'Europe/Brussels';
    const spring = new Date(2026, 2, 29).getTime();
    expect(new Date(atMinutes(spring, 11 * 60 + 30)).getHours()).toBe(11);
    expect(new Date(atMinutes(spring, 11 * 60 + 30)).getMinutes()).toBe(30);
  });
});
