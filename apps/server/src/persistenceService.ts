import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  DEFAULT_MODEL,
  type AppSettings,
  type AppSettingsUpdateInput,
  type ProjectAddInput,
  type ProjectAddResult,
  type ProjectListResult,
  type ProjectRemoveInput,
  type ProjectUpdateScriptsInput,
  type ProjectUpdateScriptsResult,
  type ProviderEvent,
  type ProviderSendTurnInput,
  type StateBootstrapResult,
  type StateBootstrapThread,
  type StateCatchUpInput,
  type StateCatchUpResult,
  type StateEvent,
  type StateListMessagesInput,
  type StateListMessagesResult,
  type StateMessage,
  type StateProject,
  type StateThread,
  type StateTurnDiffFileChange,
  type StateTurnSummary,
  type ThreadsCreateInput,
  type ThreadsDeleteInput,
  type ThreadsMarkVisitedInput,
  type ThreadsUpdateBranchInput,
  type ThreadsUpdateModelInput,
  type ThreadsUpdateResult,
  type ThreadsUpdateTerminalStateInput,
  type ThreadsUpdateTitleInput,
  normalizeProjectScripts,
  projectAddInputSchema,
  projectRecordSchema,
  projectRemoveInputSchema,
  projectScriptsSchema,
  projectUpdateScriptsInputSchema,
  stateCatchUpInputSchema,
  stateListMessagesInputSchema,
  stateMessageSchema,
  stateProjectSchema,
  stateThreadSchema,
  stateTurnSummarySchema,
  threadsCreateInputSchema,
  threadsDeleteInputSchema,
  threadsMarkVisitedInputSchema,
  threadsUpdateBranchInputSchema,
  threadsUpdateModelInputSchema,
  threadsUpdateTerminalStateInputSchema,
  threadsUpdateTitleInputSchema,
  threadsUpdateResultSchema,
} from "@t3tools/contracts";

import {
  countMessagesForThread as countMessagesForThreadEffect,
  deleteDocumentByIdAndKind as deleteDocumentByIdAndKindEffect,
  deleteDocumentsByProjectId as deleteDocumentsByProjectIdEffect,
  deleteDocumentsByThreadId as deleteDocumentsByThreadIdEffect,
  findThreadPayloadByRuntimeThreadId as findThreadPayloadByRuntimeThreadIdEffect,
  getDocumentRowById as getDocumentRowByIdEffect,
  listPaginatedMessagePayloadsForThread as listPaginatedMessagePayloadsForThreadEffect,
  listProjectPayloads as listProjectPayloadsEffect,
  listMessagePayloadsForThread as listMessagePayloadsForThreadEffect,
  listMessagePayloadsForThreadDesc as listMessagePayloadsForThreadDescEffect,
  listThreadPayloads as listThreadPayloadsEffect,
  listThreadPayloadsByProject as listThreadPayloadsByProjectEffect,
  listTurnSummaryPayloadsForThread as listTurnSummaryPayloadsForThreadEffect,
  readNextSortKey as readNextSortKeyEffect,
  upsertDocument as upsertDocumentEffect,
  type DocumentRow,
} from "./persistence/repos/documentsRepo";
import {
  insertProviderEvent as insertProviderEventEffect,
  listCompletedItemEventsBySessionTurn as listCompletedItemEventsBySessionTurnEffect,
  listCompletedItemEventsByThreadTurn as listCompletedItemEventsByThreadTurnEffect,
  listCompletedItemEventsByTurn as listCompletedItemEventsByTurnEffect,
  type CompletedProviderItemRow,
} from "./persistence/repos/providerEventsRepo";
import {
  appendStateEvent as appendStateEventEffect,
  listStateEventsAfterSeq as listStateEventsAfterSeqEffect,
  readLastStateSeq as readLastStateSeqEffect,
} from "./persistence/repos/stateEventsRepo";
import {
  readMetadataValue as readMetadataValueEffect,
  writeMetadataValue as writeMetadataValueEffect,
} from "./persistence/repos/metadataRepo";
import {
  buildUpdatedAppSettings,
  resolveAppSettings,
} from "./persistence/domain/appSettings";
import { buildUserTurnMessage, messageDocId } from "./persistence/domain/messages";
import {
  inferProjectName,
  isDirectory,
  normalizeCwd,
} from "./persistence/domain/projects";
import {
  asObject,
  asString,
  normalizeProviderItemType,
  parseAssistantItemId,
  parseThreadIdFromEventPayload,
  parseTurnIdFromEvent,
} from "./persistence/domain/providerProjection";
import {
  buildStateBootstrapResult,
  buildStateCatchUpResult,
  buildStateListMessagesResult,
} from "./persistence/domain/stateSync";
import { fallbackGroupId, normalizeTerminalIds, normalizeThread } from "./persistence/domain/threads";
import { mergeTurnSummaryFiles, summarizeUnifiedDiff } from "./persistence/domain/turnSummaries";
import { resolvePersistenceConfig } from "./persistence/config";
import { PersistenceInitializationError } from "./persistence/errors";
import { runPersistenceMigrations } from "./persistence/migrator";
import { runWithSqlClient } from "./persistence/runtime";
import { openPersistenceSqliteDatabase } from "./persistence/sqliteLayer";
import type { SqliteDatabase } from "./sqliteAdapter";

const METADATA_KEY_PROJECTS_JSON_IMPORTED = "migration.projects_json_imported";
const METADATA_KEY_APP_SETTINGS = "app.settings.v1";
const DEFAULT_TERMINAL_ID = "default";
const DEFAULT_TERMINAL_HEIGHT = 280;

interface ProviderEventInsertResult {
  inserted: boolean;
  runtimeThreadId: string | null;
}

export interface PersistenceServiceOptions {
  dbPath: string;
  legacyProjectsJsonPath?: string;
}

export interface PersistenceServiceEvents {
  stateEvent: [event: StateEvent];
}

interface UpsertDocumentInput {
  id: string;
  kind: "project" | "thread" | "message" | "turn_summary";
  projectId: string | null;
  threadId: string | null;
  sortKey: number | null;
  createdAt: string;
  updatedAt: string;
  data: unknown;
}

interface SafeParseSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

function nowIso(): string {
  return new Date().toISOString();
}

function toSafeInteger(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return fallback;
}

function projectDocId(projectId: string): string {
  return `project:${projectId}`;
}

function threadDocId(threadId: string): string {
  return `thread:${threadId}`;
}

function turnSummaryDocId(threadId: string, turnId: string): string {
  return `turn_summary:${threadId}:${turnId}`;
}

export class PersistenceService extends EventEmitter<PersistenceServiceEvents> {
  private readonly db: SqliteDatabase;
  private readonly sessionThreadIds = new Map<string, string>();
  private readonly runtimeThreadIds = new Map<string, string>();

  constructor(options: PersistenceServiceOptions) {
    super();
    const config = resolvePersistenceConfig(options);
    this.db = openPersistenceSqliteDatabase(config.dbPath);
    try {
      runPersistenceMigrations(this.db);
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Best effort close on failed initialization.
      }
      throw new PersistenceInitializationError("Failed to initialize persistence database", {
        cause: error,
      });
    }
    if (config.legacyProjectsJsonPath) {
      this.importProjectsJsonIfNeeded(config.legacyProjectsJsonPath);
    }
  }

  close(): void {
    this.db.close();
  }

  getAppSettings(): AppSettings {
    return resolveAppSettings(this.readMetadata(METADATA_KEY_APP_SETTINGS));
  }

  updateAppSettings(raw: AppSettingsUpdateInput): AppSettings {
    const next = buildUpdatedAppSettings(this.getAppSettings(), raw);
    this.writeMetadata(METADATA_KEY_APP_SETTINGS, next);
    return next;
  }

  listProjects(): ProjectListResult {
    const payloads = this.runWithEffectSql(listProjectPayloadsEffect());

    const projects: StateProject[] = [];
    for (const payload of payloads) {
      const parsed = this.parseJson(payload, stateProjectSchema);
      if (parsed) {
        projects.push(parsed);
      }
    }
    return projects;
  }

  addProject(raw: ProjectAddInput): ProjectAddResult {
    const input = projectAddInputSchema.parse(raw);
    const normalizedCwd = normalizeCwd(input.cwd);
    if (!isDirectory(normalizedCwd)) {
      throw new Error(`Project path does not exist: ${normalizedCwd}`);
    }

    const existing = this.findProjectByNormalizedCwd(normalizedCwd);
    if (existing) {
      return { project: existing, created: false };
    }

    const now = nowIso();
    const project = stateProjectSchema.parse({
      id: randomUUID(),
      cwd: normalizedCwd,
      name: inferProjectName(normalizedCwd),
      scripts: [],
      createdAt: now,
      updatedAt: now,
    });

    this.withTransaction((pendingEvents) => {
      this.upsertProjectDocument(project);
      this.appendStateEvent(pendingEvents, "project.upsert", project.id, { project }, project.updatedAt);
    });

    return { project, created: true };
  }

  removeProject(raw: ProjectRemoveInput): void {
    const input = projectRemoveInputSchema.parse(raw);
    const existingProject = this.getProjectById(input.id);
    if (!existingProject) {
      return;
    }

    this.withTransaction((pendingEvents) => {
      const threadPayloads = this.runWithEffectSql(listThreadPayloadsByProjectEffect(input.id));
      const threadIds: string[] = [];
      for (const payload of threadPayloads) {
        const parsed = this.parseJson(payload, stateThreadSchema);
        if (parsed) {
          threadIds.push(parsed.id);
        }
      }

      this.runWithEffectSql(deleteDocumentsByProjectIdEffect(input.id));

      const eventTime = nowIso();
      for (const threadId of threadIds) {
        this.appendStateEvent(pendingEvents, "thread.delete", threadId, { threadId }, eventTime);
      }
      this.appendStateEvent(
        pendingEvents,
        "project.delete",
        input.id,
        { projectId: input.id },
        eventTime,
      );
    });
  }

  updateProjectScripts(raw: ProjectUpdateScriptsInput): ProjectUpdateScriptsResult {
    const input = projectUpdateScriptsInputSchema.parse(raw);
    const existing = this.getProjectById(input.id);
    if (!existing) {
      throw new Error(`Project not found: ${input.id}`);
    }

    const nextScripts = normalizeProjectScripts(projectScriptsSchema.parse(input.scripts));
    const updatedProject = stateProjectSchema.parse({
      ...existing,
      scripts: nextScripts,
      updatedAt: nowIso(),
    });

    this.withTransaction((pendingEvents) => {
      this.upsertProjectDocument(updatedProject);
      this.appendStateEvent(
        pendingEvents,
        "project.upsert",
        updatedProject.id,
        { project: updatedProject },
        updatedProject.updatedAt,
      );
    });

    return {
      project: updatedProject,
    };
  }

  createThread(raw: ThreadsCreateInput): ThreadsUpdateResult {
    const input = threadsCreateInputSchema.parse(raw);
    const project = this.getProjectById(input.projectId);
    if (!project) {
      throw new Error(`Project not found: ${input.projectId}`);
    }

    const now = nowIso();
    const terminalIds = normalizeTerminalIds(input.terminalIds ?? [DEFAULT_TERMINAL_ID]);
    const activeTerminalId = input.activeTerminalId ?? terminalIds[0] ?? DEFAULT_TERMINAL_ID;
    const thread = normalizeThread(
      stateThreadSchema.parse({
        id: randomUUID(),
        codexThreadId: null,
        projectId: project.id,
        title: input.title ?? "New thread",
        model: input.model ?? DEFAULT_MODEL,
        terminalOpen: input.terminalOpen ?? false,
        terminalHeight: input.terminalHeight ?? DEFAULT_TERMINAL_HEIGHT,
        terminalIds,
        activeTerminalId,
        terminalGroups: input.terminalGroups ?? [],
        activeTerminalGroupId:
          input.activeTerminalGroupId ?? fallbackGroupId(activeTerminalId),
        createdAt: now,
        updatedAt: now,
        lastVisitedAt: now,
        branch: input.branch ?? null,
        worktreePath: input.worktreePath ?? null,
      }),
    );

    this.withTransaction((pendingEvents) => {
      this.upsertThreadDocument(thread);
      this.appendStateEvent(pendingEvents, "thread.upsert", thread.id, { thread }, thread.updatedAt);
    });

    return threadsUpdateResultSchema.parse({ thread });
  }

  updateThreadTitle(raw: ThreadsUpdateTitleInput): ThreadsUpdateResult {
    const input = threadsUpdateTitleInputSchema.parse(raw);
    return this.updateThreadWith(input.threadId, (thread) => ({
      ...thread,
      title: input.title,
      updatedAt: nowIso(),
    }));
  }

  updateThreadModel(raw: ThreadsUpdateModelInput): ThreadsUpdateResult {
    const input = threadsUpdateModelInputSchema.parse(raw);
    return this.updateThreadWith(input.threadId, (thread) => ({
      ...thread,
      model: input.model,
      updatedAt: nowIso(),
    }));
  }

  markThreadVisited(raw: ThreadsMarkVisitedInput): ThreadsUpdateResult {
    const input = threadsMarkVisitedInputSchema.parse(raw);
    const visitedAt = input.visitedAt ?? nowIso();
    return this.updateThreadWith(input.threadId, (thread) => ({
      ...thread,
      lastVisitedAt: visitedAt,
      updatedAt: nowIso(),
    }));
  }

  updateThreadBranch(raw: ThreadsUpdateBranchInput): ThreadsUpdateResult {
    const input = threadsUpdateBranchInputSchema.parse(raw);
    return this.updateThreadWith(input.threadId, (thread) => ({
      ...thread,
      branch: input.branch,
      worktreePath: input.worktreePath,
      updatedAt: nowIso(),
    }));
  }

  updateThreadTerminalState(raw: ThreadsUpdateTerminalStateInput): ThreadsUpdateResult {
    const input = threadsUpdateTerminalStateInputSchema.parse(raw);
    return this.updateThreadWith(input.threadId, (thread) =>
      normalizeThread({
        ...thread,
        terminalOpen: input.terminalOpen ?? thread.terminalOpen,
        terminalHeight: input.terminalHeight ?? thread.terminalHeight,
        terminalIds: input.terminalIds ?? thread.terminalIds,
        runningTerminalIds: input.runningTerminalIds ?? thread.runningTerminalIds,
        activeTerminalId: input.activeTerminalId ?? thread.activeTerminalId,
        terminalGroups: input.terminalGroups ?? thread.terminalGroups,
        activeTerminalGroupId: input.activeTerminalGroupId ?? thread.activeTerminalGroupId,
        updatedAt: nowIso(),
      }),
    );
  }

  deleteThread(raw: ThreadsDeleteInput): void {
    const input = threadsDeleteInputSchema.parse(raw);
    const thread = this.getThreadById(input.threadId);
    if (!thread) {
      return;
    }

    this.withTransaction((pendingEvents) => {
      this.runWithEffectSql(deleteDocumentsByThreadIdEffect(thread.id));
      this.runWithEffectSql(deleteDocumentByIdAndKindEffect(threadDocId(thread.id), "thread"));
      this.appendStateEvent(pendingEvents, "thread.delete", thread.id, { threadId: thread.id }, nowIso());
    });
  }

  loadSnapshot(): StateBootstrapResult {
    const projects = this.listProjects();
    const threadPayloads = this.runWithEffectSql(listThreadPayloadsEffect());

    const threads: StateBootstrapThread[] = [];
    for (const payload of threadPayloads) {
      const parsedThread = this.parseJson(payload, stateThreadSchema);
      if (!parsedThread) continue;
      const messages = this.listMessagesForThread(parsedThread.id);
      const turnDiffSummaries = this.listTurnSummariesForThread(parsedThread.id).map((summary) => {
        if (summary.assistantMessageId) {
          return summary;
        }
        const assistantMessageId = this.findAssistantMessageIdForTurn({
          turnId: summary.turnId,
          runtimeThreadId: parsedThread.codexThreadId,
        });
        if (!assistantMessageId) {
          return summary;
        }
        return stateTurnSummarySchema.parse({
          ...summary,
          assistantMessageId,
        });
      });
      threads.push({
        ...parsedThread,
        turnDiffSummaries,
        messages,
      });
    }

    const lastStateSeq = this.readLastStateSeq();
    return buildStateBootstrapResult({
      projects,
      threads,
      lastStateSeq,
    });
  }

  catchUp(raw: StateCatchUpInput): StateCatchUpResult {
    const input = stateCatchUpInputSchema.parse(raw);
    const events = this.runWithEffectSql(listStateEventsAfterSeqEffect(input.afterSeq));

    return buildStateCatchUpResult({
      events,
      lastStateSeq: this.readLastStateSeq(),
    });
  }

  listMessages(raw: StateListMessagesInput): StateListMessagesResult {
    const input = stateListMessagesInputSchema.parse(raw);
    const payloads = this.runWithEffectSql(
      listPaginatedMessagePayloadsForThreadEffect({
        threadId: input.threadId,
        limit: input.limit,
        offset: input.offset,
      }),
    );
    const total = this.runWithEffectSql(countMessagesForThreadEffect(input.threadId));

    const messages: StateMessage[] = [];
    for (const payload of payloads) {
      const parsed = this.parseJson(payload, stateMessageSchema);
      if (parsed) {
        messages.push(parsed);
      }
    }

    return buildStateListMessagesResult({
      messages,
      total,
      offset: input.offset,
      pageSize: payloads.length,
    });
  }

  bindSessionToThread(sessionId: string, threadId: string, runtimeThreadId?: string | null): void {
    if (!sessionId || !threadId) return;
    this.sessionThreadIds.set(sessionId, threadId);
    if (!runtimeThreadId) {
      return;
    }
    this.runtimeThreadIds.set(runtimeThreadId, threadId);
    this.updateThreadWith(threadId, (thread) => ({
      ...thread,
      codexThreadId: runtimeThreadId,
      updatedAt: nowIso(),
    }));
  }

  unbindSession(sessionId: string): void {
    this.sessionThreadIds.delete(sessionId);
  }

  persistUserMessageForTurn(raw: ProviderSendTurnInput): void {
    const input = raw;
    const threadId = this.sessionThreadIds.get(input.sessionId);
    if (!threadId) {
      return;
    }

    const thread = this.getThreadById(threadId);
    if (!thread) {
      return;
    }

    const messageId = input.clientMessageId ?? randomUUID();
    const createdAt = nowIso();
    const message = buildUserTurnMessage({
      turn: input,
      threadId,
      messageId,
      createdAt,
    });

    this.withTransaction((pendingEvents) => {
      this.upsertMessageDocument(thread, message);
      this.appendStateEvent(
        pendingEvents,
        "message.upsert",
        `${thread.id}:${message.id}`,
        { threadId: thread.id, message },
        message.updatedAt,
      );
    });
  }

  ingestProviderEvent(event: ProviderEvent): void {
    this.withTransaction((pendingEvents) => {
      const insertResult = this.insertProviderEvent(event);
      if (!insertResult.inserted) {
        return;
      }

      const localThreadId = this.resolveThreadIdForEvent(event, insertResult.runtimeThreadId);
      if (!localThreadId) {
        return;
      }

      const thread = this.getThreadById(localThreadId);
      if (!thread) {
        return;
      }

      let nextThread = thread;
      const runtimeThreadId = insertResult.runtimeThreadId;
      if (runtimeThreadId && nextThread.codexThreadId !== runtimeThreadId) {
        this.runtimeThreadIds.set(runtimeThreadId, nextThread.id);
        nextThread = {
          ...nextThread,
          codexThreadId: runtimeThreadId,
          updatedAt: event.createdAt,
        };
        this.upsertThreadDocument(nextThread);
        this.appendStateEvent(
          pendingEvents,
          "thread.upsert",
          nextThread.id,
          { thread: nextThread },
          nextThread.updatedAt,
        );
      }

      if (event.method === "turn/started") {
        const turnId = parseTurnIdFromEvent(event);
        nextThread = {
          ...nextThread,
          latestTurnId: turnId ?? nextThread.latestTurnId,
          latestTurnStartedAt: event.createdAt,
          latestTurnCompletedAt: undefined,
          latestTurnDurationMs: undefined,
          updatedAt: event.createdAt,
        };
        this.upsertThreadDocument(nextThread);
        this.appendStateEvent(
          pendingEvents,
          "thread.upsert",
          nextThread.id,
          { thread: nextThread },
          nextThread.updatedAt,
        );
      }

      if (event.method === "item/started") {
        const assistantItemId = parseAssistantItemId(event);
        if (assistantItemId) {
          const existing = this.getMessageById(nextThread.id, assistantItemId);
          const payload = asObject(event.payload);
          const item = asObject(payload?.item);
          const seedText = asString(item?.text) ?? "";
          const text = existing?.text.length ? existing.text : seedText;
          const assistantMessage = stateMessageSchema.parse({
            id: assistantItemId,
            threadId: nextThread.id,
            role: "assistant",
            text,
            createdAt: existing?.createdAt ?? event.createdAt,
            updatedAt: existing?.updatedAt ?? event.createdAt,
            streaming: existing?.streaming ?? true,
          });
          this.upsertMessageDocument(nextThread, assistantMessage);
          this.appendStateEvent(
            pendingEvents,
            "message.upsert",
            `${nextThread.id}:${assistantMessage.id}`,
            { threadId: nextThread.id, message: assistantMessage },
            assistantMessage.updatedAt,
          );
        }
      }

      if (event.method === "item/agentMessage/delta") {
        const payload = asObject(event.payload);
        const messageId = event.itemId ?? asString(payload?.itemId);
        const delta = event.textDelta ?? asString(payload?.delta) ?? "";
        if (messageId && delta.length > 0) {
          const existing = this.getMessageById(nextThread.id, messageId);
          const message = stateMessageSchema.parse({
            id: messageId,
            threadId: nextThread.id,
            role: "assistant",
            text: `${existing?.text ?? ""}${delta}`,
            createdAt: existing?.createdAt ?? event.createdAt,
            updatedAt: event.createdAt,
            streaming: true,
          });
          this.upsertMessageDocument(nextThread, message);
          this.appendStateEvent(
            pendingEvents,
            "message.upsert",
            `${nextThread.id}:${message.id}`,
            { threadId: nextThread.id, message },
            message.updatedAt,
          );
        }
      }

      if (event.method === "item/completed") {
        const payload = asObject(event.payload);
        const item = asObject(payload?.item);
        if (normalizeProviderItemType(asString(item?.type)) === "agentmessage") {
          const messageId = asString(item?.id);
          if (!messageId) {
            return;
          }

          const existing = this.getMessageById(nextThread.id, messageId);
          const fullText = asString(item?.text) ?? existing?.text ?? "";
          const message = stateMessageSchema.parse({
            id: messageId,
            threadId: nextThread.id,
            role: "assistant",
            text: fullText,
            createdAt: existing?.createdAt ?? event.createdAt,
            updatedAt: event.createdAt,
            streaming: false,
          });
          this.upsertMessageDocument(nextThread, message);
          this.appendStateEvent(
            pendingEvents,
            "message.upsert",
            `${nextThread.id}:${message.id}`,
            { threadId: nextThread.id, message },
            message.updatedAt,
          );

          const completedTurnId = parseTurnIdFromEvent(event) ?? nextThread.latestTurnId;
          if (!completedTurnId) {
            return;
          }

          const existingSummary = this.getTurnSummaryByTurnId(nextThread.id, completedTurnId);
          if (!existingSummary || existingSummary.assistantMessageId === messageId) {
            return;
          }

          const summary = this.upsertTurnSummary(
            nextThread,
            completedTurnId,
            {
              completedAt: existingSummary.completedAt,
              assistantMessageId: messageId,
            },
            "merge",
          );
          this.appendStateEvent(
            pendingEvents,
            "turn_summary.upsert",
            `${nextThread.id}:${summary.turnId}`,
            { threadId: nextThread.id, turnSummary: summary },
            summary.completedAt,
          );
        }
      }

      if (event.method === "turn/completed") {
        const completedTurnId = parseTurnIdFromEvent(event) ?? nextThread.latestTurnId;
        const turnStatus = asString(asObject(asObject(event.payload)?.turn)?.status);
        const startedAt =
          completedTurnId && completedTurnId === nextThread.latestTurnId
            ? nextThread.latestTurnStartedAt
            : undefined;
        const durationMs =
          startedAt && !Number.isNaN(Date.parse(startedAt))
            ? Math.max(0, Date.parse(event.createdAt) - Date.parse(startedAt))
            : undefined;

        nextThread = {
          ...nextThread,
          latestTurnId: completedTurnId ?? nextThread.latestTurnId,
          latestTurnCompletedAt: event.createdAt,
          latestTurnDurationMs: durationMs,
          updatedAt: event.createdAt,
        };
        this.upsertThreadDocument(nextThread);
        this.appendStateEvent(
          pendingEvents,
          "thread.upsert",
          nextThread.id,
          { thread: nextThread },
          nextThread.updatedAt,
        );

        if (completedTurnId) {
          const assistantMessageId =
            this.findAssistantMessageIdForTurn({
              sessionId: event.sessionId,
              turnId: completedTurnId,
              runtimeThreadId,
            }) ?? this.findLatestAssistantMessageIdForThread(nextThread.id);
          const summary = this.upsertTurnSummary(
            nextThread,
            completedTurnId,
            {
              completedAt: event.createdAt,
              ...(turnStatus ? { status: turnStatus } : {}),
              ...(assistantMessageId ? { assistantMessageId } : {}),
            },
            "merge",
          );
          this.appendStateEvent(
            pendingEvents,
            "turn_summary.upsert",
            `${nextThread.id}:${summary.turnId}`,
            { threadId: nextThread.id, turnSummary: summary },
            summary.completedAt,
          );
        }

        const messages = this.listMessagesForThread(nextThread.id);
        for (const message of messages) {
          if (!message.streaming) continue;
          const completedMessage = stateMessageSchema.parse({
            ...message,
            streaming: false,
            updatedAt: event.createdAt,
          });
          this.upsertMessageDocument(nextThread, completedMessage);
          this.appendStateEvent(
            pendingEvents,
            "message.upsert",
            `${nextThread.id}:${completedMessage.id}`,
            { threadId: nextThread.id, message: completedMessage },
            completedMessage.updatedAt,
          );
        }
      }

      if (event.method === "turn/diff/updated") {
        const turnId = parseTurnIdFromEvent(event);
        const diff = asString(asObject(event.payload)?.diff);
        if (turnId && diff) {
          const assistantMessageId =
            this.findAssistantMessageIdForTurn({
              sessionId: event.sessionId,
              turnId,
              runtimeThreadId,
            }) ?? this.findLatestAssistantMessageIdForThread(nextThread.id);
          const summary = this.upsertTurnSummary(
            nextThread,
            turnId,
            {
              completedAt: event.createdAt,
              files: summarizeUnifiedDiff(diff),
              ...(assistantMessageId ? { assistantMessageId } : {}),
            },
            "merge",
          );
          this.appendStateEvent(
            pendingEvents,
            "turn_summary.upsert",
            `${nextThread.id}:${summary.turnId}`,
            { threadId: nextThread.id, turnSummary: summary },
            summary.completedAt,
          );
        }
      }
    });
  }

  persistTurnDiffSummaryFromCheckpoint(input: {
    sessionId: string;
    turnId: string | null;
    runtimeThreadId: string;
    checkpointTurnCount: number;
    completedAt: string;
    status?: string;
    diff: string;
  }): void {
    if (!input.turnId) {
      return;
    }
    const turnId = input.turnId;

    const localThreadId =
      this.sessionThreadIds.get(input.sessionId) ??
      this.runtimeThreadIds.get(input.runtimeThreadId) ??
      this.findThreadByRuntimeThreadId(input.runtimeThreadId)?.id;
    if (!localThreadId) {
      return;
    }
    const thread = this.getThreadById(localThreadId);
    if (!thread) {
      return;
    }

    this.withTransaction((pendingEvents) => {
      const assistantMessageId =
        this.findAssistantMessageIdForTurn({
          sessionId: input.sessionId,
          turnId,
          runtimeThreadId: input.runtimeThreadId,
        }) ?? this.findLatestAssistantMessageIdForThread(thread.id);
      const summary = this.upsertTurnSummary(
        thread,
        turnId,
        {
          completedAt: input.completedAt,
          ...(input.status ? { status: input.status } : {}),
          checkpointTurnCount: input.checkpointTurnCount,
          files: summarizeUnifiedDiff(input.diff),
          ...(assistantMessageId ? { assistantMessageId } : {}),
        },
        "replace",
      );
      this.appendStateEvent(
        pendingEvents,
        "turn_summary.upsert",
        `${thread.id}:${summary.turnId}`,
        { threadId: thread.id, turnSummary: summary },
        summary.completedAt,
      );
    });
  }

  applyCheckpointRevert(input: {
    sessionId: string;
    runtimeThreadId: string;
    turnCount: number;
    messageCount: number;
  }): void {
    const threadId =
      this.sessionThreadIds.get(input.sessionId) ??
      this.runtimeThreadIds.get(input.runtimeThreadId) ??
      this.findThreadByRuntimeThreadId(input.runtimeThreadId)?.id;
    if (!threadId) {
      return;
    }
    const thread = this.getThreadById(threadId);
    if (!thread) {
      return;
    }

    this.withTransaction((pendingEvents) => {
      const messages = this.listMessagesForThread(thread.id);
      if (messages.length > input.messageCount) {
        for (let index = input.messageCount; index < messages.length; index += 1) {
          const message = messages[index];
          if (!message) continue;
          this.runWithEffectSql(
            deleteDocumentByIdAndKindEffect(messageDocId(thread.id, message.id), "message"),
          );
          this.appendStateEvent(
            pendingEvents,
            "message.delete",
            `${thread.id}:${message.id}`,
            { threadId: thread.id, messageId: message.id },
            nowIso(),
          );
        }
      }

      const summaries = this.listTurnSummariesForThread(thread.id);
      for (const summary of summaries) {
        if (
          typeof summary.checkpointTurnCount === "number" &&
          summary.checkpointTurnCount > input.turnCount
        ) {
          this.runWithEffectSql(
            deleteDocumentByIdAndKindEffect(turnSummaryDocId(thread.id, summary.turnId), "turn_summary"),
          );
          this.appendStateEvent(
            pendingEvents,
            "turn_summary.delete",
            `${thread.id}:${summary.turnId}`,
            { threadId: thread.id, turnId: summary.turnId },
            nowIso(),
          );
        }
      }

      const revertedThread = stateThreadSchema.parse({
        ...thread,
        codexThreadId: input.runtimeThreadId,
        latestTurnId: undefined,
        latestTurnStartedAt: undefined,
        latestTurnCompletedAt: undefined,
        latestTurnDurationMs: undefined,
        updatedAt: nowIso(),
        lastVisitedAt: nowIso(),
      });
      this.upsertThreadDocument(revertedThread);
      this.appendStateEvent(
        pendingEvents,
        "thread.upsert",
        revertedThread.id,
        { thread: revertedThread },
        revertedThread.updatedAt,
      );
    });
  }

  private updateThreadWith(
    threadId: string,
    updater: (thread: StateThread) => StateThread,
  ): ThreadsUpdateResult {
    const existing = this.getThreadById(threadId);
    if (!existing) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    const nextThread = normalizeThread(stateThreadSchema.parse(updater(existing)));
    this.withTransaction((pendingEvents) => {
      this.upsertThreadDocument(nextThread);
      this.appendStateEvent(
        pendingEvents,
        "thread.upsert",
        nextThread.id,
        { thread: nextThread },
        nextThread.updatedAt,
      );
    });

    return threadsUpdateResultSchema.parse({ thread: nextThread });
  }

  private importProjectsJsonIfNeeded(projectsJsonPath: string): void {
    const importedAlready = this.readMetadataBoolean(METADATA_KEY_PROJECTS_JSON_IMPORTED);
    if (importedAlready) {
      return;
    }

    const normalizedPath = path.resolve(projectsJsonPath);
    const exists = fs.existsSync(normalizedPath);
    if (!exists) {
      this.writeMetadata(METADATA_KEY_PROJECTS_JSON_IMPORTED, { importedAt: nowIso(), source: null });
      return;
    }

    let importedCount = 0;
    this.runDbTransaction(() => {
      try {
        const raw = fs.readFileSync(normalizedPath, "utf8");
        const payload = JSON.parse(raw) as { projects?: unknown };
        const candidates = Array.isArray(payload.projects) ? payload.projects : [];
        for (const candidate of candidates) {
          const parsed = projectRecordSchema.safeParse(candidate);
          if (!parsed.success) continue;
          const project = parsed.data;
          const normalizedCwd = normalizeCwd(project.cwd);
          if (!isDirectory(normalizedCwd)) continue;

          const existing = this.findProjectByNormalizedCwd(normalizedCwd);
          const nextProject = stateProjectSchema.parse({
            id: existing?.id ?? project.id,
            cwd: normalizedCwd,
            name: project.name.trim().length > 0 ? project.name.trim() : inferProjectName(normalizedCwd),
            scripts: normalizeProjectScripts(project.scripts),
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          });
          this.upsertProjectDocument(nextProject);
          importedCount += 1;
        }
      } catch {
        // Ignore malformed legacy file.
      }

      this.writeMetadata(
        METADATA_KEY_PROJECTS_JSON_IMPORTED,
        { importedAt: nowIso(), source: normalizedPath, importedCount },
        true,
      );
    });

    try {
      const backupPath = `${normalizedPath}.bak.${Date.now()}`;
      fs.renameSync(normalizedPath, backupPath);
    } catch {
      // Best-effort backup move.
    }
  }

  private readLastStateSeq(): number {
    return this.runWithEffectSql(readLastStateSeqEffect);
  }

  private runDbTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Preserve the original transactional failure.
      }
      throw error;
    }
  }

  private withTransaction<T>(fn: (pendingEvents: StateEvent[]) => T): T {
    const pendingEvents: StateEvent[] = [];
    const result = this.runDbTransaction(() => fn(pendingEvents));
    for (const event of pendingEvents) {
      try {
        this.emit("stateEvent", event);
      } catch {
        // Listener failures should not break already-committed writes.
      }
    }
    return result;
  }

  private appendStateEvent(
    pendingEvents: StateEvent[],
    eventType: StateEvent["eventType"],
    entityId: string,
    payload: StateEvent["payload"],
    createdAt: string,
  ): void {
    const nextEvent = this.runWithEffectSql(
      appendStateEventEffect({
        eventType,
        entityId,
        payload,
        createdAt,
      }),
    );
    pendingEvents.push(nextEvent);
  }

  private upsertProjectDocument(project: StateProject): void {
    this.upsertDocument({
      id: projectDocId(project.id),
      kind: "project",
      projectId: project.id,
      threadId: null,
      sortKey: null,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      data: project,
    });
  }

  private upsertThreadDocument(thread: StateThread): void {
    this.upsertDocument({
      id: threadDocId(thread.id),
      kind: "thread",
      projectId: thread.projectId,
      threadId: thread.id,
      sortKey: null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      data: {
        ...thread,
        // Turn summaries are stored in dedicated documents to keep thread rows small.
        turnDiffSummaries: [],
      },
    });
  }

  private upsertMessageDocument(thread: StateThread, message: StateMessage): void {
    const existingRow = this.getDocumentRowById(messageDocId(thread.id, message.id));
    const sortKey =
      existingRow?.sort_key ??
      this.readNextSortKey("message", thread.id);
    this.upsertDocument({
      id: messageDocId(thread.id, message.id),
      kind: "message",
      projectId: thread.projectId,
      threadId: thread.id,
      sortKey,
      createdAt: existingRow?.created_at ?? message.createdAt,
      updatedAt: message.updatedAt,
      data: message,
    });
  }

  private upsertTurnSummaryDocument(thread: StateThread, summary: StateTurnSummary): void {
    this.upsertDocument({
      id: turnSummaryDocId(thread.id, summary.turnId),
      kind: "turn_summary",
      projectId: thread.projectId,
      threadId: thread.id,
      sortKey:
        summary.checkpointTurnCount ??
        toSafeInteger(Date.parse(summary.completedAt), 0),
      createdAt: summary.completedAt,
      updatedAt: summary.completedAt,
      data: summary,
    });
  }

  private upsertTurnSummary(
    thread: StateThread,
    turnId: string,
    patch: {
      completedAt: string;
      status?: string;
      assistantMessageId?: string;
      checkpointTurnCount?: number;
      files?: StateTurnDiffFileChange[];
    },
    mode: "merge" | "replace",
  ): StateTurnSummary {
    const existing = this.getTurnSummaryByTurnId(thread.id, turnId);
    const nextSummary = stateTurnSummarySchema.parse({
      turnId,
      completedAt: patch.completedAt || existing?.completedAt || nowIso(),
      ...(patch.status ?? existing?.status ? { status: patch.status ?? existing?.status } : {}),
      ...(patch.assistantMessageId ?? existing?.assistantMessageId
        ? { assistantMessageId: patch.assistantMessageId ?? existing?.assistantMessageId }
        : {}),
      ...(patch.checkpointTurnCount !== undefined || existing?.checkpointTurnCount !== undefined
        ? { checkpointTurnCount: patch.checkpointTurnCount ?? existing?.checkpointTurnCount }
        : {}),
      files:
        patch.files === undefined
          ? (existing?.files ?? [])
          : mode === "replace"
            ? patch.files
            : mergeTurnSummaryFiles(existing?.files ?? [], patch.files),
    });
    this.upsertTurnSummaryDocument(thread, nextSummary);
    return nextSummary;
  }

  private findProjectByNormalizedCwd(normalizedCwd: string): StateProject | null {
    const projects = this.listProjects();
    for (const project of projects) {
      if (normalizeCwd(project.cwd) === normalizedCwd) {
        return project;
      }
    }
    return null;
  }

  private getProjectById(projectId: string): StateProject | null {
    const row = this.getDocumentRowById(projectDocId(projectId));
    if (!row) return null;
    return this.parseJson(row.data_json, stateProjectSchema);
  }

  private getThreadById(threadId: string): StateThread | null {
    const row = this.getDocumentRowById(threadDocId(threadId));
    if (!row) return null;
    const parsed = this.parseJson(row.data_json, stateThreadSchema);
    return parsed ? normalizeThread(parsed) : null;
  }

  private findThreadByRuntimeThreadId(runtimeThreadId: string): StateThread | null {
    const payload = this.runWithEffectSql(findThreadPayloadByRuntimeThreadIdEffect(runtimeThreadId));
    if (!payload) return null;
    const parsed = this.parseJson(payload, stateThreadSchema);
    return parsed ? normalizeThread(parsed) : null;
  }

  private getMessageById(threadId: string, messageId: string): StateMessage | null {
    const row = this.getDocumentRowById(messageDocId(threadId, messageId));
    if (!row) return null;
    return this.parseJson(row.data_json, stateMessageSchema);
  }

  private getTurnSummaryByTurnId(threadId: string, turnId: string): StateTurnSummary | null {
    const row = this.getDocumentRowById(turnSummaryDocId(threadId, turnId));
    if (!row) return null;
    return this.parseJson(row.data_json, stateTurnSummarySchema);
  }

  private findAssistantMessageIdForTurn(input: {
    turnId: string;
    sessionId?: string;
    runtimeThreadId?: string | null;
  }): string | undefined {
    const rowGroups: CompletedProviderItemRow[][] = [];
    if (input.sessionId) {
      rowGroups.push(
        this.runWithEffectSql(
          listCompletedItemEventsBySessionTurnEffect({
            sessionId: input.sessionId,
            turnId: input.turnId,
          }),
        ),
      );
    }
    if (input.runtimeThreadId) {
      rowGroups.push(
        this.runWithEffectSql(
          listCompletedItemEventsByThreadTurnEffect({
            runtimeThreadId: input.runtimeThreadId,
            turnId: input.turnId,
          }),
        ),
      );
    }
    rowGroups.push(
      this.runWithEffectSql(listCompletedItemEventsByTurnEffect(input.turnId)),
    );

    for (const rows of rowGroups) {
      for (const row of rows) {
        const payload = row.payload_json ? this.tryParseJson(row.payload_json) : null;
        const item = asObject(asObject(payload)?.item);
        const itemType = normalizeProviderItemType(asString(item?.type));
        if (itemType !== "agentmessage") {
          continue;
        }
        const messageId = asString(item?.id) ?? (row.item_id ?? undefined);
        if (messageId) {
          return messageId;
        }
      }
    }

    return undefined;
  }

  private findLatestAssistantMessageIdForThread(threadId: string): string | undefined {
    const payloads = this.runWithEffectSql(listMessagePayloadsForThreadDescEffect(threadId));

    for (const payload of payloads) {
      const message = this.parseJson(payload, stateMessageSchema);
      if (!message) {
        continue;
      }
      if (message.role === "assistant") {
        return message.id;
      }
    }

    return undefined;
  }

  private listMessagesForThread(threadId: string): StateMessage[] {
    const payloads = this.runWithEffectSql(listMessagePayloadsForThreadEffect(threadId));
    const messages: StateMessage[] = [];
    for (const payload of payloads) {
      const parsed = this.parseJson(payload, stateMessageSchema);
      if (parsed) {
        messages.push(parsed);
      }
    }
    return messages;
  }

  private listTurnSummariesForThread(threadId: string): StateTurnSummary[] {
    const payloads = this.runWithEffectSql(listTurnSummaryPayloadsForThreadEffect(threadId));
    const summaries: StateTurnSummary[] = [];
    for (const payload of payloads) {
      const parsed = this.parseJson(payload, stateTurnSummarySchema);
      if (parsed) {
        summaries.push(parsed);
      }
    }
    return summaries;
  }

  private upsertDocument(input: UpsertDocumentInput): void {
    this.runWithEffectSql(
      upsertDocumentEffect({
        id: input.id,
        kind: input.kind,
        projectId: input.projectId,
        threadId: input.threadId,
        sortKey: input.sortKey,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        dataJson: JSON.stringify(input.data),
      }),
    );
  }

  private getDocumentRowById(id: string): DocumentRow | null {
    return this.runWithEffectSql(getDocumentRowByIdEffect(id));
  }

  private readNextSortKey(kind: "message" | "turn_summary", threadId: string): number {
    return this.runWithEffectSql(readNextSortKeyEffect(kind, threadId));
  }

  private resolveThreadIdForEvent(event: ProviderEvent, runtimeThreadId: string | null): string | null {
    const bySession = this.sessionThreadIds.get(event.sessionId);
    if (bySession) {
      if (runtimeThreadId) {
        this.runtimeThreadIds.set(runtimeThreadId, bySession);
      }
      return bySession;
    }

    if (runtimeThreadId) {
      const fromRuntimeMap = this.runtimeThreadIds.get(runtimeThreadId);
      if (fromRuntimeMap) {
        this.sessionThreadIds.set(event.sessionId, fromRuntimeMap);
        return fromRuntimeMap;
      }
      const fromThreadDoc = this.findThreadByRuntimeThreadId(runtimeThreadId);
      if (fromThreadDoc) {
        this.runtimeThreadIds.set(runtimeThreadId, fromThreadDoc.id);
        this.sessionThreadIds.set(event.sessionId, fromThreadDoc.id);
        return fromThreadDoc.id;
      }
    }

    return null;
  }

  private insertProviderEvent(event: ProviderEvent): ProviderEventInsertResult {
    const runtimeThreadId = event.threadId ?? parseThreadIdFromEventPayload(event.payload);
    const payloadJson = event.payload === undefined ? null : JSON.stringify(event.payload);
    const changes = this.runWithEffectSql(
      insertProviderEventEffect({
        id: event.id,
        sessionId: event.sessionId,
        provider: event.provider,
        kind: event.kind,
        method: event.method,
        runtimeThreadId: runtimeThreadId ?? null,
        turnId: event.turnId ?? null,
        itemId: event.itemId ?? null,
        requestId: event.requestId ?? null,
        requestKind: event.requestKind ?? null,
        textDelta: event.textDelta ?? null,
        message: event.message ?? null,
        payloadJson,
        createdAt: event.createdAt,
      }),
    );
    return {
      inserted: changes > 0,
      runtimeThreadId: runtimeThreadId ?? null,
    };
  }

  private parseJson<T>(json: string, schema: SafeParseSchema<T>): T | null {
    const candidate = this.tryParseJson(json);
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      return null;
    }
    return parsed.data;
  }

  private tryParseJson(json: string): unknown {
    try {
      return JSON.parse(json) as unknown;
    } catch {
      return null;
    }
  }

  private readMetadataBoolean(key: string): boolean {
    const value = this.readMetadata(key);
    if (value === null || value === undefined) {
      return false;
    }
    if (typeof value === "boolean") {
      return value;
    }
    const record = asObject(value);
    if (!record) {
      return true;
    }
    const explicit = record.value;
    if (typeof explicit === "boolean") {
      return explicit;
    }
    return true;
  }

  private readMetadata(key: string): unknown {
    return this.runWithEffectSql(readMetadataValueEffect(key));
  }

  private writeMetadata(key: string, value: unknown, inTransaction = false): void {
    const write = () => {
      this.runWithEffectSql(writeMetadataValueEffect(key, value));
    };
    if (inTransaction) {
      write();
      return;
    }
    this.runDbTransaction(write);
  }

  private runWithEffectSql<A>(
    effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
  ): A {
    return runWithSqlClient(this.db, effect);
  }
}
