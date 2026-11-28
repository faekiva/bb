import { createContext, useContext, type ReactNode } from "react";
import { normalizeDaySectionId } from "../model/day-grouping.js";

const PlacementGroupContext = createContext("threads");

export function ThreadCreationPlacementScope({
  group,
  children,
}: {
  group: string;
  children: ReactNode;
}) {
  return (
    <PlacementGroupContext.Provider value={group}>
      {children}
    </PlacementGroupContext.Provider>
  );
}

export function useThreadCreationPlacement(sectionWhenUnpinned: string | null) {
  const group = useContext(PlacementGroupContext);
  const sectionId =
    group === "pinned"
      ? sectionWhenUnpinned
      : group.startsWith("section:")
        ? normalizeDaySectionId(group.slice("section:".length))
        : null;
  return {
    pinned: group === "pinned",
    sectionId: sectionId ?? null,
  };
}
