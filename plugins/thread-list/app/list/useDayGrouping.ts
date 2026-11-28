import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import {
  sidebarDayGroupEdgeHourAtom,
  sidebarGroupByDayAtom,
} from "../preferences/atoms.js";
import {
  groupThreadsByDay,
  msUntilNextDayEdge,
  type DayGroupedThreads,
} from "../model/day-grouping.js";
import type { SidebarThread } from "../model/sidebar-thread.js";

const NONE: DayGroupedThreads = {
  allSectionIds: [],
  presentSectionIds: [],
  sections: [],
  threads: [],
};

function useDayEdgeNow(edgeHour: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setTimeout(
      () => setNow(Date.now()),
      msUntilNextDayEdge(Date.now(), edgeHour) + 1_000,
    );
    return () => clearTimeout(timer);
  }, [edgeHour, enabled, now]);
  return now;
}

export function useDayGrouping(
  threads: readonly SidebarThread[],
): DayGroupedThreads {
  const enabled = useAtomValue(sidebarGroupByDayAtom);
  const edgeHour = useAtomValue(sidebarDayGroupEdgeHourAtom);
  const now = useDayEdgeNow(edgeHour, enabled);
  return useMemo(
    () =>
      enabled
        ? groupThreadsByDay(threads, { edgeHour, now })
        : { ...NONE, threads },
    [edgeHour, enabled, now, threads],
  );
}
