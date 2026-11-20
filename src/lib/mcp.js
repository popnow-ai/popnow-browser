// A small Streamable HTTP MCP client. The PopNow servers are stateless, so a client initializes once,
// then makes its calls. Account mode talks to https://api.popnow.ai/mcp with an OAuth token (credits);
// API-key mode talks to https://api.popnow.ai/api/v1/mcp with the key (USD).

import { refresh, SignInRequiredError } from "./oauth.js";

const PROTOCOL_VERSION = "2025-06-18";
export const KEY_MCP_URL = "https://api.popnow.ai/api/v1/mcp";

/** Reads a JSON-RPC reply that came back either as JSON or as a server-sent event stream. */
export async function readReply(response, id) {
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const messages = [];
  if (type.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) messages.push(JSON.parse(data));
    }
  } else if (text.trim()) {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) messages.push(...parsed);
    else messages.push(parsed);
  }
  const reply = messages.find((message) => message && typeof message === "object" && message.id === id);
  if (!reply) throw new Error("The PopNow server sent no reply.");
  if (reply.error) throw new Error(reply.error.message ?? "The PopNow server returned an error.");
  return reply.result ?? {};
}

/**
 * OAuth tokens kept in extension storage. Refreshes a little before expiry and once after a 401;
 * concurrent refreshes share one request because refresh tokens may rotate.
 */
export function accountAuth({ fetch: fetchImpl, storage, now = Date.now, key = "account" }) {
  let renewing;
  const load = async () => {
    const { [key]: session } = await storage.get(key);
    if (!session?.accessToken) throw new SignInRequiredError();
    return session;
  };
  const renew = (failedToken) => {
    renewing ??= (async () => {
      try {
        const session = await load();
        // Another call may have refreshed already: use that token instead of spending the refresh token again.
        if (failedToken && session.accessToken !== failedToken) return session;
        let next;
        try {
          next = await refresh(fetchImpl, session, now());
        } catch (error) {
          // A network problem is not a sign-out; a refused or missing refresh token is.
          if (!(error instanceof SignInRequiredError) && error?.oauthError === undefined) throw error;
          await storage.remove(key);
          throw new SignInRequiredError("Your PopNow sign-in expired. Sign in again.");
        }
        await storage.set({ [key]: next });
        return next;
      } finally {
        renewing = undefined;
      }
    })();
    return renewing;
  };
  return {
    endpoint: async () => (await load()).mcpUrl,
    async token() {
      const session = await load();
      if (session.expiresAt !== undefined && session.expiresAt - 30_000 < now()) return (await renew(session.accessToken)).accessToken;
      return session.accessToken;
    },
    async renew(failedToken) {
      return (await renew(failedToken)).accessToken;
    },
    /** A fresh token was refused too: the sign-in is no good any more. */
    async rejected() {
      await storage.remove(key);
      throw new SignInRequiredError("Your PopNow sign-in expired. Sign in again.");
    },
  };
}

export class KeyRejectedError extends Error {
  constructor() {
    super("PopNow did not accept this API key.");
    this.name = "KeyRejectedError";
  }
}

export function keyAuth(apiKey, endpoint = KEY_MCP_URL) {
  return {
    endpoint: async () => endpoint,
    token: async () => apiKey,
    renew: async () => {
      throw new KeyRejectedError();
    },
    rejected: async () => {
      throw new KeyRejectedError();
    },
  };
}

export class McpClient {
  constructor({ fetch: fetchImpl, auth, clientVersion = "0", timeoutMs = 30_000, callTimeoutMs = 120_000 }) {
    this.fetch = fetchImpl;
    this.auth = auth;
    this.clientVersion = clientVersion;
    this.timeoutMs = timeoutMs;
    this.callTimeoutMs = callTimeoutMs;
    this.protocolVersion = PROTOCOL_VERSION;
    this.initialized = undefined;
    this.nextId = 1;
  }

  async endpoint() {
    return this.auth.endpoint();
  }

  async post(body, timeoutMs, retried = false) {
    const token = await this.auth.token();
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.protocolVersion,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await this.fetch(await this.endpoint(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 && !retried) {
      await this.auth.renew(token);
      return this.post(body, timeoutMs, true);
    }
    if (response.status === 401) await this.auth.rejected();
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200).trim();
      throw new Error(`The PopNow server answered ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    return response;
  }

  async request(method, params) {
    if (method !== "initialize") await this.initialize();
    const id = this.nextId++;
    // Creation tools wait up to about 40 seconds on the server before handing back a job id.
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, method === "tools/call" ? this.callTimeoutMs : this.timeoutMs);
    return readReply(response, id);
  }

  initialize() {
    this.initialized ??= (async () => {
      const result = await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "popnow-browser", version: this.clientVersion },
      });
      if (typeof result.protocolVersion === "string" && result.protocolVersion) this.protocolVersion = result.protocolVersion;
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, this.timeoutMs);
    })().catch((error) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      if (Array.isArray(result.tools)) tools.push(...result.tools);
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    } while (cursor);
    return tools;
  }

  callTool(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }
}

/** The text parts of a tool result, joined. */
export function resultText(result) {
  return (result?.content ?? [])
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text)
    .join("\n")
    .trim();
}
