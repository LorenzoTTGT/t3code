import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface DocumentRow {
  id: string;
  kind: string;
  project_id: string | null;
  thread_id: string | null;
  sort_key: number | null;
  created_at: string;
  updated_at: string;
  data_json: string;
}

interface DataJsonRow {
  data_json: string;
}

export interface PaginatedMessagePayloadsRow {
  data_json: string;
}

export interface TotalCountRow {
  total?: number | bigint;
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

export const getDocumentRowById = (
  id: string,
): Effect.Effect<DocumentRow | null, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<DocumentRow>(
        "SELECT id, kind, project_id, thread_id, sort_key, created_at, updated_at, data_json FROM documents WHERE id = ? LIMIT 1;",
        [id],
      )
      .unprepared) as DocumentRow[];
    return rows[0] ?? null;
  });

export const upsertDocument = (input: {
  id: string;
  kind: "project" | "thread" | "message" | "turn_summary";
  projectId: string | null;
  threadId: string | null;
  sortKey: number | null;
  createdAt: string;
  updatedAt: string;
  dataJson: string;
}): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql
      .unsafe(
        `INSERT INTO documents (
          id,
          kind,
          project_id,
          thread_id,
          sort_key,
          schema_version,
          created_at,
          updated_at,
          data_json
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          project_id = excluded.project_id,
          thread_id = excluded.thread_id,
          sort_key = excluded.sort_key,
          schema_version = excluded.schema_version,
          updated_at = excluded.updated_at,
          data_json = excluded.data_json;`,
        [
          input.id,
          input.kind,
          input.projectId,
          input.threadId,
          input.sortKey,
          input.createdAt,
          input.updatedAt,
          input.dataJson,
        ],
      )
      .raw;
  }).pipe(Effect.asVoid);

export const readNextSortKey = (
  kind: "message" | "turn_summary",
  threadId: string,
): Effect.Effect<number, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<{ next_sort_key?: number }>(
        "SELECT COALESCE(MAX(sort_key), 0) + 1 AS next_sort_key FROM documents WHERE kind = ? AND thread_id = ?;",
        [kind, threadId],
      )
      .unprepared) as Array<{ next_sort_key?: number }>;
    return rows[0]?.next_sort_key ?? 1;
  });

export const listProjectPayloads = (): Effect.Effect<string[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<DataJsonRow>(
        "SELECT data_json FROM documents WHERE kind = 'project' ORDER BY updated_at DESC, created_at DESC;",
      )
      .unprepared) as DataJsonRow[];
    return rows.map((row) => row.data_json);
  });

export const listThreadPayloads = (): Effect.Effect<string[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<DataJsonRow>(
        "SELECT data_json FROM documents WHERE kind = 'thread' ORDER BY updated_at DESC, created_at DESC;",
      )
      .unprepared) as DataJsonRow[];
    return rows.map((row) => row.data_json);
  });

export const listThreadPayloadsByProject = (
  projectId: string,
): Effect.Effect<string[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<DataJsonRow>("SELECT data_json FROM documents WHERE kind = 'thread' AND project_id = ?;", [
        projectId,
      ])
      .unprepared) as DataJsonRow[];
    return rows.map((row) => row.data_json);
  });

export const findThreadPayloadByRuntimeThreadId = (
  runtimeThreadId: string,
): Effect.Effect<string | null, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<DataJsonRow>(
        "SELECT data_json FROM documents WHERE kind = 'thread' AND json_extract(data_json, '$.codexThreadId') = ? LIMIT 1;",
        [runtimeThreadId],
      )
      .unprepared) as DataJsonRow[];
    return rows[0]?.data_json ?? null;
  });

export const deleteDocumentsByProjectId = (
  projectId: string,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("DELETE FROM documents WHERE project_id = ?;", [projectId]).raw;
  }).pipe(Effect.asVoid);

export const deleteDocumentsByThreadId = (
  threadId: string,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("DELETE FROM documents WHERE thread_id = ?;", [threadId]).raw;
  }).pipe(Effect.asVoid);

export const deleteDocumentByIdAndKind = (
  id: string,
  kind: "thread" | "message" | "turn_summary",
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("DELETE FROM documents WHERE id = ? AND kind = ?;", [id, kind]).raw;
  }).pipe(Effect.asVoid);

export const listMessagePayloadsForThread = (
  threadId: string,
): Effect.Effect<string[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<{ data_json: string }>(
        "SELECT data_json FROM documents WHERE kind = 'message' AND thread_id = ? ORDER BY sort_key ASC;",
        [threadId],
      )
      .unprepared) as Array<{ data_json: string }>;
    return rows.map((row) => row.data_json);
  });

export const listPaginatedMessagePayloadsForThread = (input: {
  threadId: string;
  limit: number;
  offset: number;
}): Effect.Effect<string[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<PaginatedMessagePayloadsRow>(
        "SELECT data_json FROM documents WHERE kind = 'message' AND thread_id = ? ORDER BY sort_key ASC LIMIT ? OFFSET ?;",
        [input.threadId, input.limit, input.offset],
      )
      .unprepared) as PaginatedMessagePayloadsRow[];
    return rows.map((row) => row.data_json);
  });

export const countMessagesForThread = (
  threadId: string,
): Effect.Effect<number, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<TotalCountRow>("SELECT COUNT(1) AS total FROM documents WHERE kind = 'message' AND thread_id = ?;", [
        threadId,
      ])
      .unprepared) as TotalCountRow[];
    return toSafeInteger(rows[0]?.total, 0);
  });

export const listMessagePayloadsForThreadDesc = (
  threadId: string,
): Effect.Effect<string[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<{ data_json: string }>(
        `SELECT data_json
         FROM documents
         WHERE kind = 'message' AND thread_id = ?
         ORDER BY sort_key DESC, updated_at DESC;`,
        [threadId],
      )
      .unprepared) as Array<{ data_json: string }>;
    return rows.map((row) => row.data_json);
  });

export const listTurnSummaryPayloadsForThread = (
  threadId: string,
): Effect.Effect<string[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<{ data_json: string }>(
        "SELECT data_json FROM documents WHERE kind = 'turn_summary' AND thread_id = ? ORDER BY sort_key DESC, updated_at DESC;",
        [threadId],
      )
      .unprepared) as Array<{ data_json: string }>;
    return rows.map((row) => row.data_json);
  });
