import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "../agent/agent-manager.js";
import type { AgentClient, AgentSession, PromptCacheControl } from "../agent/agent-sdk-types.js";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { setupPromptCacheKeepWarm, type KeepWarmClock } from "./index.js";

const MINUTE_MS = 60_000;
const T0 = new Date("2026-10-15T09:00:00.000Z");
const logger = createTestLogger();

function minutesAfterT0(minutes: number): Date {
  return new Date(T0.getTime() + minutes * MINUTE_MS);
}

function toMinutesAfterT0(dates: Date[]): number[] {
  return dates.map((date) => (date.getTime() - T0.getTime()) / MINUTE_MS);
}

interface ManualClock extends KeepWarmClock {
  /** Runs every timer due by `date`, in order, as a running host would. */
  advanceTo(date: Date): Promise<void>;
  /** Jumps to `date` before running overdue timers, as a host waking from sleep would. */
  wakeAt(date: Date): Promise<void>;
  pendingCount(): number;
}

interface ManualTimer {
  at: number;
  callback: () => Promise<void>;
}

function createManualClock(start: Date): ManualClock {
  let current = start.getTime();
  const timers = new Set<ManualTimer>();

  async function runDue(until: number, firedAt: (timer: ManualTimer) => number): Promise<void> {
    for (;;) {
      const due = [...timers].filter((timer) => timer.at <= until);
      const next = due.sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.delete(next);
      current = firedAt(next);
      await next.callback();
    }
    current = until;
  }

  return {
    now: () => new Date(current),
    schedule(callback, delayMs) {
      const timer = { at: current + delayMs, callback };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    advanceTo: (date) => runDue(date.getTime(), (timer) => timer.at),
    wakeAt: (date) => runDue(date.getTime(), () => date.getTime()),
    pendingCount: () => timers.size,
  };
}

interface FakePromptCache {
  touchedAt: Date | null;
  ttlMs: number;
  failRefresh: boolean;
  refreshAttempts: Date[];
  refreshes: Date[];
}

function createFakePromptCache(ttlMs: number): FakePromptCache {
  return { touchedAt: null, ttlMs, failRefresh: false, refreshAttempts: [], refreshes: [] };
}

function createPromptCacheControl(
  cache: FakePromptCache,
  clock: KeepWarmClock,
): PromptCacheControl {
  return {
    state: () => (cache.touchedAt ? { touchedAt: cache.touchedAt, ttlMs: cache.ttlMs } : null),
    refresh: async () => {
      cache.refreshAttempts.push(clock.now());
      if (cache.failRefresh) throw new Error("side question failed");
      cache.refreshes.push(clock.now());
      cache.touchedAt = clock.now();
    },
  };
}

// A provider whose turns touch the prompt cache at the clock's current time.
function createWarmableClient(cache: FakePromptCache, clock: KeepWarmClock): AgentClient {
  const base = createTestAgentClient("claude", {
    onStartTurn: () => {
      cache.touchedAt = clock.now();
    },
  });
  const control = createPromptCacheControl(cache, clock);
  function withPromptCache(session: AgentSession): AgentSession {
    return Object.assign(session, { promptCache: control });
  }
  return {
    provider: base.provider,
    capabilities: base.capabilities,
    isAvailable: (signal, options) => base.isAvailable(signal, options),
    fetchCatalog: (options, context) => base.fetchCatalog(options, context),
    createSession: async (config, launchContext, options) =>
      withPromptCache(await base.createSession(config, launchContext, options)),
    resumeSession: async (handle, overrides, launchContext, options) =>
      withPromptCache(await base.resumeSession(handle, overrides, launchContext, options)),
  };
}

function baseConfig(keepPromptCacheWarm: boolean): MutableDaemonConfig {
  return {
    relay: { enabled: false },
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    keepPromptCacheWarm,
    appendSystemPrompt: "",
  };
}

interface Harness {
  clock: ManualClock;
  cache: FakePromptCache;
  manager: AgentManager;
  store: DaemonConfigStore;
  workdir: string;
  /** Runs one turn to completion at the clock's current time. */
  runTurn(agentId: string): Promise<void>;
  createAgent(labels?: Record<string, string>): Promise<string>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createHarness(options: { enabled: boolean; ttlMs?: number }): Promise<Harness> {
  const clock = createManualClock(T0);
  const cache = createFakePromptCache(options.ttlMs ?? 60 * MINUTE_MS);
  const workdir = mkdtempSync(join(tmpdir(), "prompt-cache-keep-warm-"));
  const paseoHome = mkdtempSync(join(tmpdir(), "prompt-cache-keep-warm-home-"));
  const manager = new AgentManager({
    clients: { claude: createWarmableClient(cache, clock) },
    logger,
  });
  const store = new DaemonConfigStore(paseoHome, baseConfig(options.enabled));
  const dispose = setupPromptCacheKeepWarm({
    agentManager: manager,
    daemonConfigStore: store,
    logger,
    clock,
  });
  const agentIds: string[] = [];
  cleanups.push(async () => {
    dispose();
    for (const agentId of agentIds) await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
    rmSync(paseoHome, { recursive: true, force: true });
  });

  return {
    clock,
    cache,
    manager,
    store,
    workdir,
    async createAgent(labels) {
      const agent = await manager.createAgent({ provider: "claude", cwd: workdir }, undefined, {
        workspaceId: undefined,
        ...(labels ? { labels } : {}),
      });
      agentIds.push(agent.id);
      return agent.id;
    },
    async runTurn(agentId) {
      for await (const _event of manager.streamAgent(agentId, "hello")) {
        // AgentManager subscribers, the keep-warm owner among them, observe the turn.
      }
      await manager.waitForAgentEvent(agentId);
    },
  };
}

test("refreshes five minutes before each expiry for four hours after the last turn", async () => {
  const harness = await createHarness({ enabled: true });
  const agentId = await harness.createAgent();
  await harness.runTurn(agentId);

  await harness.clock.advanceTo(minutesAfterT0(6 * 60));

  expect(toMinutesAfterT0(harness.cache.refreshes)).toEqual([55, 110, 165, 220]);
  expect(harness.clock.pendingCount()).toBe(0);
});

test("does nothing while the setting is off", async () => {
  const harness = await createHarness({ enabled: false });
  const agentId = await harness.createAgent();
  await harness.runTurn(agentId);

  await harness.clock.advanceTo(minutesAfterT0(2 * 60));

  expect(harness.cache.refreshAttempts).toEqual([]);
});

test("leaves caches that expire after five minutes alone", async () => {
  const harness = await createHarness({ enabled: true, ttlMs: 5 * MINUTE_MS });
  const agentId = await harness.createAgent();
  await harness.runTurn(agentId);

  await harness.clock.advanceTo(minutesAfterT0(2 * 60));

  expect(harness.cache.refreshAttempts).toEqual([]);
});

test("a new turn restarts warming from that turn", async () => {
  const harness = await createHarness({ enabled: true });
  const agentId = await harness.createAgent();
  await harness.runTurn(agentId);
  await harness.clock.advanceTo(minutesAfterT0(80));
  await harness.runTurn(agentId);

  await harness.clock.advanceTo(minutesAfterT0(80 + 6 * 60));

  expect(toMinutesAfterT0(harness.cache.refreshes)).toEqual([55, 135, 190, 245, 300]);
});

test("stops for the idle stretch when the host wakes after the cache expired", async () => {
  const harness = await createHarness({ enabled: true });
  const agentId = await harness.createAgent();
  await harness.runTurn(agentId);

  await harness.clock.wakeAt(minutesAfterT0(70));
  await harness.clock.advanceTo(minutesAfterT0(6 * 60));

  expect(harness.cache.refreshAttempts).toEqual([]);
  expect(harness.clock.pendingCount()).toBe(0);
});

test("stops after a failed refresh until the next turn", async () => {
  const harness = await createHarness({ enabled: true });
  const agentId = await harness.createAgent();
  harness.cache.failRefresh = true;
  await harness.runTurn(agentId);

  await harness.clock.advanceTo(minutesAfterT0(3 * 60));
  expect(toMinutesAfterT0(harness.cache.refreshAttempts)).toEqual([55]);

  harness.cache.failRefresh = false;
  await harness.runTurn(agentId);
  await harness.clock.advanceTo(minutesAfterT0(3 * 60 + 55));
  expect(toMinutesAfterT0(harness.cache.refreshes)).toEqual([3 * 60 + 55]);
});

test("does not warm subagents", async () => {
  const harness = await createHarness({ enabled: true });
  const agentId = await harness.createAgent({ [PARENT_AGENT_ID_LABEL]: "parent-agent" });
  await harness.runTurn(agentId);

  await harness.clock.advanceTo(minutesAfterT0(2 * 60));

  expect(harness.cache.refreshAttempts).toEqual([]);
});

test("turning the setting on warms agents that are already idle", async () => {
  const harness = await createHarness({ enabled: false });
  const agentId = await harness.createAgent();
  await harness.runTurn(agentId);
  await harness.clock.advanceTo(minutesAfterT0(10));

  harness.store.patch({ keepPromptCacheWarm: true });
  await harness.clock.advanceTo(minutesAfterT0(60));

  expect(toMinutesAfterT0(harness.cache.refreshes)).toEqual([55]);
});

test("turning the setting off cancels pending refreshes", async () => {
  const harness = await createHarness({ enabled: true });
  const agentId = await harness.createAgent();
  await harness.runTurn(agentId);
  await harness.clock.advanceTo(minutesAfterT0(10));

  harness.store.patch({ keepPromptCacheWarm: false });
  await harness.clock.advanceTo(minutesAfterT0(2 * 60));

  expect(harness.cache.refreshAttempts).toEqual([]);
  expect(harness.clock.pendingCount()).toBe(0);
});
