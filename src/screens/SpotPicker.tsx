import type { MeetingSpot } from '../model/types';
import { describeSpot, ROWS, SIDES } from '../schedule/spot';

/**
 * Pick a rough spot in the room: a 3 x 3 grid of native radio buttons (arrow keys work as usual), plus
 * "by the door" and "aisle seat".
 */
export function SpotPicker({ value, onChange }: { value: MeetingSpot | undefined; onChange: (s: MeetingSpot | undefined) => void }) {
  const v = value ?? {};
  const set = (patch: Partial<MeetingSpot>) => {
    const next: MeetingSpot = { ...v, ...patch };
    for (const k of Object.keys(next) as (keyof MeetingSpot)[]) if (next[k] === undefined || next[k] === false) delete next[k];
    onChange(describeSpot(next) ? next : undefined);
  };
  const area = v.row && v.side ? `${v.row}-${v.side}` : 'none';
  return (
    <fieldset class="stack spot-picker">
      <legend>Meeting spot (optional)</legend>
      <p class="hint">A rough area so you find each other.</p>
      <div class="spot-grid">
        {ROWS.flatMap((row) =>
          SIDES.map((side) => (
            <label key={`${row}-${side}`} class={`spot-cell${area === `${row}-${side}` ? ' on' : ''}`}>
              <input type="radio" name="spot-area" checked={area === `${row}-${side}`} onChange={() => set({ row, side })} />
              <span>{describeSpot({ row, side })}</span>
            </label>
          )),
        )}
      </div>
      <label class="check">
        <input type="radio" name="spot-area" checked={area === 'none'} onChange={() => set({ row: undefined, side: undefined })} />
        No particular area
      </label>
      <label class="check">
        <input type="checkbox" checked={!!v.byDoor} onChange={(e) => set({ byDoor: e.currentTarget.checked })} />
        By the door
      </label>
      <label class="check">
        <input type="checkbox" checked={!!v.aisleSeat} onChange={(e) => set({ aisleSeat: e.currentTarget.checked })} />
        Aisle seat
      </label>
      {value && <p>Spot: {describeSpot(value)}</p>}
    </fieldset>
  );
}
