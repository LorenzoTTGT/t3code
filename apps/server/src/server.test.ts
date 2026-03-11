import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import type { ServerConfigShape } from "./config.ts";
import { ServerConfig } from "./config.ts";
import { makeRoutesLayer } from "./server.ts";
import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";

const AppUnderTest = HttpRouter.serve(makeRoutesLayer, {
  disableListenLog: true,
  disableLogger: true,
});

const buildWithTestConfig = (overrides?: { staticDir?: string; devUrl?: URL }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-test-" });
    const testServerConfig: ServerConfigShape = {
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
      stateDir,
      staticDir: overrides?.staticDir,
      devUrl: overrides?.devUrl,
      noBrowser: true,
      authToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
    };

    yield* Layer.build(AppUnderTest).pipe(Effect.provideService(ServerConfig, testServerConfig));
    return stateDir;
  });

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("routes GET /health through HttpRouter", () =>
    Effect.gen(function* () {
      yield* buildWithTestConfig();

      const response = yield* HttpClient.get("/health");
      assert.equal(response.status, 200);
      assert.deepEqual(yield* response.json, { ok: true });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves static index content for GET / when staticDir is configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-static-" });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>router-static-ok</html>");

      yield* buildWithTestConfig({ staticDir });

      const response = yield* HttpClient.get("/");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "router-static-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("redirects to dev URL when configured", () =>
    Effect.gen(function* () {
      yield* buildWithTestConfig({
        devUrl: new URL("http://127.0.0.1:5173"),
      });

      const server = yield* HttpServer.HttpServer;
      const address = server.address as HttpServer.TcpAddress;
      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${address.port}/foo/bar`, {
          redirect: "manual",
        }),
      );
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "http://127.0.0.1:5173/");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files from state dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-11111111-1111-4111-8111-111111111111";

      const stateDir = yield* buildWithTestConfig();
      const attachmentPath = resolveAttachmentRelativePath({
        stateDir,
        relativePath: `${attachmentId}.bin`,
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-ok");

      const response = yield* HttpClient.get(`/attachments/${attachmentId}`);
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "attachment-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns 404 for missing attachment id lookups", () =>
    Effect.gen(function* () {
      yield* buildWithTestConfig();

      const response = yield* HttpClient.get(
        "/attachments/missing-11111111-1111-4111-8111-111111111111",
      );
      assert.equal(response.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
