/**
 * Forgotten-Out rule, mirrored in the Next.js layer.
 *
 * Google Sheets stays the source of truth: the 15-minute Apps Script trigger
 * (autoCloseMissedOut in the Apps Script project) performs every write. These
 * helpers exist so the app can reason about the same rule — validating a value
 * before it is shown, or explaining why a day did or did not close.
 *
 * The parsing rules here match timeToMinutes_() in the Apps Script file, so a
 * value accepted in the browser is accepted by the script and vice versa.
 */

/** Hours that must pass after the In entry before the Out is defaulted. */
export const AUTO_OUT_AFTER_HOURS = 12;
/** Default Out written once the wait has passed. */
export const AUTO_OUT_TIME = "18:30";

const MINUTE_MS = 60 * 1000;

export type AutoCloseDecision =
  | {
      close: false;
      /** True when the In cell is not a readable time (annotated, never filled). */
      unreadable: boolean;
      reason: string;
      elapsedMinutes: number | null;
    }
  | {
      close: true;
      unreadable: false;
      reason: string;
      elapsedMinutes: number;
      outDate: Date;
      outTime: string;
      hours: string;
    };

/**
 * Minutes since midnight for "09:30", "09:30:00", "9:30 AM", "6:45 pm" or a real
 * time cell. Returns null — never NaN — so callers fail closed.
 */
export function parseTimeToMinutes(value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getHours() * 60 + value.getMinutes();
  }

  const text = String(value ?? "").trim();
  if (!text) return null;

  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = (match[4] ?? "").replace(/\./g, "").toLowerCase();

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  }

  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** "HH:mm" for display and for comparing with sheet cells. */
export function formatClock(minutes: number): string {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** "HH:mm" duration, the format the Hrs column stores. */
export function formatDuration(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * What the trigger should do for one open record.
 *
 * Fewer than 12 hours since In -> leave the day open.
 * 12 hours or more             -> write 18:30 on the In date.
 * In at or after 18:30         -> write In + 12 h, because 18:30 would land
 *                                 before the check-in and book 00:00.
 * Unreadable In value          -> leave it alone; a human has to look.
 */
export function decideAutoClose({
  inTime,
  now,
  inDate = now,
}: {
  inTime: unknown;
  now: Date;
  inDate?: Date;
}): AutoCloseDecision {
  const inMinutes = parseTimeToMinutes(inTime);

  if (inMinutes === null) {
    return {
      close: false,
      unreadable: true,
      reason: `"${String(inTime)}" is not a time; the Out cell was left untouched.`,
      elapsedMinutes: null,
    };
  }

  const inAt = new Date(startOfDay(inDate).getTime() + inMinutes * MINUTE_MS);
  const elapsed = Math.floor((now.getTime() - inAt.getTime()) / MINUTE_MS);

  if (elapsed < 0) {
    return {
      close: false,
      unreadable: false,
      reason: "The In entry is in the future, so it is ignored.",
      elapsedMinutes: elapsed,
    };
  }

  if (elapsed < AUTO_OUT_AFTER_HOURS * 60) {
    return {
      close: false,
      unreadable: false,
      reason: `Only ${formatDuration(elapsed)} since In; the 12-hour mark is at ${formatClock(
        inMinutes + AUTO_OUT_AFTER_HOURS * 60,
      )}.`,
      elapsedMinutes: elapsed,
    };
  }

  const defaultOut = parseTimeToMinutes(AUTO_OUT_TIME) as number;
  let outAt = new Date(startOfDay(inDate).getTime() + defaultOut * MINUTE_MS);

  if (outAt.getTime() <= inAt.getTime()) {
    outAt = new Date(inAt.getTime() + AUTO_OUT_AFTER_HOURS * 60 * MINUTE_MS);
  }

  return {
    close: true,
    unreadable: false,
    reason: `In was ${formatDuration(elapsed)} ago.`,
    elapsedMinutes: elapsed,
    outDate: outAt,
    outTime: formatClock(defaultOut),
    hours: formatDuration((outAt.getTime() - inAt.getTime()) / MINUTE_MS),
  };
}
