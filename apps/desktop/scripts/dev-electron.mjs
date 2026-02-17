import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

const port = Number(process.env.ELECTRON_RENDERER_PORT ?? 5173);
const STARTUP_TIMEOUT_MS = Number(process.env.T3CODE_ELECTRON_STARTUP_TIMEOUT_MS ?? 120_000);

async function canConnect(host, probePort, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(probePort, host);
  });
}

function waitForDesktopBundles(timeoutMs) {
  const FRESHNESS_GRACE_MS = 10_000;
  const startedAt = Date.now();
  const bundleFiles = [
    { path: "dist-electron/main.mjs", requireFresh: true },
    { path: "dist-electron/preload.cjs", requireFresh: true },
    { path: "../server/dist/index.mjs", requireFresh: false },
  ];

  return new Promise((resolve, reject) => {
    const tick = () => {
      const missing = [];
      const stale = [];

      for (const bundleFile of bundleFiles) {
        if (!fs.existsSync(bundleFile.path)) {
          missing.push(bundleFile.path);
          continue;
        }
        if (!bundleFile.requireFresh) {
          continue;
        }
        try {
          const stat = fs.statSync(bundleFile.path);
          if (stat.mtimeMs < startedAt - FRESHNESS_GRACE_MS) {
            stale.push(bundleFile.path);
          }
        } catch {
          missing.push(bundleFile.path);
        }
      }

      if (missing.length === 0 && stale.length === 0) {
        resolve();
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        const parts = [];
        if (missing.length > 0) {
          parts.push(`missing: ${missing.join(", ")}`);
        }
        if (stale.length > 0) {
          parts.push(`stale: ${stale.join(", ")}`);
        }
        reject(
          new Error(
            `[dev-electron] timed out after ${timeoutMs}ms waiting for bundles (${parts.join("; ")})`,
          ),
        );
        return;
      }

      setTimeout(tick, 250);
    };

    tick();
  });
}

function waitForDevServer(probePort, timeoutMs) {
  const startedAt = Date.now();
  const candidates = [
    { host: "127.0.0.1", url: `http://127.0.0.1:${probePort}` },
    { host: "::1", url: `http://[::1]:${probePort}` },
    { host: "localhost", url: `http://localhost:${probePort}` },
  ];

  return new Promise((resolve, reject) => {
    const tick = () => {
      void Promise.all(
        candidates.map(async (candidate) => ({
          candidate,
          connected: await canConnect(candidate.host, probePort),
        })),
      )
        .then((results) => {
          const ready = results.find((entry) => entry.connected);
          if (ready) {
            resolve(ready.candidate.url);
            return;
          }

          if (Date.now() - startedAt >= timeoutMs) {
            reject(
              new Error(
                `[dev-electron] timed out after ${timeoutMs}ms waiting for renderer dev server on port ${probePort}`,
              ),
            );
            return;
          }

          setTimeout(tick, 250);
        })
        .catch((error) => {
          reject(error);
        });
    };

    tick();
  });
}

console.log("[dev-electron] waiting for desktop/server bundles");
await waitForDesktopBundles(STARTUP_TIMEOUT_MS);

console.log(`[dev-electron] waiting for renderer dev server on port ${port}`);
const devServerUrl = await waitForDevServer(port, STARTUP_TIMEOUT_MS);
console.log(`[dev-electron] launching electron with renderer url ${devServerUrl}`);

const command = process.platform === "win32" ? "electronmon.cmd" : "electronmon";
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

if (process.platform === "linux" && !childEnv.ELECTRON_DISABLE_SANDBOX) {
  childEnv.ELECTRON_DISABLE_SANDBOX = "1";
  console.log("[dev-electron] enabling ELECTRON_DISABLE_SANDBOX=1 on Linux");
}

const child = spawn(command, ["dist-electron/main.mjs"], {
  stdio: "inherit",
  env: {
    ...childEnv,
    VITE_DEV_SERVER_URL: devServerUrl,
  },
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error("[dev-electron] failed to launch electronmon:", error.message);
  process.exit(1);
});
