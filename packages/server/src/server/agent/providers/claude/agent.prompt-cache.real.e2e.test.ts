import pino from "pino";
import { expect, test } from "vitest";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
import { ClaudeAgentClient } from "./agent.js";

// Explicit real-provider test: run separately from the default suite.
test("refreshes the prompt cache with a side question that stays out of the session", async () => {
  const client = new ClaudeAgentClient({ logger: pino({ level: "silent" }) });
  const session = await client.createSession(
    { provider: "claude", cwd: process.cwd(), model: "claude-haiku-4-5" },
    undefined,
    { persistSession: false },
  );
  try {
    const promptCache = session.promptCache;
    if (!promptCache) throw new Error("Claude sessions expose prompt cache control");
    await collectSessionTurnEvents(session, "Reply with exactly: OK. Do not use tools.", {
      signal: AbortSignal.timeout(90_000),
    });
    const before = promptCache.state();
    if (!before) throw new Error("A completed turn reports its cache lifetime");

    const emitted: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => emitted.push(event));
    await promptCache.refresh();
    unsubscribe();

    expect(emitted).toEqual([]);
    expect(promptCache.state()?.touchedAt.getTime()).toBeGreaterThan(before.touchedAt.getTime());
  } finally {
    await session.close();
  }
}, 300_000);
