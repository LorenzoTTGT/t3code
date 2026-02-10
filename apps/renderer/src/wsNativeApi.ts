import type {
  AgentExit,
  NativeApi,
  OutputChunk,
  ProviderEvent,
  WsClientMessage,
  WsEventMessage,
  WsResponseMessage,
} from "@acme/contracts";
import {
  WS_CLOSE_CODES,
  WS_CLOSE_REASONS,
  WS_EVENT_CHANNELS,
  agentSessionIdSchema,
  appBootstrapResultSchema,
  appHealthResultSchema,
  providerSessionListSchema,
  providerSessionSchema,
  providerTurnStartResultSchema,
  terminalCommandResultSchema,
  todoListSchema,
  wsServerMessageSchema,
} from "@acme/contracts";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type SubscriptionSet<TValue> = Set<(value: TValue) => void>;
type SafeParseResult<TValue> = { success: true; data: TValue } | { success: false };
type SchemaLike<TValue> = {
  safeParse: (value: unknown) => SafeParseResult<TValue>;
};
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_NESTED_ERROR_EXTRACTION_DEPTH = 8;
const textDecoder = new TextDecoder();

function closeDetailsFromEvent(event: unknown) {
  const code = (event as { code?: unknown } | null)?.code;
  const reason = (event as { reason?: unknown } | null)?.reason;
  return {
    code: normalizeCloseCode(code),
    reason: normalizeNonEmptyString(reason),
  };
}

function runtimeConnectErrorFromClose(event: unknown) {
  const { code, reason } = closeDetailsFromEvent(event);
  if (code === WS_CLOSE_CODES.unauthorized || reason === WS_CLOSE_REASONS.unauthorized) {
    return new Error("Failed to connect to local t3 runtime: unauthorized websocket connection.");
  }
  if (
    code === WS_CLOSE_CODES.replacedByNewClient ||
    reason === WS_CLOSE_REASONS.replacedByNewClient
  ) {
    return new Error(
      "Failed to connect to local t3 runtime: replaced by a newer websocket client.",
    );
  }
  if (code === null && (!reason || reason.length === 0)) {
    return new Error("Failed to connect to local t3 runtime.");
  }
  if (code === null) {
    return new Error(`Failed to connect to local t3 runtime (close reason: ${reason}).`);
  }
  if (!reason || reason.length === 0) {
    return new Error(`Failed to connect to local t3 runtime (close code ${code}).`);
  }
  return new Error(`Failed to connect to local t3 runtime (close code ${code}: ${reason}).`);
}

function requestDisconnectError(id: string, event: unknown) {
  const { code, reason } = closeDetailsFromEvent(event);
  if (code === WS_CLOSE_CODES.unauthorized || reason === WS_CLOSE_REASONS.unauthorized) {
    return new Error(`Request ${id} failed: websocket disconnected (unauthorized).`);
  }
  if (
    code === WS_CLOSE_CODES.replacedByNewClient ||
    reason === WS_CLOSE_REASONS.replacedByNewClient
  ) {
    return new Error(`Request ${id} failed: websocket disconnected (replaced-by-new-client).`);
  }
  if (code === null && (!reason || reason.length === 0)) {
    return new Error(`Request ${id} failed: websocket disconnected.`);
  }
  if (code === null) {
    return new Error(`Request ${id} failed: websocket disconnected (reason: ${reason}).`);
  }
  if (!reason || reason.length === 0) {
    return new Error(`Request ${id} failed: websocket disconnected (code ${code}).`);
  }
  return new Error(`Request ${id} failed: websocket disconnected (code ${code}: ${reason}).`);
}

function requestSocketError(id: string, event: unknown) {
  const message = socketErrorMessage(event);
  if (typeof message === "string" && message.length > 0) {
    return new Error(`Request ${id} failed: websocket errored (${message}).`);
  }
  return new Error(`Request ${id} failed: websocket errored.`);
}

function runtimeConnectErrorFromSocketError(event: unknown) {
  const message = socketErrorMessage(event);
  if (typeof message === "string" && message.length > 0) {
    return new Error(`Failed to connect to local t3 runtime: websocket error (${message}).`);
  }
  return new Error("Failed to connect to local t3 runtime.");
}

function runtimeConnectErrorFromConstructionError(error: unknown) {
  const message = messageFromUnknown(error);
  if (message) {
    return new Error(`Failed to connect to local t3 runtime: websocket error (${message}).`);
  }
  return new Error("Failed to connect to local t3 runtime.");
}

function socketErrorMessage(event: unknown) {
  return messageFromUnknown(event);
}

function messageFromUnknown(value: unknown, depth = 0): string | null {
  if (depth > MAX_NESTED_ERROR_EXTRACTION_DEPTH) {
    return null;
  }

  const direct = normalizeNonEmptyString(value);
  if (direct) {
    return direct;
  }

  const message = normalizeNonEmptyString((value as { message?: unknown } | null)?.message);
  if (message) {
    return message;
  }

  const nestedErrorMessage = messageFromUnknown(
    (value as { error?: unknown } | null)?.error,
    depth + 1,
  );
  if (nestedErrorMessage) {
    return nestedErrorMessage;
  }

  return messageFromUnknown((value as { cause?: unknown } | null)?.cause, depth + 1);
}

function normalizeNonEmptyString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }

  return normalized;
}

function normalizeCloseCode(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }

  return value;
}

class WsNativeApiClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<WebSocket> | null = null;
  private nextRequestId = 1;
  private pending = new Map<string, PendingRequest>();
  private providerEventListeners: SubscriptionSet<ProviderEvent> = new Set();
  private agentOutputListeners: SubscriptionSet<OutputChunk> = new Set();
  private agentExitListeners: SubscriptionSet<AgentExit> = new Set();

  constructor(private readonly wsUrl: string) {}

  private rejectPendingRequests(errorForRequest: (id: string) => Error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(errorForRequest(id));
    }
    this.pending.clear();
  }

  private connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.socket);
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    const connectAttempt = new Promise<WebSocket>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.wsUrl);
      } catch (error) {
        reject(runtimeConnectErrorFromConstructionError(error));
        return;
      }
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      let hasOpened = false;
      let connectionSettled = false;
      const rejectConnection = (error?: Error) => {
        if (connectionSettled) {
          return;
        }
        connectionSettled = true;
        this.connectPromise = null;
        reject(error ?? new Error("Failed to connect to local t3 runtime."));
      };
      const resolveConnection = () => {
        if (connectionSettled) {
          return;
        }
        connectionSettled = true;
        this.connectPromise = null;
        resolve(socket);
      };

      socket.addEventListener("open", () => {
        hasOpened = true;
        resolveConnection();
      });

      socket.addEventListener("error", (event) => {
        if (this.socket !== socket) {
          if (!hasOpened) {
            rejectConnection(runtimeConnectErrorFromSocketError(event));
          }
          return;
        }

        if (!hasOpened) {
          rejectConnection(runtimeConnectErrorFromSocketError(event));
          return;
        }

        this.socket = null;
        this.rejectPendingRequests((id) => requestSocketError(id, event));
        try {
          socket.close();
        } catch {
          // best-effort close after error
        }
      });

      socket.addEventListener("message", (event) => {
        if (this.socket !== socket) {
          return;
        }
        void this.handleMessage(event.data);
      });

      socket.addEventListener("close", (event) => {
        if (this.socket !== socket) {
          if (!hasOpened) {
            rejectConnection(runtimeConnectErrorFromClose(event));
          }
          return;
        }

        this.socket = null;
        if (!hasOpened) {
          rejectConnection(runtimeConnectErrorFromClose(event));
          return;
        }
        this.rejectPendingRequests((id) => requestDisconnectError(id, event));
      });
    });

    this.connectPromise = connectAttempt;
    connectAttempt.catch(() => {
      if (this.connectPromise === connectAttempt) {
        this.connectPromise = null;
      }
    });

    return connectAttempt;
  }

  private async request(method: string, params?: unknown) {
    const socket = await this.connect();
    const id = String(this.nextRequestId);
    this.nextRequestId += 1;

    const requestMessage: WsClientMessage = {
      type: "request",
      id,
      method,
      params,
    };

    const requestPromise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out for method '${method}'.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
    });

    try {
      socket.send(JSON.stringify(requestMessage));
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        const sendErrorMessage = messageFromUnknown(error);
        pending.reject(
          new Error(
            `Failed to send runtime request '${method}': ${sendErrorMessage ?? "unknown websocket failure"}`,
          ),
        );
      }
      this.rejectPendingRequests((requestId) => requestSocketError(requestId, error));
      if (this.socket === socket) {
        this.socket = null;
      }
      try {
        socket.close();
      } catch {
        // best-effort close after send failure
      }
    }

    return requestPromise;
  }

  private async requestParsed<TValue>(
    method: string,
    schema: SchemaLike<TValue>,
    params?: unknown,
  ): Promise<TValue> {
    const value = await this.request(method, params);
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Runtime method '${method}' returned invalid response payload.`);
    }
    return parsed.data;
  }

  private async requestNullResult(method: string, params?: unknown): Promise<void> {
    const value = await this.request(method, params);
    if (value !== null) {
      throw new Error(`Runtime method '${method}' returned invalid response payload.`);
    }
  }

  private handleResponse(message: WsResponseMessage) {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }

    pending.reject(new Error(message.error?.message ?? "Unknown runtime request failure."));
  }

  private handleEvent(message: WsEventMessage) {
    if (message.channel === WS_EVENT_CHANNELS.providerEvent) {
      for (const listener of this.providerEventListeners) {
        listener(message.payload as ProviderEvent);
      }
      return;
    }

    if (message.channel === WS_EVENT_CHANNELS.agentOutput) {
      for (const listener of this.agentOutputListeners) {
        listener(message.payload as OutputChunk);
      }
      return;
    }

    if (message.channel === WS_EVENT_CHANNELS.agentExit) {
      for (const listener of this.agentExitListeners) {
        listener(message.payload as AgentExit);
      }
    }
  }

  private async decodeIncomingMessage(raw: unknown): Promise<string | null> {
    if (typeof raw === "string") {
      return raw;
    }

    if (ArrayBuffer.isView(raw)) {
      return textDecoder.decode(raw);
    }

    if (raw instanceof ArrayBuffer) {
      return textDecoder.decode(raw);
    }

    if (raw instanceof Blob) {
      return raw.text();
    }

    return null;
  }

  private async handleMessage(raw: unknown) {
    let decoded: string | null;
    try {
      decoded = await this.decodeIncomingMessage(raw);
    } catch {
      return;
    }
    if (!decoded) {
      return;
    }

    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(decoded);
    } catch {
      return;
    }

    const parsed = wsServerMessageSchema.safeParse(parsedRaw);
    if (!parsed.success) {
      return;
    }

    if (parsed.data.type === "response") {
      this.handleResponse(parsed.data);
      return;
    }

    if (parsed.data.type === "event") {
      this.handleEvent(parsed.data);
    }
  }

  asNativeApi(): NativeApi {
    return {
      app: {
        bootstrap: async () => this.requestParsed("app.bootstrap", appBootstrapResultSchema),
        health: async () => this.requestParsed("app.health", appHealthResultSchema),
      },
      todos: {
        list: async () => this.requestParsed("todos.list", todoListSchema),
        add: async (input) => this.requestParsed("todos.add", todoListSchema, input),
        toggle: async (id) => this.requestParsed("todos.toggle", todoListSchema, id),
        remove: async (id) => this.requestParsed("todos.remove", todoListSchema, id),
      },
      dialogs: {
        pickFolder: async () => {
          const value = await this.request("dialogs.pickFolder");
          if (value === null || typeof value === "string") {
            return value;
          }
          throw new Error("Runtime method 'dialogs.pickFolder' returned invalid response payload.");
        },
      },
      terminal: {
        run: async (input) => this.requestParsed("terminal.run", terminalCommandResultSchema, input),
      },
      agent: {
        spawn: async (config) => this.requestParsed("agent.spawn", agentSessionIdSchema, config),
        kill: async (sessionId) => this.requestNullResult("agent.kill", sessionId),
        write: async (sessionId, data) => this.requestNullResult("agent.write", { sessionId, data }),
        onOutput: (callback) => {
          this.agentOutputListeners.add(callback);
          return () => {
            this.agentOutputListeners.delete(callback);
          };
        },
        onExit: (callback) => {
          this.agentExitListeners.add(callback);
          return () => {
            this.agentExitListeners.delete(callback);
          };
        },
      },
      providers: {
        startSession: async (input) =>
          this.requestParsed("providers.startSession", providerSessionSchema, input),
        sendTurn: async (input) =>
          this.requestParsed("providers.sendTurn", providerTurnStartResultSchema, input),
        interruptTurn: async (input) => this.requestNullResult("providers.interruptTurn", input),
        respondToRequest: async (input) => this.requestNullResult("providers.respondToRequest", input),
        stopSession: async (input) => this.requestNullResult("providers.stopSession", input),
        listSessions: async () =>
          this.requestParsed("providers.listSessions", providerSessionListSchema),
        onEvent: (callback) => {
          this.providerEventListeners.add(callback);
          return () => {
            this.providerEventListeners.delete(callback);
          };
        },
      },
      shell: {
        openInEditor: async (cwd, editor) => this.requestNullResult("shell.openInEditor", { cwd, editor }),
      },
    };
  }
}

function resolveWsUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("ws") ?? "ws://127.0.0.1:4317";
}

let cachedApi: NativeApi | undefined;

export function getOrCreateWsNativeApi() {
  if (cachedApi) {
    return cachedApi;
  }

  cachedApi = new WsNativeApiClient(resolveWsUrl()).asNativeApi();
  return cachedApi;
}
