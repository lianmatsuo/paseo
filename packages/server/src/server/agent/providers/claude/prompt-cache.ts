import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const ONE_HOUR_MS = 60 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;

// Side questions cannot use tools, so the cheapest answer is a word.
const REFRESH_QUESTION = "Reply with only the word: ok";

const CacheCreationSchema = z.object({
  ephemeral_1h_input_tokens: z.number().optional(),
  ephemeral_5m_input_tokens: z.number().optional(),
});

const MessageStartSchema = z.object({
  type: z.literal("message_start"),
  message: z.object({
    usage: z
      .object({
        cache_read_input_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
        cache_creation: CacheCreationSchema.nullable().optional(),
      })
      .optional(),
  }),
});

const SideQuestionAnswerSchema = z
  .object({ response: z.string().nullable(), synthetic: z.boolean() })
  .nullable();

export type ClaudeSideQuestionFailure = "no-runtime" | "unsupported" | "unanswered";

export class ClaudeSideQuestionError extends Error {
  constructor(readonly reason: ClaudeSideQuestionFailure) {
    super(`Claude side question failed: ${reason}`);
    this.name = "ClaudeSideQuestionError";
  }
}

export interface ClaudeRequestStart {
  /** Null when the request wrote nothing, which says nothing about the lifetime. */
  ttlMs: number | null;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Reads a main-conversation request start off the raw stream. Claude Code picks the cache
 * lifetime per account (1h on a subscription within its limits, 5m on an API key or cloud
 * provider) and reports which one each request wrote, so Paseo observes it instead of guessing.
 */
export function readClaudeRequestStart(streamEvent: unknown): ClaudeRequestStart | null {
  const parsed = MessageStartSchema.safeParse(streamEvent);
  if (!parsed.success) return null;
  const usage = parsed.data.message.usage;
  return {
    ttlMs: readWrittenTtlMs(usage?.cache_creation ?? null),
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

/** Hour-long entries must precede 5-minute ones, so any 5-minute write holds the conversation tail. */
function readWrittenTtlMs(write: z.infer<typeof CacheCreationSchema> | null): number | null {
  if ((write?.ephemeral_5m_input_tokens ?? 0) > 0) return FIVE_MINUTES_MS;
  if ((write?.ephemeral_1h_input_tokens ?? 0) > 0) return ONE_HOUR_MS;
  return null;
}

/**
 * Asks Claude Code a side question (its /btw). Claude Code runs it on the main conversation's
 * last request and moves the cache marker back onto that prefix, so it reads exactly the entry
 * the next turn will read, writes no new entry, and adds nothing to the transcript.
 */
export async function askRefreshSideQuestion(query: Query): Promise<void> {
  // The SDK runtime supports this, but its public Query type has not caught up. Keep the
  // compatibility escape hatch inside the Claude adapter.
  const askSideQuestion = (
    query as Query & { askSideQuestion?: (question: string) => Promise<unknown> }
  ).askSideQuestion;
  if (!askSideQuestion) throw new ClaudeSideQuestionError("unsupported");
  const answer = SideQuestionAnswerSchema.parse(
    await askSideQuestion.call(query, REFRESH_QUESTION),
  );
  // Claude Code substitutes a synthetic answer for an API error, so only a real one proves the read.
  if (!answer || answer.synthetic || answer.response === null) {
    throw new ClaudeSideQuestionError("unanswered");
  }
}
