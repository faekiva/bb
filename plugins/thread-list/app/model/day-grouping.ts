import type { SidebarThread } from "./sidebar-thread.js";
import type { SidebarSectionDefinition } from "./project-thread-groups.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const DAY_SECTION_ID_PREFIX = "day:";

export type DayBucket = "today" | "yesterday" | "week" | "month" | "older";

export const DAY_BUCKETS: readonly {
  bucket: DayBucket;
  name: string;
}[] = [
  { bucket: "today", name: "Today" },
  { bucket: "yesterday", name: "Yesterday" },
  { bucket: "week", name: "Previous 7 days" },
  { bucket: "month", name: "Previous 30 days" },
  { bucket: "older", name: "Older" },
];

export function buildDaySectionId(bucket: DayBucket): string {
  return `${DAY_SECTION_ID_PREFIX}${bucket}`;
}

export function isDaySectionId(sectionId: string): boolean {
  return sectionId.startsWith(DAY_SECTION_ID_PREFIX);
}

export interface DayGroupingOptions {
  edgeHour: number;
  now: number;
}

export function dayEdgeAt(now: number, edgeHour: number): number {
  const edge = new Date(now);
  edge.setHours(edgeHour, 0, 0, 0);
  const edgeAt = edge.getTime();
  return edgeAt > now ? edgeAt - DAY_MS : edgeAt;
}

export function dayBucketFor(
  timestamp: number,
  { edgeHour, now }: DayGroupingOptions,
): DayBucket {
  const edgeAt = dayEdgeAt(now, edgeHour);
  if (timestamp >= edgeAt) return "today";
  if (timestamp >= edgeAt - DAY_MS) return "yesterday";
  if (timestamp >= edgeAt - 7 * DAY_MS) return "week";
  if (timestamp >= edgeAt - 30 * DAY_MS) return "month";
  return "older";
}

export function msUntilNextDayEdge(now: number, edgeHour: number): number {
  return dayEdgeAt(now, edgeHour) + DAY_MS - now;
}

export interface DayGroupedThreads {
  allSectionIds: readonly string[];
  presentSectionIds: readonly string[];
  sections: readonly SidebarSectionDefinition[];
  threads: readonly SidebarThread[];
}

export function groupThreadsByDay(
  threads: readonly SidebarThread[],
  options: DayGroupingOptions,
): DayGroupedThreads {
  const bucketed: SidebarThread[] = [];
  const present = new Set<DayBucket>();
  for (const thread of threads) {
    if (thread.sectionId !== null) {
      bucketed.push(thread);
      continue;
    }
    const bucket = dayBucketFor(thread.latestAttentionAt, options);
    present.add(bucket);
    bucketed.push({ ...thread, sectionId: buildDaySectionId(bucket) });
  }
  const presentBuckets = DAY_BUCKETS.filter(({ bucket }) => present.has(bucket));
  return {
    allSectionIds: DAY_BUCKETS.map(({ bucket }) => buildDaySectionId(bucket)),
    presentSectionIds: presentBuckets.map(({ bucket }) =>
      buildDaySectionId(bucket),
    ),
    sections: presentBuckets.map(({ bucket, name }) => ({
      id: buildDaySectionId(bucket),
      name,
    })),
    threads: bucketed,
  };
}

export function normalizeDaySectionId(
  sectionId: string | null | undefined,
): string | null | undefined {
  return sectionId != null && isDaySectionId(sectionId) ? null : sectionId;
}
