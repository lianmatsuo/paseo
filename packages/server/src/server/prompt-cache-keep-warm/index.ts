import type { Logger } from "pino";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { PromptCacheControl, PromptCacheState } from "../agent/agent-sdk-types.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";

const MINUTE_MS = 60_000;
/** Refresh this long before the entry would expire, so a slow timer or request still lands. */
const REFRESH_LEAD_MS = 5 * MINUTE_MS;
/** Closer to expiry than this, the entry may be gone and a refresh would pay full price. */
const EXPIRY_GUARD_MS = MINUTE_MS;
/**
 * Every refresh re-reads the whole conversation at the cache-read price, so warming stops this
 * long after the agent's last turn instead of paying for agents nobody comes back to.
 */
const KEEP_WARM_HORIZON_MS = 4 * 60 * MINUTE_MS;
/**
 * A 5-minute cache would need a refresh every few minutes, which outspends the re-write it saves
 * unless the user is back within the hour. Only hour-long caches are worth keeping warm.
 */
const MIN_KEEP_WARM_TTL_MS = 60 * MINUTE_MS;

export interface KeepWarmClock {
  now(): Date;
  /** Returns a function that cancels the callback. */
  schedule(callback: () => Promise<void>, delayMs: number): () => void;
}

const systemClock: KeepWarmClock = {
  now: () => new Date(),
  schedule(callback, delayMs) {
    const timer = setTimeout(() => void callback(), delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface PromptCacheKeepWarmOptions {
  agentManager: Pick<AgentManager, "subscribe" | "getAgent" | "listAgents">;
  daemonConfigStore: Pick<DaemonConfigStore, "get" | "onChange">;
  logger: Logger;
  clock?: KeepWarmClock;
}

type StopReason = "expired" | "horizon" | "lifetime" | "refresh_failed";

/** One idle stretch of one agent. It ends when the agent leaves idle or the setting turns off. */
type IdleStretch =
  | { status: "scheduled"; warmSince: Date; cancel: () => void }
  | { status: "refreshing"; warmSince: Date }
  | { status: "stopped" };

/**
 * Keeps an idle agent's prompt cache from expiring so the user's next turn reads the conversation
 * instead of re-writing it. See docs/agent-lifecycle.md#prompt-cache-keep-warm.
 */
export function setupPromptCacheKeepWarm(options: PromptCacheKeepWarmOptions): () => void {
  const { agentManager, daemonConfigStore } = options;
  const clock = options.clock ?? systemClock;
  const log = options.logger.child({ module: "prompt-cache-keep-warm" });
  const stretches = new Map<string, IdleStretch>();
  let enabled = daemonConfigStore.get().keepPromptCacheWarm === true;

  function end(agentId: string): void {
    const stretch = stretches.get(agentId);
    if (stretch?.status === "scheduled") stretch.cancel();
    stretches.delete(agentId);
  }

  function stop(agentId: string, reason: StopReason): void {
    end(agentId);
    stretches.set(agentId, { status: "stopped" });
    log.info({ agentId, reason }, "prompt_cache.keep_warm.stopped");
  }

  function schedule(agentId: string, warmSince: Date, state: PromptCacheState): void {
    const dueAt = state.touchedAt.getTime() + state.ttlMs - REFRESH_LEAD_MS;
    const delayMs = Math.max(0, dueAt - clock.now().getTime());
    const stretch: IdleStretch = {
      status: "scheduled",
      warmSince,
      cancel: clock.schedule(() => refreshIfDue(agentId, stretch), delayMs),
    };
    stretches.set(agentId, stretch);
  }

  function observe(agent: ManagedAgent): void {
    const control = readWarmableControl(agent);
    if (!control) {
      end(agent.id);
      return;
    }
    if (!enabled || stretches.has(agent.id)) return;
    const state = control.state();
    // Re-evaluated on the agent's next state change, once a request has reported a lifetime.
    if (!state || state.ttlMs < MIN_KEEP_WARM_TTL_MS) return;
    schedule(agent.id, state.touchedAt, state);
  }

  async function refreshIfDue(agentId: string, stretch: IdleStretch): Promise<void> {
    if (stretches.get(agentId) !== stretch || stretch.status !== "scheduled") return;
    const agent = agentManager.getAgent(agentId);
    const control = agent ? readWarmableControl(agent) : null;
    if (!control) {
      end(agentId);
      return;
    }
    const state = control.state();
    if (!state || state.ttlMs < MIN_KEEP_WARM_TTL_MS) {
      stop(agentId, "lifetime");
      return;
    }
    const now = clock.now().getTime();
    const expiresAt = state.touchedAt.getTime() + state.ttlMs;
    if (now >= expiresAt - EXPIRY_GUARD_MS) {
      stop(agentId, "expired");
      return;
    }
    if (now < expiresAt - REFRESH_LEAD_MS) {
      // The provider used the cache since this was scheduled.
      schedule(agentId, stretch.warmSince, state);
      return;
    }
    if (now - stretch.warmSince.getTime() >= KEEP_WARM_HORIZON_MS) {
      stop(agentId, "horizon");
      return;
    }

    const refreshing: IdleStretch = { status: "refreshing", warmSince: stretch.warmSince };
    stretches.set(agentId, refreshing);
    try {
      await control.refresh();
    } catch (error) {
      if (stretches.get(agentId) !== refreshing) return;
      log.warn({ err: error, agentId }, "prompt_cache.keep_warm.refresh_failed");
      stop(agentId, "refresh_failed");
      return;
    }
    if (stretches.get(agentId) !== refreshing) return;
    const refreshed = control.state();
    log.info(
      { agentId, idleMs: now - refreshing.warmSince.getTime() },
      "prompt_cache.keep_warm.refreshed",
    );
    if (!refreshed) {
      stop(agentId, "lifetime");
      return;
    }
    schedule(agentId, refreshing.warmSince, refreshed);
  }

  function endAll(): void {
    for (const stretch of stretches.values()) {
      if (stretch.status === "scheduled") stretch.cancel();
    }
    stretches.clear();
  }

  const unsubscribeAgents = agentManager.subscribe((event) => {
    if (event.type === "agent_state") observe(event.agent);
  });
  const unsubscribeConfig = daemonConfigStore.onChange((config) => {
    const next = config.keepPromptCacheWarm === true;
    if (next === enabled) return;
    enabled = next;
    if (!enabled) {
      endAll();
      return;
    }
    for (const agent of agentManager.listAgents()) observe(agent);
  });

  return () => {
    unsubscribeAgents();
    unsubscribeConfig();
    endAll();
  };
}

/** Idle root agents whose provider can refresh its cache without a turn. */
function readWarmableControl(agent: ManagedAgent): PromptCacheControl | null {
  if (agent.lifecycle !== "idle" || agent.labels[PARENT_AGENT_ID_LABEL]) return null;
  return agent.session.promptCache ?? null;
}
