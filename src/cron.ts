/**
 * A five-field cron parser, UTC only, enough to schedule the agent. Written
 * here rather than pulled in because the whole need is "when is the next
 * run", and every cron package on npm carries time zones, seconds fields
 * and a plugin system this container will never use. The grammar is the
 * classic one: minute, hour, day of month, month, day of week, each a
 * list of numbers, ranges and steps, or `*`.
 *
 * Day of month and day of week follow the traditional rule: when both are
 * restricted, a day matches if either does, which is what vixie cron and
 * every clone do.
 */

export class CronError extends Error {}

interface Field {
  /** Set of accepted values, or null for "any". */
  values: Set<number> | null;
}

export interface CronSchedule {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
  /** The expression as given, for log lines. */
  source: string;
}

const NAMES: Record<string, string[]> = {
  month: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  dayOfWeek: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
};

function parseField(text: string, name: string, min: number, max: number): Field {
  if (text === '*') return { values: null };
  const values = new Set<number>();
  const names = NAMES[name];

  const number = (token: string): number => {
    const lower = token.toLowerCase();
    const named = names ? names.indexOf(lower) : -1;
    if (named >= 0) return named + (name === 'month' ? 1 : 0);
    if (!/^\d+$/.test(token)) throw new CronError(`Cron field ${name}: "${token}" is not a number.`);
    return Number(token);
  };

  for (const part of text.split(',')) {
    const [rangeText, stepText] = part.split('/');
    if (rangeText === undefined || rangeText === '') throw new CronError(`Cron field ${name}: "${part}" is empty.`);
    const step = stepText === undefined ? 1 : number(stepText);
    if (step < 1) throw new CronError(`Cron field ${name}: step must be at least 1.`);

    let low: number;
    let high: number;
    if (rangeText === '*') {
      low = min;
      high = max;
    } else if (rangeText.includes('-')) {
      const [a, b] = rangeText.split('-');
      low = number(a);
      high = number(b ?? '');
    } else {
      low = number(rangeText);
      // "5/15" means every 15 starting at 5, as in vixie cron; a plain
      // number is just itself.
      high = stepText === undefined ? low : max;
    }
    if (low < min || high > max || low > high) {
      throw new CronError(`Cron field ${name}: "${part}" is outside ${min}-${max}.`);
    }
    for (let v = low; v <= high; v += step) values.add(v);
  }

  // Sunday is both 0 and 7.
  if (name === 'dayOfWeek' && values.has(7)) values.add(0);
  return { values };
}

export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(`Cron expression "${expression}" must have five fields: minute hour day-of-month month day-of-week.`);
  }
  return {
    minute: parseField(fields[0], 'minute', 0, 59),
    hour: parseField(fields[1], 'hour', 0, 23),
    dayOfMonth: parseField(fields[2], 'dayOfMonth', 1, 31),
    month: parseField(fields[3], 'month', 1, 12),
    dayOfWeek: parseField(fields[4], 'dayOfWeek', 0, 7),
    source: expression.trim(),
  };
}

function matches(field: Field, value: number): boolean {
  return field.values === null || field.values.has(value);
}

/**
 * The first instant strictly after `from` that the schedule fires, in UTC.
 * Walks minute by minute, skipping whole days and hours that cannot match,
 * so the worst case (a 29 February every four years) stays well under a
 * few thousand steps.
 */
export function nextRun(schedule: CronSchedule, from: Date): Date {
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  // A generous bound: five years of days is enough for any expression that
  // can fire at all, and refusing beyond it beats spinning on one that
  // never can (31 February).
  const limit = cursor.getTime() + 5 * 366 * 24 * 60 * 60 * 1000;

  while (cursor.getTime() < limit) {
    const dayRestricted = schedule.dayOfMonth.values !== null;
    const weekdayRestricted = schedule.dayOfWeek.values !== null;
    const dayMatches =
      dayRestricted && weekdayRestricted
        ? matches(schedule.dayOfMonth, cursor.getUTCDate()) || matches(schedule.dayOfWeek, cursor.getUTCDay())
        : matches(schedule.dayOfMonth, cursor.getUTCDate()) && matches(schedule.dayOfWeek, cursor.getUTCDay());

    if (!matches(schedule.month, cursor.getUTCMonth() + 1) || !dayMatches) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!matches(schedule.hour, cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!matches(schedule.minute, cursor.getUTCMinutes())) {
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return cursor;
  }

  throw new CronError(`Cron expression "${schedule.source}" never fires.`);
}
