import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { runPersistenceMigrations } from "../migrator";
import { runWithSqlClient } from "../runtime";
import { openPersistenceSqliteDatabase } from "../sqliteLayer";
import { appendStateEvent, listStateEventsAfterSeq, readLastStateSeq } from "./stateEventsRepo";

describe("stateEventsRepo", () => {
  test("appends and lists ordered state events", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-persistence-state-events-repo-"));
    const dbPath = path.join(dir, "state.sqlite");
    try {
      const db = openPersistenceSqliteDatabase(dbPath);
      try {
        runPersistenceMigrations(db);
        const createdAt = new Date().toISOString();
        const first = runWithSqlClient(
          db,
          appendStateEvent({
            eventType: "project.upsert",
            entityId: "project-1",
            payload: {
              project: {
                id: "project-1",
                name: "Project One",
                cwd: "/tmp/project-one",
                scripts: [],
                createdAt,
                updatedAt: createdAt,
              },
            },
            createdAt,
          }),
        );
        const second = runWithSqlClient(
          db,
          appendStateEvent({
            eventType: "project.delete",
            entityId: "project-1",
            payload: { projectId: "project-1" },
            createdAt,
          }),
        );

        const lastSeq = runWithSqlClient(db, readLastStateSeq);
        const events = runWithSqlClient(db, listStateEventsAfterSeq(first.seq - 1));

        expect(first.seq).toBeGreaterThan(0);
        expect(second.seq).toBeGreaterThan(first.seq);
        expect(lastSeq).toBe(second.seq);
        expect(events.map((event) => event.eventType)).toEqual(["project.upsert", "project.delete"]);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
