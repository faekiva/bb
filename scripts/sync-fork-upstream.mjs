#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_PATH = "packages/host-daemon-contract/src/protocol.ts";
const CONTRACT_TEST_PATH = "packages/host-daemon-contract/test/contract.test.ts";
const AGENTS_PATH = "AGENTS.md";
const SELF_PATH = "scripts/sync-fork-upstream.mjs";
const KNOWN_CONFLICTS = [AGENTS_PATH, PROTOCOL_PATH, CONTRACT_TEST_PATH];
const ALLOWED_FILES = new Set([...KNOWN_CONFLICTS, SELF_PATH]);
const PROTOCOL_OFFSET = 10_000;
const CONFLICT_ROUND_LIMIT = 20;

const scriptDir = dirname(fileURLToPath(import.meta.url));

function resolveRepo() {
  const explicit = process.env.FORK_SYNC_REPO;
  if (explicit) return explicit;
  const candidates = [process.cwd(), dirname(scriptDir)];
  const found = candidates.find((candidate) => existsSync(join(candidate, ".git")));
  if (found === undefined) {
    throw new Error(
      `no git checkout found among ${candidates.join(", ")}; set FORK_SYNC_REPO`,
    );
  }
  return found;
}

const repo = resolveRepo();
const baseDir = join(tmpdir(), "bb-fork-sync");
const scratch = process.env.FORK_SYNC_WORKTREE ?? join(baseDir, "worktree");
const reportPath = process.env.FORK_SYNC_REPORT ?? join(baseDir, "last-failure.txt");
const dryRun = process.env.FORK_SYNC_DRY_RUN === "1";

class Escalate extends Error {
  constructor(reason) {
    super(reason);
    this.name = "Escalate";
  }
}

function git(args, cwd = repo) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    ok: result.status === 0,
    out: result.stdout ?? "",
    err: (result.stderr ?? "").trim(),
  };
}

function mustGit(args, cwd = repo) {
  const result = git(args, cwd);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.err || "(no stderr)"}`);
  }
  return result.out;
}

function lines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function grouped(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, "_");
}

function readProtocolVersion(source, label) {
  const match = source.match(
    /export const HOST_DAEMON_PROTOCOL_VERSION = ([\d_]+) as const;/u,
  );
  if (!match) {
    throw new Escalate(`cannot read HOST_DAEMON_PROTOCOL_VERSION from ${label}`);
  }
  return Number(match[1].replaceAll("_", ""));
}

function replaceOnce(source, pattern, replacement, label) {
  const found = source.match(new RegExp(pattern.source, appendGlobal(pattern)));
  if (found === null || found.length !== 1) {
    throw new Escalate(
      `expected exactly one ${label}, found ${found === null ? 0 : found.length}`,
    );
  }
  return source.replace(pattern, replacement);
}

function appendGlobal(pattern) {
  return pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
}

function resolveAgents(context) {
  const upstreamTouchedAgents =
    git([
      "diff",
      "--quiet",
      `${context.oldMain}..upstream/main`,
      "--",
      AGENTS_PATH,
    ]).ok === false;
  if (upstreamTouchedAgents) {
    throw new Escalate(
      "upstream changed AGENTS.md in this range; the fork owns that file and needs a human decision",
    );
  }
  return mustGit(["show", `:3:${AGENTS_PATH}`], context.scratch);
}

function resolveProtocol(context) {
  const upstreamSide = mustGit(["show", `:2:${PROTOCOL_PATH}`], context.scratch);
  const upstreamVersion = readProtocolVersion(upstreamSide, "upstream's protocol.ts");
  if (upstreamVersion > context.upstreamVersion) {
    throw new Escalate(
      `upstream's protocol.ts inside the conflict (${upstreamVersion}) is newer than upstream/main (${context.upstreamVersion})`,
    );
  }
  return replaceOnce(
    upstreamSide,
    /export const HOST_DAEMON_PROTOCOL_VERSION = [\d_]+ as const;/u,
    `export const HOST_DAEMON_PROTOCOL_VERSION = ${grouped(context.targetVersion)} as const;`,
    "HOST_DAEMON_PROTOCOL_VERSION declaration",
  );
}

function resolveContractTest(context) {
  const upstreamSide = mustGit(["show", `:2:${CONTRACT_TEST_PATH}`], context.scratch);
  const expected = grouped(context.targetVersion);
  const bare = String(context.upstreamVersion);
  const withCurrent = replaceOnce(
    upstreamSide,
    new RegExp(
      `^(\\s*)expect\\(HOST_DAEMON_PROTOCOL_VERSION\\)\\.toBe\\(${bare}\\);$`,
      "mu",
    ),
    `$1expect(HOST_DAEMON_PROTOCOL_VERSION).toBe(${expected});`,
    `current-version assertion for ${bare}`,
  );
  const withCompatibility = replaceOnce(
    withCurrent,
    new RegExp(
      `^(\\s*)expect\\(contract\\.isCompatibleHostDaemonProtocolVersion\\(${bare}\\)\\)\\.toBe\\(true\\);$`,
      "mu",
    ),
    `$1expect(contract.isCompatibleHostDaemonProtocolVersion(${bare})).toBe(false);\n$1expect(contract.isCompatibleHostDaemonProtocolVersion(${expected})).toBe(true);`,
    `compatibility assertion for ${bare}`,
  );
  return withCompatibility;
}

function resolveKnownConflict(path, context) {
  if (path === AGENTS_PATH) return resolveAgents(context);
  if (path === PROTOCOL_PATH) return resolveProtocol(context);
  if (path === CONTRACT_TEST_PATH) return resolveContractTest(context);
  throw new Escalate(`no documented resolution for ${path}`);
}

function prepareScratch(context) {
  if (existsSync(scratch)) {
    const removed = git(["worktree", "remove", "--force", scratch]);
    if (!removed.ok) rmSync(scratch, { recursive: true, force: true });
  }
  git(["worktree", "prune"]);
  mustGit(["worktree", "add", "--force", "--detach", scratch, context.oldMain]);
}

function rebase(context) {
  const resolved = new Set();
  let result = git(["rebase", "upstream/main"], context.scratch);
  let round = 0;
  while (!result.ok) {
    round += 1;
    if (round > CONFLICT_ROUND_LIMIT) {
      throw new Escalate(`rebase did not converge within ${CONFLICT_ROUND_LIMIT} conflict rounds`);
    }
    const unmerged = lines(
      mustGit(["diff", "--name-only", "--diff-filter=U"], context.scratch),
    );
    if (unmerged.length === 0) {
      throw new Escalate(
        `rebase stopped without conflicts: ${result.err.split("\n").at(-1) ?? "(no stderr)"}`,
      );
    }
    const undocumented = unmerged.filter((path) => !KNOWN_CONFLICTS.includes(path));
    if (undocumented.length > 0) {
      throw new Escalate(
        `conflict outside the documented set: ${undocumented.join(", ")} (all conflicts: ${unmerged.join(", ")})`,
      );
    }
    for (const path of unmerged) {
      writeFileSync(
        join(context.scratch, path),
        resolveKnownConflict(path, context),
        "utf8",
      );
      resolved.add(path);
    }
    mustGit(["add", "--", ...unmerged], context.scratch);
    result = git(["rebase", "--continue"], context.scratch);
  }
  return resolved;
}

function verify(context) {
  const changed = lines(
    mustGit(["diff", "--name-only", "upstream/main..HEAD"], context.scratch),
  );
  const unexpected = changed.filter((path) => !ALLOWED_FILES.has(path));
  if (unexpected.length > 0) {
    throw new Escalate(
      `the rebased tip changes files the fork does not own: ${unexpected.join(", ")}`,
    );
  }
  const missing = KNOWN_CONFLICTS.filter((path) => !changed.includes(path));
  if (missing.length > 0) {
    throw new Escalate(
      `the rebased tip lost the fork's edits to ${missing.join(", ")}`,
    );
  }
  const commits = lines(
    mustGit(["log", "--format=%s", "upstream/main..HEAD"], context.scratch),
  );
  if (commits.length !== context.forkCommitCount) {
    throw new Escalate(
      `expected ${context.forkCommitCount} fork commits on top of upstream, found ${commits.length}: ${commits.join(" | ")}`,
    );
  }
  const expected = grouped(context.targetVersion);
  const protocolSource = mustGit(["show", `HEAD:${PROTOCOL_PATH}`], context.scratch);
  if (!protocolSource.includes(`= ${expected} as const`)) {
    throw new Escalate(
      `the rebased tip does not carry HOST_DAEMON_PROTOCOL_VERSION = ${expected}`,
    );
  }
  const testSource = mustGit(["show", `HEAD:${CONTRACT_TEST_PATH}`], context.scratch);
  const assertions = [
    `expect(HOST_DAEMON_PROTOCOL_VERSION).toBe(${expected});`,
    `isCompatibleHostDaemonProtocolVersion(${context.upstreamVersion})).toBe(false)`,
    `isCompatibleHostDaemonProtocolVersion(${expected})).toBe(true)`,
  ];
  const absent = assertions.filter((line) => !testSource.includes(line));
  if (absent.length > 0) {
    throw new Escalate(
      `the rebased contract test is missing: ${absent.join(" | ")}`,
    );
  }
  const agentsSource = mustGit(["show", `HEAD:${AGENTS_PATH}`], context.scratch);
  if (!agentsSource.includes("## Fork Policy")) {
    throw new Escalate("the rebased AGENTS.md lost the fork's Fork Policy section");
  }
}

function push(context) {
  if (dryRun) return "not pushed (dry run)";
  const result = git(
    ["push", `--force-with-lease=main:${context.oldMain}`, "origin", "HEAD:main"],
    context.scratch,
  );
  if (!result.ok) {
    throw new Escalate(
      `push rejected: ${result.err.split("\n").at(-1) ?? "(no stderr)"}; origin/main may have moved`,
    );
  }
  return "pushed";
}

function syncCheckout(context) {
  if (dryRun) return "not touched (dry run)";
  const dirty = mustGit(["status", "--porcelain"]).trim();
  const branch = git(["symbolic-ref", "--short", "HEAD"]);
  const head = mustGit(["rev-parse", "HEAD"]).trim();
  if (dirty.length > 0 || !branch.ok || branch.out.trim() !== "main") {
    return "left alone (checkout is dirty or not on main)";
  }
  if (head !== context.oldMain) {
    return "left alone (checkout has commits the sync did not produce)";
  }
  mustGit(["reset", "--hard", context.newTip]);
  return "fast-forwarded";
}

function cleanup(context) {
  const removed = git(["worktree", "remove", "--force", context.scratch]);
  if (!removed.ok) {
    rmSync(context.scratch, { recursive: true, force: true });
    git(["worktree", "prune"]);
  }
}

function triggerEscalation() {
  const automationId = process.env.FORK_SYNC_ESCALATION_AUTOMATION_ID;
  const projectId = process.env.BB_PROJECT_ID;
  if (!automationId || !projectId) return "";
  const cli = process.env.BB_CLI ?? "bb";
  const result = spawnSync(
    cli,
    ["automation", "run", automationId, "--project", projectId],
    { encoding: "utf8" },
  );
  if (result.status === 0) {
    return `escalation automation ${automationId} started`;
  }
  return `escalation trigger failed: ${(result.stderr ?? "").trim()}`;
}

function buildReport(reason, context) {
  const details = [
    `reason: ${reason}`,
    `origin/main: ${context.oldMain}`,
    `upstream/main: ${context.upstreamTip}`,
    `upstream protocol version: ${context.upstreamVersion ?? "unknown"}`,
    `fork protocol version: ${context.forkVersion ?? "unknown"}`,
    `target protocol version: ${context.targetVersion === undefined ? "unknown" : grouped(context.targetVersion)}`,
    `failed worktree: ${context.scratch}`,
    `run: ${process.env.BB_AUTOMATION_RUN_ID ?? "manual"}`,
  ];
  if (existsSync(context.scratch)) {
    const unmerged = lines(
      git(
        ["diff", "--name-only", "--diff-filter=U", "--", "."],
        context.scratch,
      ).out,
    );
    if (unmerged.length > 0) details.push(`unmerged: ${unmerged.join(", ")}`);
    const status = lines(git(["status", "--porcelain"], context.scratch).out);
    if (status.length > 0) details.push(`worktree status: ${status.join(" | ")}`);
    const stop = git(["rebase", "--show-current-patch=diff"], context.scratch);
    if (stop.ok && stop.out.trim().length > 0) {
      details.push(`stopped patch:\n${stop.out.trim().split("\n").slice(0, 120).join("\n")}`);
    }
  }
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${details.join("\n")}\n`, "utf8");
  return details;
}

function reportEscalation(reason, context) {
  const details = buildReport(reason, context);
  const triggered = triggerEscalation();
  return [
    `FORK SYNC ESCALATED: ${reason}`,
    ...details,
    `report: ${reportPath}`,
    triggered,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function reportFailure(reason, context) {
  const details = buildReport(reason, context);
  return [
    `FORK SYNC FAILED: ${reason}`,
    ...details,
    `report: ${reportPath}`,
  ].join("\n");
}

function main(context) {
  mustGit(["fetch", "upstream", "--prune"]);
  mustGit(["fetch", "origin", "--prune"]);
  context.oldMain = mustGit(["rev-parse", "origin/main"]).trim();
  context.upstreamTip = mustGit(["rev-parse", "upstream/main"]).trim();
  const behind = Number(
    mustGit(["rev-list", "--count", "origin/main..upstream/main"]).trim(),
  );
  if (behind === 0) return "";
  context.upstreamVersion = readProtocolVersion(
    mustGit(["show", `upstream/main:${PROTOCOL_PATH}`]),
    "upstream/main's protocol.ts",
  );
  context.forkVersion = readProtocolVersion(
    mustGit(["show", `origin/main:${PROTOCOL_PATH}`]),
    "origin/main's protocol.ts",
  );
  const upstreamTarget = PROTOCOL_OFFSET + context.upstreamVersion;
  context.targetVersion =
    upstreamTarget >= context.forkVersion ? upstreamTarget : context.forkVersion + 1;
  context.forkCommitCount = Number(
    mustGit(["rev-list", "--count", "upstream/main..origin/main"]).trim(),
  );

  prepareScratch(context);
  context.scratch = scratch;
  const resolved = rebase(context);
  verify(context);
  context.newTip = mustGit(["rev-parse", "HEAD"], context.scratch).trim();
  const pushResult = push(context);
  const checkoutResult = syncCheckout(context);
  cleanup(context);

  const resolvedLine =
    resolved.size === 0
      ? "conflicts: none"
      : `conflicts resolved: ${[...resolved].sort().join(", ")}`;
  return [
    `Fork sync: ${behind} upstream commits rebased under ${context.forkCommitCount} fork commits; ${pushResult}`,
    `origin/main ${context.oldMain.slice(0, 9)} -> ${context.newTip.slice(0, 9)}`,
    `protocol version: ${grouped(context.forkVersion)} -> ${grouped(context.targetVersion)} (upstream ${context.upstreamVersion})`,
    resolvedLine,
    `checkout: ${checkoutResult}`,
  ].join("\n");
}

const context = { repo, oldMain: "", upstreamTip: "", scratch, newTip: "" };
try {
  const summary = main(context);
  if (summary.length > 0) process.stdout.write(`${summary}\n`);
} catch (error) {
  if (error instanceof Escalate) {
    process.stdout.write(`${reportEscalation(error.message, context)}\n`);
  } else {
    const detail = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${reportFailure(`mechanical sync failed: ${detail}`, context)}\n`);
    process.exitCode = 1;
  }
}
