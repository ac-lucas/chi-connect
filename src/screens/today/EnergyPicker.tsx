// Today's energy (F22): a one-line summary with Change, or the three choices.
// Arrow keys move through radios and select as they go (WCAG 3.2.2): each pick is saved but the choices stay open;
// Done closes them. The screen reader reads each option as it's reached, so picks aren't announced.
import { useRef, useState } from 'preact/hooks';
import type { EnergyLevel } from '../../model/types';
import { ENERGY, ENERGY_ORDER } from '../../schedule/energy';
import { setSetting } from '../../storage/db';
import { announce } from '../../ui/announce';

function greeting(hour: number): string {
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

export function EnergyPicker({ level, setToday, name, now }: { level: EnergyLevel; setToday: boolean; name: string; now: number }) {
  const [changing, setChanging] = useState(false);
  const changeBtn = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLFieldSetElement>(null);

  async function choose(l: EnergyLevel) {
    setChanging(true);
    await setSetting('energy', { level: l, setAt: Date.now() });
  }
  function done() {
    setChanging(false);
    setTimeout(() => changeBtn.current?.focus(), 0); // keep focus where the choices were
    announce(`Energy: ${ENERGY[level].label}. Your day’s been updated.`);
  }
  function open() {
    setChanging(true);
    setTimeout(() => group.current?.querySelector<HTMLInputElement>('input:checked')?.focus(), 0);
  }

  if (setToday && !changing) {
    return (
      <div class="energy-summary">
        <p>
          <span aria-hidden="true">{ENERGY[level].glyph} </span>
          Today’s energy: <strong>{ENERGY[level].label}</strong>
        </p>
        <button type="button" class="button quiet" ref={changeBtn} aria-label="Change today’s energy" onClick={open}>
          Change
        </button>
      </div>
    );
  }
  return (
    <fieldset class="energy" ref={group}>
      <legend>{setToday ? 'Today’s energy' : `${greeting(new Date(now).getHours())}, ${name}. How’s your energy?`}</legend>
      {!setToday && <p class="hint">Up for it is the default. Change it whenever.</p>}
      <div class="energy-options">
        {ENERGY_ORDER.map((l) => (
          <label key={l} class={`energy-option${l === level ? ' chosen' : ''}`}>
            <input type="radio" name="energy" value={l} checked={l === level} onChange={() => void choose(l)} />
            <span class="energy-glyph" aria-hidden="true">
              {ENERGY[l].glyph}
            </span>
            <span class="energy-label">{ENERGY[l].label}</span>
            <span class="energy-line">{ENERGY[l].line}</span>
          </label>
        ))}
      </div>
      {setToday && (
        <div class="actions">
          <button type="button" class="button secondary" onClick={done}>
            Done
          </button>
        </div>
      )}
    </fieldset>
  );
}
