import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
import type { AgentSession } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import { ClaudeSideQuestionError } from "./prompt-cache.js";
import type { ClaudeQueryFactory } from "./query.js";

const ONE_HOUR_MS = 60 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const T0 = new Date("2026-10-15T09:00:00.000Z");
const T1 = new Date("2026-10-15T09:54:00.000Z");

interface CacheWrite {
  ephemeral_1h_input_tokens: number;
  ephemeral_5m_input_tokens: number;
}

interface FakeTurn {
  cacheCreation: CacheWrite;
  /** Set to send the request from a subagent's sidechain instead of the main conversation. */
  parentToolUseId?: string;
}

const NO_WRITE: CacheWrite = { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 };
const ONE_HOUR_WRITE: CacheWrite = {
  ephemeral_1h_input_tokens: 1_200,
  ephemeral_5m_input_tokens: 0,
};
const FIVE_MINUTE_WRITE: CacheWrite = {
  ephemeral_1h_input_tokens: 0,
  ephemeral_5m_input_tokens: 1_200,
};

// Speaks Claude Code's stream for each pushed prompt. `askSideQuestion` stands in for the
// runtime-only side question method; omit it to model a CLI that predates side questions.
function cacheQuery({
  turns,
  askSideQuestion,
}: {
  turns: FakeTurn[];
  askSideQuestion?: (question: string) => Promise<unknown>;
}): ClaudeQueryFactory {
  return ({ prompt }) => {
    let turnIndex = 0;
    const messages = (async function* () {
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      for await (const _message of prompt) {
        const turn = turns[turnIndex];
        turnIndex += 1;
        if (!turn) throw new Error(`No fake turn ${turnIndex}`);
        const usage = {
          input_tokens: 10,
          cache_read_input_tokens: 40_000,
          cache_creation_input_tokens:
            turn.cacheCreation.ephemeral_1h_input_tokens +
            turn.cacheCreation.ephemeral_5m_input_tokens,
          cache_creation: turn.cacheCreation,
        };
        yield {
          type: "system",
          subtype: "init",
          session_id: "cache-session",
          permissionMode: "default",
          model: "claude-opus-5-5",
        };
        yield {
          type: "stream_event",
          session_id: "cache-session",
          parent_tool_use_id: turn.parentToolUseId ?? null,
          event: { type: "message_start", message: { usage } },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "cache-session",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "done",
          stop_reason: null,
          total_cost_usd: 0,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40_000 },
          modelUsage: {},
          permission_denials: [],
          uuid: `cache-result-${turnIndex}`,
        };
      }
    })();
    return Object.assign(messages, {
      close: () => {
        void messages.return();
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
      ...(askSideQuestion ? { askSideQuestion } : {}),
    }) as ReturnType<ClaudeQueryFactory>;
  };
}

async function createCacheSession(
  options: Parameters<typeof cacheQuery>[0],
): Promise<AgentSession> {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => process.execPath,
    queryFactory: cacheQuery(options),
  });
  return client.createSession({ provider: "claude", cwd: process.cwd(), model: "opus" });
}

function requirePromptCache(session: AgentSession) {
  if (!session.promptCache) throw new Error("Claude sessions expose prompt cache control");
  return session.promptCache;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

test("has no cache state before the runtime sends a request", async () => {
  const session = await createCacheSession({ turns: [] });
  try {
    expect(requirePromptCache(session).state()).toBeNull();
  } finally {
    await session.close();
  }
});

test.each([
  { name: "a subscription", write: ONE_HOUR_WRITE, ttlMs: ONE_HOUR_MS },
  { name: "an API key", write: FIVE_MINUTE_WRITE, ttlMs: FIVE_MINUTES_MS },
  {
    // Hour-long entries must precede 5-minute ones, so the conversation tail is the short one.
    name: "a mixed",
    write: { ephemeral_1h_input_tokens: 8_000, ephemeral_5m_input_tokens: 1_200 },
    ttlMs: FIVE_MINUTES_MS,
  },
])("reads the lifetime $name cache write reports", async ({ write, ttlMs }) => {
  const session = await createCacheSession({ turns: [{ cacheCreation: write }] });
  try {
    await collectSessionTurnEvents(session, "first");
    expect(requirePromptCache(session).state()).toEqual({ touchedAt: T0, ttlMs });
  } finally {
    await session.close();
  }
});

test("a request that writes nothing still refreshes the entry and keeps its lifetime", async () => {
  const session = await createCacheSession({
    turns: [{ cacheCreation: ONE_HOUR_WRITE }, { cacheCreation: NO_WRITE }],
  });
  try {
    await collectSessionTurnEvents(session, "first");
    vi.setSystemTime(T1);
    await collectSessionTurnEvents(session, "second");
    expect(requirePromptCache(session).state()).toEqual({ touchedAt: T1, ttlMs: ONE_HOUR_MS });
  } finally {
    await session.close();
  }
});

test("subagent requests do not touch the main conversation's cache", async () => {
  const session = await createCacheSession({
    turns: [
      { cacheCreation: ONE_HOUR_WRITE },
      { cacheCreation: FIVE_MINUTE_WRITE, parentToolUseId: "toolu_subagent" },
    ],
  });
  try {
    await collectSessionTurnEvents(session, "first");
    vi.setSystemTime(T1);
    await collectSessionTurnEvents(session, "second");
    expect(requirePromptCache(session).state()).toEqual({ touchedAt: T0, ttlMs: ONE_HOUR_MS });
  } finally {
    await session.close();
  }
});

test("refresh asks a side question and counts its start as the latest cache read", async () => {
  const questions: string[] = [];
  const session = await createCacheSession({
    turns: [{ cacheCreation: ONE_HOUR_WRITE }],
    askSideQuestion: async (question) => {
      questions.push(question);
      return { response: "ok", synthetic: false };
    },
  });
  try {
    await collectSessionTurnEvents(session, "first");
    vi.setSystemTime(T1);
    await requirePromptCache(session).refresh();
    expect(questions).toEqual(["Reply with only the word: ok"]);
    expect(requirePromptCache(session).state()).toEqual({ touchedAt: T1, ttlMs: ONE_HOUR_MS });
  } finally {
    await session.close();
  }
});

test.each([
  {
    name: "a synthetic answer",
    answer: { response: "(API error: overloaded)", synthetic: true },
  },
  { name: "no answer", answer: null },
])("refresh rejects $name and leaves the cache state alone", async ({ answer }) => {
  const session = await createCacheSession({
    turns: [{ cacheCreation: ONE_HOUR_WRITE }],
    askSideQuestion: async () => answer,
  });
  try {
    await collectSessionTurnEvents(session, "first");
    vi.setSystemTime(T1);
    await expect(requirePromptCache(session).refresh()).rejects.toEqual(
      new ClaudeSideQuestionError("unanswered"),
    );
    expect(requirePromptCache(session).state()).toEqual({ touchedAt: T0, ttlMs: ONE_HOUR_MS });
  } finally {
    await session.close();
  }
});

test("refresh rejects when the Claude CLI has no side questions", async () => {
  const session = await createCacheSession({ turns: [{ cacheCreation: ONE_HOUR_WRITE }] });
  try {
    await collectSessionTurnEvents(session, "first");
    await expect(requirePromptCache(session).refresh()).rejects.toEqual(
      new ClaudeSideQuestionError("unsupported"),
    );
  } finally {
    await session.close();
  }
});

test("refresh rejects once the runtime is closed", async () => {
  const session = await createCacheSession({
    turns: [{ cacheCreation: ONE_HOUR_WRITE }],
    askSideQuestion: async () => ({ response: "ok", synthetic: false }),
  });
  await collectSessionTurnEvents(session, "first");
  await session.close();
  await expect(requirePromptCache(session).refresh()).rejects.toEqual(
    new ClaudeSideQuestionError("no-runtime"),
  );
});
