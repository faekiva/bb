import { describe, expect, it } from "vitest";
import { makeSidebarThread } from "./fixtures.js";
import {
  buildDaySectionId,
  DAY_BUCKETS,
  dayBucketFor,
  dayEdgeAt,
  groupThreadsByDay,
  isDaySectionId,
  msUntilNextDayEdge,
  normalizeDaySectionId,
} from "./day-grouping.js";
import {
  buildSidebarEntitySectionId,
  normalizeSidebarSectionOrder,
} from "./sidebar-section-order.js";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

function localTime(year: number, month: number, day: number, hour: number) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime();
}

const NOON = localTime(2026, 3, 10, 12);
const EDGE_HOUR = 3;

function thread(id: string, latestAttentionAt: number, sectionId: string | null = null) {
  return makeSidebarThread({ id, title: id, latestAttentionAt, sectionId });
}

describe("dayEdgeAt", () => {
  it("returns the most recent edge hour before now", () => {
    expect(dayEdgeAt(NOON, EDGE_HOUR)).toBe(localTime(2026, 3, 10, 3));
    expect(dayEdgeAt(localTime(2026, 3, 10, 1), EDGE_HOUR)).toBe(
      localTime(2026, 3, 9, 3),
    );
    expect(dayEdgeAt(localTime(2026, 3, 10, 3), EDGE_HOUR)).toBe(
      localTime(2026, 3, 10, 3),
    );
  });
});

describe("dayBucketFor", () => {
  const options = { edgeHour: EDGE_HOUR, now: NOON };

  it("keeps a thread touched after midnight in Today until the edge hour", () => {
    const justAfterMidnight = { edgeHour: EDGE_HOUR, now: localTime(2026, 3, 10, 1) };
    expect(
      dayBucketFor(localTime(2026, 3, 10, 0) + 30 * 60 * 1_000, justAfterMidnight),
    ).toBe("today");
  });

  it("rolls the small hours into the previous bucket once the edge passes", () => {
    expect(dayBucketFor(localTime(2026, 3, 10, 1), options)).toBe("yesterday");
  });

  it("moves a thread from the previous calendar day out of Today once the edge passes", () => {
    expect(dayBucketFor(localTime(2026, 3, 10, 2) - 60 * 1_000, options)).toBe(
      "yesterday",
    );
    expect(dayBucketFor(localTime(2026, 3, 9, 9), options)).toBe("yesterday");
  });

  it("fills the week, month, and older buckets", () => {
    expect(dayBucketFor(localTime(2026, 3, 6, 9), options)).toBe("week");
    expect(dayBucketFor(localTime(2026, 2, 20, 9), options)).toBe("month");
    expect(dayBucketFor(localTime(2026, 1, 20, 9), options)).toBe("older");
    expect(dayBucketFor(0, options)).toBe("older");
  });

  it("treats a future timestamp as today", () => {
    expect(dayBucketFor(NOON + HOUR, options)).toBe("today");
  });
});

describe("msUntilNextDayEdge", () => {
  it("counts to the next edge hour", () => {
    const justAfterEdge = localTime(2026, 3, 10, 4);
    expect(msUntilNextDayEdge(justAfterEdge, EDGE_HOUR)).toBe(23 * HOUR);
    const justBeforeEdge = localTime(2026, 3, 10, 2);
    expect(msUntilNextDayEdge(justBeforeEdge, EDGE_HOUR)).toBe(HOUR);
  });
});

describe("groupThreadsByDay", () => {
  const options = { edgeHour: EDGE_HOUR, now: NOON };

  it("files unsectioned threads into their bucket and reports only populated buckets", () => {
    const grouped = groupThreadsByDay(
      [
        thread("fresh", NOON - HOUR),
        thread("previous-day", NOON - DAY),
        thread("filed", NOON - HOUR, "sec_later"),
      ],
      options,
    );

    expect(grouped.threads.map((entry) => [entry.id, entry.sectionId])).toEqual(
      [
        ["fresh", buildDaySectionId("today")],
        ["previous-day", buildDaySectionId("yesterday")],
        ["filed", "sec_later"],
      ],
    );
    expect(grouped.presentSectionIds).toEqual([
      buildDaySectionId("today"),
      buildDaySectionId("yesterday"),
    ]);
    expect(grouped.sections.map((section) => section.name)).toEqual([
      "Today",
      "Yesterday",
    ]);
  });

  it("registers every bucket for the section order but renders none that are empty", () => {
    const grouped = groupThreadsByDay([], options);

    expect(grouped.allSectionIds).toEqual(
      DAY_BUCKETS.map(({ bucket }) => buildDaySectionId(bucket)),
    );
    expect(grouped.presentSectionIds).toEqual([]);
    expect(grouped.sections).toEqual([]);
  });

  it("keeps bucket order independent of thread order", () => {
    const grouped = groupThreadsByDay(
      [
        thread("old", NOON - 45 * DAY),
        thread("today", NOON - HOUR),
        thread("month", NOON - 10 * DAY),
      ],
      options,
    );

    expect(grouped.presentSectionIds).toEqual([
      buildDaySectionId("today"),
      buildDaySectionId("month"),
      buildDaySectionId("older"),
    ]);
  });
});

describe("day section ids", () => {
  it("round-trips and rejects real section ids", () => {
    expect(isDaySectionId(buildDaySectionId("today"))).toBe(true);
    expect(isDaySectionId("sec_later")).toBe(false);
    expect(normalizeDaySectionId(buildDaySectionId("older"))).toBeNull();
    expect(normalizeDaySectionId("sec_later")).toBe("sec_later");
    expect(normalizeDaySectionId(null)).toBeNull();
    expect(normalizeDaySectionId(undefined)).toBeUndefined();
  });
});

describe("day sections in the manual order", () => {
  const dayOrderIds = DAY_BUCKETS.map(({ bucket }) =>
    buildSidebarEntitySectionId("section", buildDaySectionId(bucket)),
  );

  it("splices missing day sections after the custom ones and before threads", () => {
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: ["pinned", "section:sec_later", "threads"],
        entitySectionIds: [
          buildSidebarEntitySectionId("section", "sec_later"),
          ...dayOrderIds,
        ],
        legacyEntityAnchor: "sections",
        hasPinnedSection: true,
      }),
    ).toEqual(["pinned", "section:sec_later", ...dayOrderIds, "threads"]);
  });

  it("keeps a stored position so a dragged bucket stays put", () => {
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: ["pinned", dayOrderIds[0]!, "section:sec_later", "threads"],
        entitySectionIds: [
          buildSidebarEntitySectionId("section", "sec_later"),
          ...dayOrderIds,
        ],
        legacyEntityAnchor: "sections",
        hasPinnedSection: true,
      }),
    ).toEqual([
      "pinned",
      dayOrderIds[0]!,
      "section:sec_later",
      ...dayOrderIds.slice(1),
      "threads",
    ]);
  });
});
