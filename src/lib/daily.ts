import { getCollection } from "astro:content";

export interface DailyEntry {
  id: string;
  day: number;
  date: string;
  dateLabel: string;
  shortDateLabel: string;
  monthDayLabel: string;
  title: string;
  instagramUrl: string;
  descriptionHtml: string;
  solution?: {
    key: string;
    name: string;
    oneLiner: string;
    hasShowcase: boolean;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const longDate = new Intl.DateTimeFormat("en", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const shortDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const monthName = new Intl.DateTimeFormat("en", {
  month: "long",
  timeZone: "UTC",
});

// 1 -> 1st, 2 -> 2nd, 3 -> 3rd, 11 -> 11th, 22 -> 22nd
function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

// Share links carry tracking like ?igsh=..., so keep only the Reel's own path.
export function instagramPermalink(url: string): string {
  const m = /instagram\.com\/(?:[\w.]+\/)?(reels?|p|tv)\/([\w-]+)/i.exec(url);
  if (!m) return url;
  const kind = m[1].toLowerCase() === "reels" ? "reel" : m[1].toLowerCase();
  return `https://www.instagram.com/${kind}/${m[2]}/`;
}

// Day 1 is the date of the earliest entry, and a missed day still counts
// toward the number, so "Day 12" always means the twelfth calendar day.
export async function getDailyEntries(): Promise<DailyEntry[]> {
  const [rows, solutions] = await Promise.all([
    getCollection("daily"),
    getCollection("solutions"),
  ]);
  const solutionsById = new Map(solutions.map((row) => [row.id, row]));
  const firstDay = Math.min(
    ...rows.map((row) => utcDate(row.data.date).getTime()),
  );

  return rows
    .map((row) => {
      const solutionId = row.data.solution?.id;
      const solution = solutionId ? solutionsById.get(solutionId) : undefined;
      if (solutionId && !solution) {
        throw new Error(
          `src/content/daily/${row.id}.md links to solution "${solutionId}", which doesn't exist.`,
        );
      }
      const date = utcDate(row.data.date);

      return {
        id: row.id,
        day: Math.round((date.getTime() - firstDay) / DAY_MS) + 1,
        date: row.data.date,
        dateLabel: longDate.format(date),
        shortDateLabel: shortDate.format(date),
        monthDayLabel: `${monthName.format(date)} ${ordinal(date.getUTCDate())}`,
        title: row.data.title,
        instagramUrl: instagramPermalink(row.data.instagramUrl),
        descriptionHtml: row.rendered?.html ?? "",
        solution: solution && {
          key: solution.id,
          name: solution.data.title,
          oneLiner: solution.data.oneLiner,
          hasShowcase: Boolean(solution.data.showcaseVideo),
        },
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

export interface CalendarMonth {
  key: string;
  label: string;
  leadingBlanks: number;
  days: { dayOfMonth: number; entry?: DailyEntry; inChallenge: boolean }[];
  entries: DailyEntry[];
}

export const CALENDAR_WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

const monthLabel = new Intl.DateTimeFormat("en", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const pad = (n: number) => String(n).padStart(2, "0");

// Every month from the latest entry back to the first, newest first, laid out
// as Sunday-first grids. Takes entries newest first, as getDailyEntries
// returns them.
export function getCalendarMonths(entries: DailyEntry[]): CalendarMonth[] {
  const latest = entries[0];
  const first = entries.at(-1);
  if (!latest || !first) return [];

  const byDate = new Map<string, DailyEntry>();
  for (const entry of entries) {
    if (!byDate.has(entry.date)) byDate.set(entry.date, entry);
  }

  const months: CalendarMonth[] = [];
  const [firstYear, firstMonth] = first.date.split("-").map(Number);
  let [year, month] = latest.date.split("-").map(Number);
  while (year > firstYear || (year === firstYear && month >= firstMonth)) {
    const prefix = `${year}-${pad(month)}`;
    const start = new Date(Date.UTC(year, month - 1, 1));
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    months.push({
      key: prefix,
      label: monthLabel.format(start),
      leadingBlanks: start.getUTCDay(),
      days: Array.from({ length: daysInMonth }, (_, index) => {
        const date = `${prefix}-${pad(index + 1)}`;
        return {
          dayOfMonth: index + 1,
          entry: byDate.get(date),
          inChallenge: date >= first.date && date <= latest.date,
        };
      }),
      entries: entries.filter((entry) => entry.date.startsWith(prefix)),
    });
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return months;
}
