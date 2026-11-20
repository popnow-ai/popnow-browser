// A fake PopNow on 127.0.0.1: OAuth sign-in, the account MCP server (credits), the developer MCP
// server (API key, USD), upload windows, the REST API and a signed-upload target.

import { createServer } from "node:http";

function body(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export const API_KEY = "sk-popnow-test";

export async function startFake() {
  const fake = {
    origin: "",
    server: createServer(),
    calls: [],
    devCalls: [],
    rest: [],
    tokens: { issued: 0, refreshed: 0, revoked: [], refreshTokens: [] },
    registered: [],
    uploads: [],
    puts: [],
    price: { create_image: 48, edit_image: 60, create_video: 185, remove_background: 30, upscale: 40, expand_image: 50, relight_photo: 50, apply_effect: 200 },
    usd: { remove_background: "0.030000000", create_video: "0.250000000" },
    balance: 12000,
    jobPolls: {},
    /** When set, the next MCP request with this token gets a 401 once. */
    expire: undefined,
    /** When true, refresh_token grants are refused (invalid_grant). */
    refuseRefresh: false,
    /** When true, every refresh issues a new refresh token too. */
    rotate: false,
    /** Answer tools/call with an event stream (true) or plain JSON (false). */
    sse: true,
  };
  let accessCounter = 1;
  let refreshCounter = 1;
  let liveRefresh = "rt-1";

  const handleAccountTool = (name, args) => {
    const paid = Object.hasOwn(fake.price, name);
    if (name === "check_balance") return { content: [{ type: "text", text: `You have ${fake.balance.toLocaleString("en-US")} PopNow credits.` }], structuredContent: { currency: "credits", credits: fake.balance, held: 0 } };
    if (name === "estimate_cost") {
      const credits = fake.price[args.tool];
      if (credits === undefined) return { isError: true, content: [{ type: "text", text: `${args.tool} isn't a paid tool.` }] };
      return { content: [{ type: "text", text: `${args.tool} would cost about ${credits} credits (the user has ${fake.balance}). Nothing was started or charged.` }], structuredContent: { currency: "credits", credits, balance: fake.balance, steps: [credits] } };
    }
    if (name === "list_models") {
      const rows = args.category === "video"
        ? "- MiniMax H3 (model: minimax-h3) by MiniMax: text to video [create_video], image to video [create_video], about 185 credits\n- Kling 3 (model: kling-3) by Kuaishou: text to video [create_video], about 300 credits\n"
        : "- Nano Banana 2.1 (model: nano-banana-2.1) by Google: text to image [create_image], image edit [edit_image], about 48 credits\n- Upscaler (model: up-1) by PopNow: upscale [upscale], about 40 credits\n";
      return { content: [{ type: "text", text: `Models:\n${rows}Prices are estimates.` }] };
    }
    if (name === "list_presets") {
      return {
        content: [{ type: "text", text: "Video effects (apply_effect with a photo):\n- Zombie Turn (zombie-turn): A slow zombie transformation\n- Tiny Planet (tiny-planet): Wraps the scene into a planet" }],
        structuredContent: { effects: ["zombie-turn", "tiny-planet"] },
      };
    }
    if (name === "list_my_creations") {
      return { content: [{ type: "text", text: "Your latest 2 creations (all of them: https://popnow.ai/assets):\n- Nov 20 10:00 UTC · image · Nano Banana 2.1 · succeeded · 48 credits · job_id j-old · \"a lighthouse\"\n  https://media.example/old.png\n- Nov 19 09:00 UTC · video · MiniMax H3 · succeeded · 185 credits · job_id j-v · made with Zombie Turn\n  https://media.example/v.mp4\n" }] };
    }
    if (name === "request_upload") return { content: [{ type: "text", text: "Upload page ready." }], structuredContent: { upload_id: "up_1", url: `${fake.origin}/upload/tok123` } };
    if (name === "get_upload") {
      return { content: [{ type: "text", text: "1 file uploaded." }], structuredContent: { upload_id: "up_1", state: "closed", files: [{ popnow_link: "popnow://f/abc", name: fake.lastUploadName ?? "image.png", type: "image/png" }] } };
    }
    if (name === "save_to_library") return { content: [{ type: "text", text: "Saved." }], structuredContent: { asset_id: "a1", popnow_link: "popnow://a/1", name: "Saved", kind: "image" } };
    if (name === "get_job") {
      const polls = (fake.jobPolls[args.job_id] = (fake.jobPolls[args.job_id] ?? 0) + 1);
      if (polls < 2) return { content: [{ type: "text", text: "Still making it." }], structuredContent: { job_id: args.job_id, status: "running", currency: "credits", credits: 185 } };
      return { content: [{ type: "text", text: "Done!" }], structuredContent: { job_id: args.job_id, status: "succeeded", currency: "credits", credits: 185, files: [{ url: "https://media.example/v.mp4", popnow_link: "popnow://g/v", type: "video/mp4" }] } };
    }
    if (paid) {
      const price = fake.price[name];
      if (name === "edit_image" && String(args.image_url).includes("person") && args.consent !== true) {
        return { content: [{ type: "text", text: "Ask the user to confirm consent." }], structuredContent: { needs_consent: true, needs_confirmation: true, credits: price, balance: fake.balance } };
      }
      const max = Number(args.max_credits ?? 0);
      if (args.max_credits === undefined && price >= 300) {
        return { content: [{ type: "text", text: `Needs confirmation: ${price} credits.` }], structuredContent: { currency: "credits", needs_confirmation: true, credits: price, balance: fake.balance } };
      }
      if (args.max_credits !== undefined && max < price) {
        return { content: [{ type: "text", text: `Not started: the price is now ${price} credits, more than the ${max} the user agreed to. Nothing was charged.` }] };
      }
      fake.balance -= price;
      if (name === "create_video" || name === "apply_effect") {
        return { content: [{ type: "text", text: "Started; check with get_job." }], structuredContent: { job_id: "j-video", status: "running", currency: "credits", credits: price } };
      }
      return { content: [{ type: "text", text: "Done!" }], structuredContent: { job_id: `j-${name}`, status: "succeeded", currency: "credits", credits: price, files: [{ url: "https://media.example/x.png", popnow_link: "popnow://g/x", type: "image/png" }] } };
    }
    return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
  };

  const handleDevTool = (name, args) => {
    if (name === "check_balance") return { content: [{ type: "text", text: "Balance: $5.00 USD available." }], structuredContent: { currency: "USD", available_usd: "5.000000000", held_usd: "0" } };
    if (name === "list_models" && args.category === "effects") return { content: [{ type: "text", text: "Effects for a photo:\n\nHorror:\n- Zombie Turn (zombie-turn) (popular): A slow zombie transformation\n" }] };
    const cost = fake.usd[name];
    if (cost === undefined) return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
    if (args.max_credits !== undefined) return { isError: true, content: [{ type: "text", text: "max_credits is not accepted with an API key." }] };
    if (args.max_usd === undefined || args.currency !== "USD" || Number(args.max_usd) < Number(cost)) {
      return { content: [{ type: "text", text: `Needs confirmation: $${cost}.` }], structuredContent: { needs_confirmation: true, currency: "USD", cost_usd: cost, available_usd: "5.000000000" } };
    }
    return { content: [{ type: "text", text: "Done!" }], structuredContent: { job_id: `d-${name}`, status: "succeeded", currency: "USD", cost_usd: cost, files: [{ url: "https://media.example/cut.png", popnow_link: "popnow://g/cut", type: "image/png" }] } };
  };

  fake.server.on("request", async (request, response) => {
    const url = new URL(request.url ?? "/", fake.origin);
    const sent = await body(request);
    const json = (status, value, headers = {}) => response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      json(200, { resource: `${fake.origin}/mcp`, authorization_servers: [fake.issuer ?? fake.origin] });
    } else if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(200, {
        issuer: fake.declaredIssuer ?? fake.origin,
        authorization_endpoint: `${fake.origin}/oauth/authorize`,
        token_endpoint: `${fake.origin}/oauth/token`,
        registration_endpoint: `${fake.origin}/oauth/register`,
        revocation_endpoint: `${fake.origin}/oauth/revoke`,
      });
    } else if (url.pathname === "/oauth/register") {
      const reg = JSON.parse(sent.toString());
      fake.registered.push(reg);
      json(201, { client_id: "pnc_test", redirect_uris: reg.redirect_uris });
    } else if (url.pathname === "/oauth/authorize") {
      const p = url.searchParams;
      fake.authorize = Object.fromEntries(p);
      const back = new URL(p.get("redirect_uri") ?? "");
      back.searchParams.set("code", "code-1");
      back.searchParams.set("state", fake.forceState ?? p.get("state") ?? "");
      back.searchParams.set("iss", fake.callbackIssuer ?? fake.origin);
      response.writeHead(302, { location: back.toString() }).end();
    } else if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(sent.toString());
      fake.lastTokenForm = Object.fromEntries(form);
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "code-1" || !form.get("code_verifier")) return json(400, { error: "invalid_grant" });
        fake.tokens.issued++;
        json(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "generate read" });
      } else {
        fake.tokens.refreshTokens.push(form.get("refresh_token"));
        if (fake.refuseRefresh || form.get("refresh_token") !== liveRefresh) return json(400, { error: "invalid_grant" });
        fake.tokens.refreshed++;
        accessCounter++;
        const reply = { access_token: `at-${accessCounter}`, expires_in: 3600 };
        if (fake.rotate) {
          refreshCounter++;
          liveRefresh = `rt-${refreshCounter}`;
          reply.refresh_token = liveRefresh;
        }
        json(200, reply);
      }
    } else if (url.pathname === "/oauth/revoke") {
      fake.tokens.revoked.push(new URLSearchParams(sent.toString()).get("token") ?? "");
      response.writeHead(200).end();
    } else if (url.pathname.startsWith("/console/v1/upload-sessions/tok123")) {
      const rest = url.pathname.slice("/console/v1/upload-sessions/tok123".length);
      fake.uploads.push(`${request.method} ${rest}${request.headers.authorization ? " (auth!)" : ""}`);
      if (rest === "/files") {
        const req = JSON.parse(sent.toString());
        fake.lastUploadName = req.name;
        fake.uploadRequest = req;
        json(200, { code: 200, data: { fileId: "f1", uploadUrl: `${fake.origin}/put/f1?sig=x`, method: "PUT", headers: { "content-type": req.contentType } } });
      } else {
        json(200, { code: 200, data: { state: rest === "/close" ? "closed" : "open" } });
      }
    } else if (url.pathname.startsWith("/put/")) {
      fake.puts.push({ path: url.pathname, bytes: sent.length, authorization: request.headers.authorization, type: request.headers["content-type"] });
      response.writeHead(200).end();
    } else if (url.pathname.startsWith("/api/v1/") && url.pathname !== "/api/v1/mcp") {
      fake.rest.push(`${request.method} ${url.pathname}`);
      if (request.headers.authorization !== `Bearer ${API_KEY}`) return json(401, { error: { message: "bad key" } });
      const path = url.pathname.slice("/api/v1".length);
      if (path === "/common/upload-url") {
        const req = JSON.parse(sent.toString());
        json(200, { data: { fileId: "kf1", key: "k", uploadUrl: `${fake.origin}/put/kf1?sig=y`, method: "PUT", headers: { "content-type": req.contentType }, maxBytes: 1_000_000 } });
      } else if (path === "/files/kf1/commit") {
        json(200, { data: { fileId: "kf1", status: "ready", uri: "popnow://f/kf1" } });
      } else if (path === "/models") {
        json(200, { data: { items: [{ model: "google/nano-banana-2.1/text-to-image", displayName: "Nano Banana 2.1", usd: { perUnit: "0.039", unit: "per_image" } }] } });
      } else if (path === "/jobs/quote") {
        json(200, { data: { quoteId: "q1", maxChargeUsd: "0.039", expectedChargeUsd: "0.039" } });
      } else if (path === "/jobs/createTask") {
        fake.createTask = JSON.parse(sent.toString());
        fake.createTaskKey = request.headers["idempotency-key"];
        json(200, { data: { taskId: "t1", state: "queued" } });
      } else if (path === "/jobs/recordInfo") {
        json(200, { data: { taskId: "t1", state: "succeeded", costUsd: "0.039", output: { assets: [{ url: "https://media.example/rest.png", mime: "image/png" }] } } });
      } else {
        json(404, { error: { message: "not found" } });
      }
    } else if (url.pathname === "/mcp" || url.pathname === "/api/v1/mcp") {
      const dev = url.pathname === "/api/v1/mcp";
      const auth = request.headers.authorization ?? "";
      if (dev ? auth !== `Bearer ${API_KEY}` : fake.expire && auth === `Bearer ${fake.expire}`) {
        if (!dev) fake.expire = undefined;
        response.writeHead(401).end();
        return;
      }
      if (!dev && !/^Bearer at-\d+$/.test(auth)) {
        response.writeHead(401).end();
        return;
      }
      if (!dev && fake.rejectAll) {
        response.writeHead(401).end();
        return;
      }
      const message = JSON.parse(sent.toString());
      const record = { method: message.method, auth, accept: request.headers.accept, ...(message.params?.name ? { name: message.params.name } : {}), ...(message.params?.arguments ? { args: message.params.arguments } : {}) };
      (dev ? fake.devCalls : fake.calls).push(record);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result = {};
      if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } };
      else if (message.method === "tools/list") result = { tools: [{ name: "create_image" }] };
      else if (message.method === "tools/call") result = (dev ? handleDevTool : handleAccountTool)(message.params.name, message.params.arguments ?? {});
      if (fake.sse && message.method === "tools/call") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
      } else {
        json(200, { jsonrpc: "2.0", id: message.id, result });
      }
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.origin = `http://127.0.0.1:${fake.server.address().port}`;
  return fake;
}

/** chrome.storage.local in memory: get(key | keys), set(items), remove(key | keys). */
export function memoryStorage(initial = {}) {
  const data = { ...initial };
  const names = (keys) => (keys === undefined || keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]);
  return {
    data,
    async get(keys) {
      const out = {};
      for (const key of names(keys)) if (key in data) out[key] = structuredClone(data[key]);
      return out;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data[key] = structuredClone(value);
    },
    async remove(keys) {
      for (const key of names(keys)) delete data[key];
    },
  };
}

/** The browser's part of launchWebAuthFlow: follow the sign-in link and hand back where it redirected. */
export async function followSignIn(url) {
  const response = await fetch(url, { redirect: "manual" });
  return response.headers.get("location");
}
