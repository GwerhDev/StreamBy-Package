// A review note's place in an audio (or video) file's time: an instant, seconds from its start,
// or a range, from that instant to where it ends. A note on a version; it can become a task of
// the card the asset is linked to, its time in the task's name.

export interface NoteTime {
  startSeconds: number;
  endSeconds?: number;
}

const isSeconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A note's time, as the API receives it: a start, and an end after it for a range. */
export function checkNoteTime(body: { startSeconds?: unknown; endSeconds?: unknown }): { time: NoteTime } | { error: string } {
  const { startSeconds, endSeconds } = body;
  if (!isSeconds(startSeconds)) return { error: 'startSeconds must be a number of seconds, 0 or more' };
  if (endSeconds === undefined || endSeconds === null) return { time: { startSeconds } };
  if (!isSeconds(endSeconds) || endSeconds <= startSeconds) return { error: 'endSeconds must be a number of seconds after startSeconds' };
  return { time: { startSeconds, endSeconds } };
}

/** A moment as a clock: 1:23, or 1:02:03 past an hour (whole seconds). */
export function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** A note's time as it's read: 1:23, or 1:23–1:40 for a range. */
export function noteTimecode(time: NoteTime): string {
  return time.endSeconds === undefined ? clock(time.startSeconds) : `${clock(time.startSeconds)}–${clock(time.endSeconds)}`;
}

const NAME_LENGTH = 120;

/** The task a note becomes: its time first, then what it says (cut short in the name, whole in its notes). */
export function noteTask(note: NoteTime & { text: string; assetVersionId: string }) {
  const when = noteTimecode(note);
  const line = note.text.replace(/\s+/g, ' ').trim();
  const name = `[${when}] ${line}`;
  return {
    name: name.length > NAME_LENGTH ? `${name.slice(0, NAME_LENGTH - 1)}…` : name,
    notes: `Review note at ${when} of version ${note.assetVersionId}:\n${note.text}`,
  };
}
