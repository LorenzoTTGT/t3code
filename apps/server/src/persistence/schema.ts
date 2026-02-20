import * as Schema from "effect/Schema";

export const DocumentRowSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  project_id: Schema.NullOr(Schema.String),
  thread_id: Schema.NullOr(Schema.String),
  sort_key: Schema.NullOr(Schema.Number),
  created_at: Schema.String,
  updated_at: Schema.String,
  data_json: Schema.String,
});

export const ProviderEventInsertStatsSchema = Schema.Struct({
  changes: Schema.NullOr(Schema.Number),
});

export const StateEventRowSchema = Schema.Struct({
  seq: Schema.Number,
  event_type: Schema.String,
  entity_id: Schema.String,
  payload_json: Schema.String,
  created_at: Schema.String,
});

export const MetadataRowSchema = Schema.Struct({
  value_json: Schema.String,
});
