// Everything the extension does with PopNow, with the browser parts passed in. The service worker
// runs one of these; the tests run it against a fake server in Node.
//
// Mode: an API key in storage means API-key mode (USD, developer server); otherwise a signed-in
// account means account mode (credits). The two never mix on screen.

import { isFinished, PopNowClient } from "../api.js";
import { accountAuth, keyAuth, KEY_MCP_URL, McpClient, resultText } from "./mcp.js";
import { DEFAULT_MCP_URL, login as oauthLogin, revoke } from "./oauth.js";
import { decodeDataUrl, fileNameFor } from "./page-image.js";
import { getMcpJob, parseCreations, parseEffects, parseModels, pollJobs, quote as quoteTool, readJobs, runAndRecord, updateJobs } from "./run.js";
import { uploadToAccount, uploadWithKey } from "./upload.js";

export const PRICING_URL = "https://popnow.ai/pricing";
export const LIBRARY_URL = "https://popnow.ai/assets";
export const DEFAULT_MODELS = { image: "google/nano-banana-2.1/text-to-image", video: "minimax/h3/text-to-video" };
const REST_TASKS = { image: "text-to-image", video: "text-to-video" };

export function createService({ fetch: fetchImpl, storage, now = Date.now, version = "0", mcpUrl = DEFAULT_MCP_URL, keyMcpUrl = KEY_MCP_URL, apiUrl }) {
  const auth = accountAuth({ fetch: fetchImpl, storage, now });
  let account;
  let keyClient;

  async function mode() {
    const { apiKey, account: session } = await storage.get(["apiKey", "account"]);
    if (apiKey) return "key";
    if (session?.accessToken) return "account";
    return undefined;
  }

  async function apiKey() {
    const { apiKey: key } = await storage.get("apiKey");
    return key;
  }

  async function mcpFor(which) {
    if (which === "key") {
      const key = await apiKey();
      if (!key) return undefined;
      if (keyClient?.key !== key) keyClient = { key, client: new McpClient({ fetch: fetchImpl, auth: keyAuth(key, keyMcpUrl), clientVersion: version }) };
      return keyClient.client;
    }
    account ??= new McpClient({ fetch: fetchImpl, auth, clientVersion: version });
    return account;
  }

  async function current() {
    const which = await mode();
    if (!which) throw Object.assign(new Error("Sign in to PopNow to continue."), { name: "SignInRequiredError" });
    return { which, client: await mcpFor(which) };
  }

  async function rest() {
    const key = await apiKey();
    return key ? new PopNowClient(key, fetchImpl, apiUrl) : undefined;
  }

  /** Job readers per mode, for polling. */
  async function jobReader(which) {
    if (which === "rest") {
      const client = await rest();
      if (!client) return undefined;
      return {
        async getJob(taskId) {
          const task = await client.getTask(taskId);
          if (!isFinished(task)) return { status: "running" };
          const files = (task.output?.assets ?? [])
            .filter((asset) => asset.url && !asset.unavailable)
            .map((asset) => ({ url: asset.url, type: asset.mime ?? "" }));
          return task.state === "succeeded"
            ? { status: "succeeded", files, ...(task.costUsd ? { costUsd: String(task.costUsd) } : {}) }
            : { status: "failed", error: task.errorMessage ?? "The model could not finish this request." };
        },
      };
    }
    if ((await mode()) !== which) return undefined;
    const client = await mcpFor(which);
    return client && { getJob: (jobId, wait) => getMcpJob(client, jobId, wait) };
  }

  return {
    mode,

    async login({ launch, redirectUri }) {
      const session = await oauthLogin({ fetch: fetchImpl, mcpUrl, redirectUri, launch, now });
      await storage.set({ account: session });
      account = undefined;
      return { signedIn: true };
    },

    async logout() {
      const { account: session } = await storage.get("account");
      if (session) await revoke(fetchImpl, session);
      await storage.remove("account");
      account = undefined;
      return { signedIn: false };
    },

    async setKey(key) {
      const trimmed = String(key ?? "").trim();
      if (!trimmed) throw new Error("Paste a key first.");
      await storage.set({ apiKey: trimmed });
    },

    async removeKey() {
      await storage.remove("apiKey");
      keyClient = undefined;
    },

    /** { unit: "credits", credits } or { unit: "usd", usd }. */
    async balance() {
      const { which, client } = await current();
      const result = await client.callTool("check_balance", {});
      const data = result.structuredContent ?? {};
      if (result.isError) throw new Error(resultText(result) || "PopNow could not read the balance.");
      if (which === "key") return { unit: "usd", usd: String(data.available_usd ?? "0") };
      return { unit: "credits", credits: Number(data.credits ?? 0) };
    },

    /** Models for the prompt box. Account mode reads list_models; API-key mode reads the REST catalog. */
    async models(kind) {
      const which = await mode();
      if (which === "key") {
        const client = await rest();
        const items = await client.listModels(kind, REST_TASKS[kind]);
        return items.map((item) => ({ id: item.model, name: item.displayName ?? item.model, usd: item.usd }));
      }
      const { client } = await current();
      const result = await client.callTool("list_models", { category: kind });
      return parseModels(resultText(result), kind === "video" ? "create_video" : "create_image");
    },

    async effects() {
      const { which, client } = await current();
      if (which === "key") return parseEffects(resultText(await client.callTool("list_models", { category: "effects" })));
      const result = await client.callTool("list_presets", { kind: "effects" });
      return parseEffects(resultText(result), result.structuredContent?.effects);
    },

    async creations() {
      if ((await mode()) !== "account") return [];
      const { client } = await current();
      return parseCreations(resultText(await client.callTool("list_my_creations", { limit: 12 })));
    },

    jobs: () => readJobs(storage),

    /** Uploads image bytes read from a page; returns the popnow:// link. */
    async uploadImage({ dataUrl, srcUrl }) {
      const { contentType, bytes } = decodeDataUrl(dataUrl);
      if (!contentType.startsWith("image/")) throw new Error("This is not an image PopNow can use.");
      const file = { body: bytes, contentType, name: fileNameFor(srcUrl, contentType) };
      const which = await mode();
      if (which === "key") return uploadWithKey(fetchImpl, await apiKey(), file, apiUrl);
      const { client } = await current();
      const [link] = await uploadToAccount(client, fetchImpl, [file]);
      return link;
    },

    /** Price of a tool call (or of a prompt run through the REST API in API-key mode). */
    async quote({ tool, args, rest: restRun }) {
      if (restRun) {
        const client = await rest();
        const priced = await client.quote(restRun.model, restRun.input);
        return { unit: "usd", usd: String(priced.maxChargeUsd), quoteId: priced.quoteId, ...(priced.expectedChargeUsd ? { expected: String(priced.expectedChargeUsd) } : {}) };
      }
      const { which, client } = await current();
      return quoteTool(client, which, tool, args);
    },

    /** Starts a confirmed run and records it for polling. */
    async run({ tool, args, approved, consent, title, source, rest: restRun }) {
      if (restRun) {
        const client = await rest();
        const createdAt = now();
        const id = `r${createdAt.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const task = await client.createTask(restRun.model, restRun.input, { quoteId: approved.quoteId, maxChargeUsd: approved.usd }, restRun.idempotencyKey ?? id);
        const record = { id, mode: "rest", tool: restRun.kind === "video" ? "create_video" : "create_image", title, jobId: task.taskId, status: "running", createdAt, updatedAt: createdAt };
        await updateJobs(storage, (jobs) => [...jobs, record]);
        return { kind: "job", id, record };
      }
      const { which, client } = await current();
      return runAndRecord({ storage, client, mode: which, tool, args, approved, consent, title, source, now });
    },

    /** One polling pass; returns how many jobs are still running. */
    poll({ notify, waitSeconds = 0 } = {}) {
      return pollJobs({ storage, clientFor: jobReader, notify, now, waitSeconds });
    },

    async forgetJob(id) {
      await updateJobs(storage, (jobs) => jobs.filter((job) => job.id !== id));
    },
  };
}
