// Exports (F09): your own data out of the app, as files you keep. Made on the phone; nothing is uploaded.
// Every format escapes what it must: names and notes come from other people or free text.
import type { Connection, FollowUp, Note } from '../model/types';

const real = (cs: Connection[]) => cs.filter((c) => c.state === 'connected');

// vCard 3.0 (contacts). Escape backslash, comma, semicolon and newlines.
const vEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

export function toVCard(connections: Connection[], notes: Note[] = []): string {
  return real(connections)
    .map((c) => {
      const p = c.profile;
      const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${vEsc(p.displayName)}`, `N:${vEsc(p.displayName)};;;;`];
      if (p.company) lines.push(`ORG:${vEsc(p.company)}`);
      if (p.role) lines.push(`TITLE:${vEsc(p.role)}`);
      for (const l of p.links ?? []) lines.push(`URL:${vEsc(l)}`);
      const n = notes.filter((x) => x.connectionId === c.id).map((x) => [x.chips.join(', '), x.text].filter(Boolean).join(': '));
      if (n.length) lines.push(`NOTE:${vEsc(n.join(' / '))}`);
      if (c.demo) lines.push('NOTE:Demo person (made up)');
      lines.push('END:VCARD');
      return lines.join('\r\n');
    })
    .join('\r\n');
}

// CSV. Quote every cell; double inner quotes; neutralise cells a spreadsheet would run as a formula.
function cell(v: string | number | undefined): string {
  let s = v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
const row = (cells: (string | number | undefined)[]) => cells.map(cell).join(',');
const isoDate = (t?: number) => (t ? new Date(t).toISOString().slice(0, 10) : '');

export function toCsv(connections: Connection[], notes: Note[], followUps: FollowUp[]): string {
  const lines = [row(['Name', 'Role', 'Company', 'Links', 'Topics', 'Connected', 'Notes', 'Follow-ups', 'Demo'])];
  for (const c of real(connections)) {
    const p = c.profile;
    const n = notes.filter((x) => x.connectionId === c.id).map((x) => [x.chips.join(', '), x.text].filter(Boolean).join(': '));
    const f = followUps.filter((x) => x.connectionId === c.id).map((x) => `${x.done ? '[done] ' : ''}${x.text}${x.due ? ` (by ${isoDate(x.due)})` : ''}`);
    lines.push(
      row([p.displayName, p.role, p.company, (p.links ?? []).join(' '), (p.tags ?? []).map((t) => t.label).join('; '), isoDate(c.connectedAt), n.join(' | '), f.join(' | '), c.demo ? 'yes' : '']),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ICS (calendar reminders for follow-ups with a date). Escape text; fold long lines at 75 octets.
const iEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (curBytes + b > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const day = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};
const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function toIcs(followUps: FollowUp[], connections: Connection[], now = Date.now()): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pebble//Follow-ups//EN', 'CALSCALE:GREGORIAN'];
  for (const f of followUps) {
    if (!f.due || f.done) continue;
    const who = connections.find((c) => c.id === f.connectionId)?.profile.displayName;
    const next = new Date(f.due);
    next.setDate(next.getDate() + 1);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${f.id}@pebble`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${day(f.due)}`,
      `DTEND;VALUE=DATE:${day(next.getTime())}`,
      `SUMMARY:${iEsc(f.text)}`,
      ...(who ? [`DESCRIPTION:${iEsc(`Follow-up with ${who}`)}`] : []),
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${iEsc(f.text)}`,
      'TRIGGER:PT9H',
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** Hand the person a file to save. Uses a temporary local link; nothing leaves the phone. */
export function download(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
