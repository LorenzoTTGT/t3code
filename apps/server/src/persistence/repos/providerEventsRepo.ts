import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

function toSafeInteger(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return fallback;
}

export interface CompletedProviderItemRow {
  item_id: string | null;
  payload_json: string | null;
}

export const insertProviderEvent = (input: {
  id: string;
  sessionId: string;
  provider: string;
  kind: string;
  method: string;
  runtimeThreadId: string | null;
  turnId: string | null;
  itemId: string | null;
  requestId: string | null;
  requestKind: string | null;
  textDelta: string | null;
  message: string | null;
  payloadJson: string | null;
  createdAt: string;
}): Effect.Effect<number, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rawResult = (yield* sql
      .unsafe<{ changes?: number | bigint }>(
        `INSERT OR IGNORE INTO provider_events (
          id,
          session_id,
          provider,
          kind,
          method,
          thread_id,
          turn_id,
          item_id,
          request_id,
          request_kind,
          text_delta,
          message,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          input.id,
          input.sessionId,
          input.provider,
          input.kind,
          input.method,
          input.runtimeThreadId,
          input.turnId,
          input.itemId,
          input.requestId,
          input.requestKind,
          input.textDelta,
          input.message,
          input.payloadJson,
          input.createdAt,
        ],
      )
      .raw) as { changes?: number | bigint };
    return toSafeInteger(rawResult.changes, 0);
  });

export const listCompletedItemEventsBySessionTurn = (input: {
  sessionId: string;
  turnId: string;
}): Effect.Effect<CompletedProviderItemRow[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql
      .unsafe<CompletedProviderItemRow>(
        `SELECT item_id, payload_json
         FROM provider_events
         WHERE session_id = ? AND turn_id = ? AND method = 'item/completed'
         ORDER BY created_at DESC;`,
        [input.sessionId, input.turnId],
      )
      .unprepared) as CompletedProviderItemRow[];
  });

export const listCompletedItemEventsByThreadTurn = (input: {
  runtimeThreadId: string;
  turnId: string;
}): Effect.Effect<CompletedProviderItemRow[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql
      .unsafe<CompletedProviderItemRow>(
        `SELECT item_id, payload_json
         FROM provider_events
         WHERE thread_id = ? AND turn_id = ? AND method = 'item/completed'
         ORDER BY created_at DESC;`,
        [input.runtimeThreadId, input.turnId],
      )
      .unprepared) as CompletedProviderItemRow[];
  });

export const listCompletedItemEventsByTurn = (
  turnId: string,
): Effect.Effect<CompletedProviderItemRow[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql
      .unsafe<CompletedProviderItemRow>(
        `SELECT item_id, payload_json
         FROM provider_events
         WHERE turn_id = ? AND method = 'item/completed'
         ORDER BY created_at DESC;`,
        [turnId],
      )
      .unprepared) as CompletedProviderItemRow[];
  });
