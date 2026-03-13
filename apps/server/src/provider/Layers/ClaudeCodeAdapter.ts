/**
 * ClaudeCodeAdapterLive - Scoped live implementation for the Claude Code provider adapter.
 *
 * Uses the `@anthropic-ai/claude-agent-sdk` `query()` function to drive Claude
 * Code sessions and maps SDK messages into the shared `ProviderRuntimeEvent`
 * algebra.
 *
 * @module ClaudeCodeAdapterLive
 */
import type {
  CanonicalItemType,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderTurnStartResult,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";
import {
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterShape,
} from "../Services/ClaudeCodeAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claudeCode" as const;

// ── Helpers ─────────────────────────────────────────────────────────

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toRequestError(
  threadId: string,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

let eventSeq = 0;
function nextEventId(): string {
  return `cc-evt-${Date.now()}-${++eventSeq}`;
}

function nextItemId(): string {
  return `cc-item-${Date.now()}-${++eventSeq}`;
}

// ── Session context ─────────────────────────────────────────────────

interface ClaudeCodeSessionContext {
  sdkSessionId: string | undefined;
  threadId: ThreadId;
  cwd: string;
  model: string | undefined;
  abortController: AbortController;
  activeTurnId: TurnId | undefined;
  status: "ready" | "running" | "closed";
}

// ── SDK message → canonical event mapping ───────────────────────────

function mapToolNameToItemType(toolName: string): CanonicalItemType {
  const lower = toolName.toLowerCase();
  if (lower.includes("bash") || lower.includes("command") || lower.includes("exec"))
    return "command_execution";
  if (lower.includes("edit") || lower.includes("write") || lower.includes("patch"))
    return "file_change";
  if (lower.includes("read") || lower.includes("glob") || lower.includes("grep"))
    return "file_change";
  if (lower.includes("mcp")) return "mcp_tool_call";
  if (lower.includes("web") || lower.includes("search")) return "web_search";
  if (lower.includes("agent")) return "collab_agent_tool_call";
  return "dynamic_tool_call";
}

// ── Layer factory ───────────────────────────────────────────────────

export interface ClaudeCodeAdapterLiveOptions {
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function makeClaudeCodeAdapter(options?: ClaudeCodeAdapterLiveOptions) {
  return Effect.gen(function* () {
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<string, ClaudeCodeSessionContext>();

    const logNative = options?.nativeEventLogger;

    function emit(event: ProviderRuntimeEvent) {
      return Queue.offer(runtimeEventQueue, event);
    }

    function makeBaseEvent(
      threadId: ThreadId,
      turnId?: TurnId,
    ): Omit<ProviderRuntimeEvent, "type" | "payload"> {
      return {
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId,
        createdAt: new Date().toISOString(),
        ...(turnId ? { turnId } : {}),
      } as Omit<ProviderRuntimeEvent, "type" | "payload">;
    }

    function getSession(threadId: ThreadId): ClaudeCodeSessionContext {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return ctx;
    }

    // ── consumeSdkStream ────────────────────────────────────────────

    /** Map a single SDK message into zero or more canonical runtime events. */
    function mapSdkMessage(
      ctx: ClaudeCodeSessionContext,
      turnId: TurnId,
      sdkMsg: Record<string, unknown>,
    ): ProviderRuntimeEvent[] {
      const threadId = ctx.threadId;
      const msgType = sdkMsg.type as string;
      const events: ProviderRuntimeEvent[] = [];

      const base = (tId?: TurnId) =>
        makeBaseEvent(threadId, tId ?? turnId);

      switch (msgType) {
        case "system": {
          events.push(
            {
              ...base(),
              type: "session.started",
              payload: { message: "Claude Code session initialized" },
            } as ProviderRuntimeEvent,
            {
              ...base(),
              type: "session.state.changed",
              payload: { state: "running" },
            } as ProviderRuntimeEvent,
          );
          break;
        }

        case "assistant": {
          const message = sdkMsg.message as Record<string, unknown> | undefined;
          const content = (message?.content ?? sdkMsg.content) as unknown[];
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as Record<string, unknown>;
              if (b.type === "text") {
                const itemId = nextItemId();
                events.push(
                  {
                    ...base(),
                    type: "item.started",
                    itemId,
                    payload: { itemType: "assistant_message", title: "Assistant message" },
                  } as ProviderRuntimeEvent,
                  {
                    ...base(),
                    type: "content.delta",
                    itemId,
                    payload: { streamKind: "assistant_text", delta: String(b.text ?? "") },
                  } as ProviderRuntimeEvent,
                  {
                    ...base(),
                    type: "item.completed",
                    itemId,
                    payload: {
                      itemType: "assistant_message",
                      status: "completed",
                      title: "Assistant message",
                    },
                  } as ProviderRuntimeEvent,
                );
              } else if (b.type === "thinking") {
                const itemId = nextItemId();
                events.push(
                  {
                    ...base(),
                    type: "item.started",
                    itemId,
                    payload: { itemType: "reasoning", title: "Thinking" },
                  } as ProviderRuntimeEvent,
                  {
                    ...base(),
                    type: "content.delta",
                    itemId,
                    payload: { streamKind: "reasoning_text", delta: String(b.thinking ?? "") },
                  } as ProviderRuntimeEvent,
                  {
                    ...base(),
                    type: "item.completed",
                    itemId,
                    payload: { itemType: "reasoning", status: "completed", title: "Thinking" },
                  } as ProviderRuntimeEvent,
                );
              } else if (b.type === "tool_use") {
                const toolName = String(b.name ?? "tool");
                const itemType = mapToolNameToItemType(toolName);
                const itemId = nextItemId();
                events.push(
                  {
                    ...base(),
                    type: "item.started",
                    itemId,
                    payload: { itemType, title: toolName, detail: summarizeToolInput(b.input) },
                  } as ProviderRuntimeEvent,
                  {
                    ...base(),
                    type: "item.completed",
                    itemId,
                    payload: { itemType, status: "completed", title: toolName },
                  } as ProviderRuntimeEvent,
                );
              }
            }
          }
          break;
        }

        case "result": {
          const subtype = sdkMsg.subtype as string;
          const isError =
            sdkMsg.is_error === true ||
            (subtype !== "success" && subtype !== undefined);
          const turnState = isError ? "failed" : "completed";
          events.push(
            {
              ...base(),
              type: "turn.completed",
              payload: {
                state: turnState,
                stopReason: (sdkMsg.stop_reason as string | undefined) ?? null,
                totalCostUsd: sdkMsg.total_cost_usd as number | undefined,
                usage: sdkMsg.usage,
                modelUsage: sdkMsg.modelUsage as Record<string, unknown> | undefined,
                ...(isError
                  ? {
                      errorMessage:
                        (sdkMsg.result as string) ?? `Turn ended with ${subtype}`,
                    }
                  : {}),
              },
            } as ProviderRuntimeEvent,
          );
          ctx.activeTurnId = undefined;
          ctx.status = "ready";
          events.push({
            ...base(undefined),
            type: "session.state.changed",
            payload: { state: "ready" },
          } as ProviderRuntimeEvent);
          break;
        }

        case "partial": {
          const delta = sdkMsg.delta as Record<string, unknown> | undefined;
          if (delta) {
            const deltaType = delta.type as string;
            if (deltaType === "text_delta" || deltaType === "content_block_delta") {
              events.push({
                ...base(),
                type: "content.delta",
                payload: {
                  streamKind: "assistant_text",
                  delta: String(delta.text ?? delta.delta ?? ""),
                },
              } as ProviderRuntimeEvent);
            } else if (deltaType === "thinking_delta") {
              events.push({
                ...base(),
                type: "content.delta",
                payload: {
                  streamKind: "reasoning_text",
                  delta: String(delta.thinking ?? delta.delta ?? ""),
                },
              } as ProviderRuntimeEvent);
            }
          }
          break;
        }

        case "tool_progress": {
          events.push({
            ...base(),
            type: "tool.progress",
            payload: {
              toolName: sdkMsg.toolName as string | undefined,
              summary: sdkMsg.summary as string | undefined,
              elapsedSeconds: sdkMsg.elapsedSeconds as number | undefined,
            },
          } as ProviderRuntimeEvent);
          break;
        }

        case "tool_use_summary": {
          events.push({
            ...base(),
            type: "tool.summary",
            payload: { summary: (sdkMsg.summary as string) ?? "Tool use completed" },
          } as ProviderRuntimeEvent);
          break;
        }

        default:
          break;
      }

      return events;
    }

    function consumeSdkStream(
      ctx: ClaudeCodeSessionContext,
      turnId: TurnId,
      generator: AsyncGenerator<unknown, void>,
    ) {
      return Effect.tryPromise({
        try: async () => {
          const threadId = ctx.threadId;
          for await (const msg of generator) {
            if (ctx.status === "closed") break;
            const sdkMsg = msg as Record<string, unknown>;

            // Capture session_id from any message
            if (typeof sdkMsg.session_id === "string" && !ctx.sdkSessionId) {
              ctx.sdkSessionId = sdkMsg.session_id;
            }

            if (logNative) {
              logNative({
                source: "claudeCode.sdk.message",
                payload: sdkMsg,
              });
            }

            const events = mapSdkMessage(ctx, turnId, sdkMsg);
            for (const event of events) {
              await Queue.offer(runtimeEventQueue, event).pipe(Effect.runPromise);
            }
          }
        },
        catch: async (error) => {
          if (ctx.status === "closed") return;
          const errorMessage = toMessage(error, "SDK stream error");
          const errorEvents: ProviderRuntimeEvent[] = [
            {
              ...makeBaseEvent(ctx.threadId, turnId),
              type: "runtime.error",
              payload: { message: errorMessage, class: "provider_error" },
            } as ProviderRuntimeEvent,
            {
              ...makeBaseEvent(ctx.threadId, turnId),
              type: "turn.completed",
              payload: { state: "failed", errorMessage },
            } as ProviderRuntimeEvent,
          ];
          for (const event of errorEvents) {
            await Queue.offer(runtimeEventQueue, event).pipe(Effect.runPromise);
          }
          ctx.activeTurnId = undefined;
          ctx.status = "ready";
        },
      }).pipe(Effect.ignore);
    }

    function summarizeToolInput(input: unknown): string | undefined {
      if (!input || typeof input !== "object") return undefined;
      const obj = input as Record<string, unknown>;
      // For bash/command tools
      if (typeof obj.command === "string") return obj.command;
      // For file tools
      if (typeof obj.file_path === "string") return obj.file_path;
      if (typeof obj.path === "string") return obj.path;
      // For search tools
      if (typeof obj.pattern === "string") return obj.pattern;
      return undefined;
    }

    // ── Adapter methods ─────────────────────────────────────────────

    const startSession: ClaudeCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const threadId = input.threadId;

        if (
          input.provider !== undefined &&
          input.provider !== PROVIDER
        ) {
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "startSession",
              detail: `Provider mismatch: expected ${PROVIDER}, got ${input.provider}`,
            }),
          );
        }

        const ctx: ClaudeCodeSessionContext = {
          sdkSessionId: undefined,
          threadId,
          cwd: input.cwd ?? process.cwd(),
          model: input.model,
          abortController: new AbortController(),
          activeTurnId: undefined,
          status: "ready",
        };
        sessions.set(threadId, ctx);

        const now = new Date().toISOString();

        // Emit synthetic session-started events
        yield* emit({
          ...makeBaseEvent(threadId),
          type: "session.started",
          payload: { message: "Claude Code session ready" },
        } as ProviderRuntimeEvent);
        yield* emit({
          ...makeBaseEvent(threadId),
          type: "session.state.changed",
          payload: { state: "ready" },
        } as ProviderRuntimeEvent);

        return {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId,
          cwd: ctx.cwd,
          model: ctx.model,
          createdAt: now,
          updatedAt: now,
        } satisfies ProviderSession;
      });

    const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = getSession(input.threadId);
        const turnId = `cc-turn-${Date.now()}` as TurnId;
        ctx.activeTurnId = turnId;
        ctx.status = "running";

        // Update model if changed
        if (input.model) {
          ctx.model = input.model;
        }

        // Emit turn.started
        yield* emit({
          ...makeBaseEvent(ctx.threadId, turnId),
          type: "turn.started",
          payload: {
            model: ctx.model,
          },
        } as ProviderRuntimeEvent);

        // Create a new AbortController for this turn
        ctx.abortController = new AbortController();

        // Build SDK query options
        const queryOptions: Record<string, unknown> = {
          model: ctx.model,
          cwd: ctx.cwd,
          abortController: ctx.abortController,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        };

        // Resume session if we have a previous SDK session id
        if (ctx.sdkSessionId) {
          queryOptions.resume = ctx.sdkSessionId;
        }

        const prompt = input.input ?? "";

        try {
          const generator = sdkQuery({
            prompt,
            options: queryOptions,
          });

          // Consume the stream in a background daemon fiber
          yield* consumeSdkStream(ctx, turnId, generator).pipe(
            Effect.forkDaemon,
          );
        } catch (error) {
          ctx.activeTurnId = undefined;
          ctx.status = "ready";
          return yield* Effect.fail(
            toRequestError(ctx.threadId, "sendTurn", error),
          );
        }

        return {
          threadId: ctx.threadId,
          turnId,
        } satisfies ProviderTurnStartResult;
      });

    const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (
      threadId,
      _turnId,
    ) =>
      Effect.gen(function* () {
        const ctx = getSession(threadId);
        ctx.abortController.abort();
        ctx.activeTurnId = undefined;
        ctx.status = "ready";

        yield* emit({
          ...makeBaseEvent(threadId),
          type: "turn.completed",
          payload: { state: "interrupted" },
        } as ProviderRuntimeEvent);
        yield* emit({
          ...makeBaseEvent(threadId),
          type: "session.state.changed",
          payload: { state: "ready" },
        } as ProviderRuntimeEvent);
      });

    const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = (
      threadId,
      _requestId,
      _decision,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail:
            "Claude Code SDK handles tool permissions internally via permissionMode",
        }),
      );

    const respondToUserInput: ClaudeCodeAdapterShape["respondToUserInput"] = (
      threadId,
      _requestId,
      _answers,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: "User input responses not supported in Claude Code SDK mode",
        }),
      );

    const stopSession: ClaudeCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) return;
        ctx.abortController.abort();
        ctx.status = "closed";
        sessions.delete(threadId);

        yield* emit({
          ...makeBaseEvent(threadId),
          type: "session.exited",
          payload: { exitKind: "graceful" },
        } as ProviderRuntimeEvent);
      });

    const listSessions: ClaudeCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => {
        const now = new Date().toISOString();
        return Array.from(sessions.values()).map((ctx) => ({
          provider: PROVIDER as const,
          status: ctx.status === "running" ? ("running" as const) : ("ready" as const),
          runtimeMode: "full-access" as const,
          threadId: ctx.threadId,
          cwd: ctx.cwd,
          model: ctx.model,
          createdAt: now,
          updatedAt: now,
        }));
      });

    const hasSession: ClaudeCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: ClaudeCodeAdapterShape["readThread"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "readThread",
          detail: "Thread reading not supported by Claude Code SDK adapter",
        }),
      );

    const rollbackThread: ClaudeCodeAdapterShape["rollbackThread"] = (
      threadId,
      _numTurns,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "Thread rollback not supported by Claude Code SDK adapter",
        }),
      );

    const stopAll: ClaudeCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        for (const [threadId, ctx] of sessions) {
          ctx.abortController.abort();
          ctx.status = "closed";
          yield* emit({
            ...makeBaseEvent(threadId as ThreadId),
            type: "session.exited",
            payload: { exitKind: "graceful" },
          } as ProviderRuntimeEvent);
        }
        sessions.clear();
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "restart-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeCodeAdapterShape;
  });
}

export const ClaudeCodeAdapterLive = Layer.effect(
  ClaudeCodeAdapter,
  makeClaudeCodeAdapter(),
);

export function makeClaudeCodeAdapterLive(
  options?: ClaudeCodeAdapterLiveOptions,
) {
  return Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter(options));
}
