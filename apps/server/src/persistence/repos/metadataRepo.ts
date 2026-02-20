import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export const readMetadataValue = (
  key: string,
): Effect.Effect<unknown | null, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const rows = (yield* sql
      .unsafe<{ value_json: string }>("SELECT value_json FROM metadata WHERE key = ? LIMIT 1;", [key])
      .unprepared) as Array<{ value_json: string }>;
    const row = rows[0];
    if (!row) {
      return null;
    }
    return tryParseJson(row.value_json);
  });

export const writeMetadataValue = (
  key: string,
  value: unknown,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql
      .unsafe(
        "INSERT INTO metadata (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json;",
        [key, JSON.stringify(value)],
      )
      .raw;
  }).pipe(Effect.asVoid);
