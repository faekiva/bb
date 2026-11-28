import { runInNewContext } from "node:vm";
import {
  VERSION,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { BB_PI_EXTENSION_SOURCE } from "./bb-pi-extension.js";
import { runSettlement } from "./run-settlement.js";

it.each([{}, { aborted: false }])(
  "does not infer interruption from prose: %j",
  (event) => {
    expect(
      runSettlement(event, [
        {
          role: "assistant",
          stopReason: "stop",
          content: "I was aborted; continue?",
        },
      ]),
    ).toEqual({ status: "completed" });
  },
);
it.each([null, "false", 0, {}, []])(
  "fails safely for malformed aborted=%j",
  (aborted) => {
    expect(runSettlement({ aborted }, [])).toEqual({
      status: "failed",
      error: expect.stringContaining("Invalid Pi settlement"),
    });
  },
);
it("recognizes abort without an error message, including trailing tool results", () => {
  expect(
    runSettlement({}, [
      { role: "assistant", stopReason: "aborted" },
      { role: "toolResult" },
    ]),
  ).toEqual({ status: "failed", error: expect.stringContaining("interrupted") });
  expect(
    runSettlement({ aborted: false }, [
      { role: "assistant", stopReason: "aborted" },
    ]),
  ).toEqual({ status: "failed", error: expect.stringContaining("interrupted") });
  expect(runSettlement({ aborted: true }, [])).toEqual({
    status: "failed",
    error: expect.stringContaining("no automatic resume"),
  });
  expect(
    runSettlement({}, [{ role: "assistant", stopReason: "error" }]),
  ).toEqual({ status: "failed", error: "Pi run failed" });
});
it("uses the final assistant rather than earlier retry failures", () => {
  expect(
    runSettlement({}, [
      { role: "assistant", stopReason: "error" },
      { role: "assistant", stopReason: "stop" },
    ]),
  ).toEqual({ status: "completed" });
});
it.each([
  [{ aborted: true }, []],
  [{}, [{ role: "assistant", stopReason: "aborted" }]],
  [
    { aborted: true },
    [
      { role: "assistant", stopReason: "aborted" },
      { role: "toolResult" },
    ],
  ],
])(
  "interrupts the abort of a run a dispatched steer superseded: %j",
  (event, messages) => {
    expect(runSettlement(event, messages, { supersededBySteer: true })).toEqual(
      { status: "interrupted" },
    );
    expect(runSettlement(event, messages, { supersededBySteer: false })).toEqual(
      { status: "failed", error: expect.stringContaining("no automatic resume") },
    );
  },
);
it.each([
  [{}, [{ role: "assistant", stopReason: "stop" }]],
  [{ aborted: false }, []],
  [{ aborted: null }, []],
  [{}, [{ role: "assistant", stopReason: "error", errorMessage: "boom" }]],
])(
  "leaves the non-abort settlement of a steered run unchanged: %j",
  (event, messages) => {
    expect(runSettlement(event, messages, { supersededBySteer: true })).toEqual(
      runSettlement(event, messages),
    );
  },
);

it.each([
  ["0.84.0", true],
  ["0.84.1", true],
  ["0.85.0", true],
  ["1.0.0", true],
  ["1.0.2", true],
  ["2.0.0", true],
  ["0.83.9", false],
  [undefined, false],
  ["unknown", false],
  ["1", false],
  ["0.84.0-beta.1", false],
  ["0.84.0+build", true],
])(
  "extension advertises authoritative settlement for runtime %s: %s",
  (version, expected) => {
    const definition = BB_PI_EXTENSION_SOURCE.match(
      /function supportsAgentSettlement\(version\) \{[\s\S]*?\n\}/,
    )?.[0];
    expect(definition).toBeDefined();
    expect(
      runInNewContext(`${definition}; supportsAgentSettlement(version)`, {
        version,
      }),
    ).toBe(expected);
  },
);

it("the installed official runtime exports VERSION and types agent_settled", () => {
  const event: AgentSessionEvent = { type: "agent_settled" };
  expect(event.type).toBe("agent_settled");
  const definition = BB_PI_EXTENSION_SOURCE.match(
    /function supportsAgentSettlement\(version\) \{[\s\S]*?\n\}/,
  )?.[0];
  expect(
    runInNewContext(`${definition}; supportsAgentSettlement(version)`, {
      version: VERSION,
    }),
  ).toBe(true);
});
