export type RunSettlementStatus = "completed" | "interrupted" | "failed";

export interface RunSettlement {
  status: RunSettlementStatus;
  error?: string;
}

export interface RunSettlementContext {
  supersededBySteer?: boolean;
}

export function runSettlement(
  event: Record<string, unknown>,
  messages: unknown,
  context: RunSettlementContext = {},
): RunSettlement {
  if (Object.hasOwn(event, "aborted") && typeof event.aborted !== "boolean") {
    return {
      status: "failed",
      error: "Invalid Pi settlement: aborted must be boolean when present",
    };
  }
  const last = Array.isArray(messages)
    ? [...messages]
        .reverse()
        .find(
          (value: unknown): value is Record<string, unknown> =>
            typeof value === "object" &&
            value !== null &&
            "role" in value &&
            value.role === "assistant",
        )
    : undefined;
  if (event.aborted === true || last?.stopReason === "aborted") {
    return context.supersededBySteer === true
      ? { status: "interrupted" }
      : {
          status: "failed",
          error:
            "Pi run interrupted unexpectedly; no automatic resume was attempted",
        };
  }
  if (last?.stopReason === "error") {
    return {
      status: "failed",
      error:
        typeof last.errorMessage === "string" && last.errorMessage.trim()
          ? last.errorMessage
          : "Pi run failed",
    };
  }
  return { status: "completed" };
}
