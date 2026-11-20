// Prices, starts and follows PopNow creations.
//
// Account mode (credits): estimate_cost gives the price; the user confirms; the tool is called with
// max_credits set to exactly that price. If the server then asks for more, nothing starts and the
// user is asked again: the confirmed amount is never raised automatically.
// API-key mode (USD): the tool is called without max_usd to get cost_usd; after the user confirms it
// is called again with currency USD and max_usd.

import { resultText } from "./mcp.js";

export const DONE_STATES = new Set(["succeeded", "failed", "blocked", "canceled", "expired"]);
const KEEP_JOBS = 30;
/** A start that never reported back (the worker was stopped mid-call) is given up after this long. */
const LOST_AFTER_MS = 4 * 60_000;

export function formatCredits(credits) {
  const n = Number(credits);
  return `${Number.isFinite(n) ? n.toLocaleString("en-US") : credits} ${n === 1 ? "credit" : "credits"}`;
}

export function formatUsd(amount) {
  const text = String(amount ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return `$${text}`;
  const [whole, fraction = ""] = text.split(".");
  // Keep at least cents and at most the digits that matter.
  const trimmed = fraction.replace(/0+$/, "");
  return `$${whole}.${trimmed.length >= 2 ? trimmed.slice(0, 6) : trimmed.padEnd(2, "0")}`;
}

/** Turns a quote into the words on the confirm button. */
export function priceLabel(quote) {
  if (!quote) return "";
  return quote.unit === "usd" ? formatUsd(quote.usd) : formatCredits(quote.credits);
}

function structured(result) {
  return result?.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : {};
}

function quoteFrom(data, mode) {
  if (mode === "key") {
    if (typeof data.cost_usd !== "string") return undefined;
    return { unit: "usd", usd: data.cost_usd, ...(typeof data.available_usd === "string" ? { balance: data.available_usd } : {}) };
  }
  if (typeof data.credits !== "number" || !Number.isFinite(data.credits) || data.credits < 0) return undefined;
  return { unit: "credits", credits: data.credits, ...(typeof data.balance === "number" ? { balance: data.balance } : {}) };
}

export function jobFrom(data) {
  const job = { jobId: data.job_id, status: typeof data.status === "string" ? data.status : "running" };
  if (Array.isArray(data.files)) {
    job.files = data.files
      .filter((file) => file && typeof file.url === "string")
      .map((file) => ({ url: file.url, ...(typeof file.popnow_link === "string" ? { link: file.popnow_link } : {}), type: file.type ?? "" }));
  }
  if (typeof data.credits === "number") job.credits = data.credits;
  if (typeof data.cost_usd === "string") job.costUsd = data.cost_usd;
  if (typeof data.model === "string") job.model = data.model;
  return job;
}

/**
 * What a tool call came back with:
 *   consent       the user must confirm the people in their media are them or agreed
 *   confirm       the server wants a price confirmed (first quote, or a price that went up)
 *   job           a creation started (maybe already finished)
 *   saved         a library item (save_to_library)
 *   error         refused; nothing was charged
 *   done          anything else, shown as text
 */
export function classify(result, mode) {
  const data = structured(result);
  const text = resultText(result);
  if (data.needs_consent === true) return { kind: "consent", text, ...(quoteFrom(data, mode) ? { quote: quoteFrom(data, mode) } : {}) };
  if (data.needs_confirmation === true) {
    const quote = quoteFrom(data, mode);
    if (quote) return { kind: "confirm", quote, text };
  }
  if (result?.isError) return { kind: "error", text: text || "PopNow could not do that." };
  // The account server says "Not started: the price is now N credits" without structured data.
  const changed = /^Not started: the price is now (\d+) credits/i.exec(text);
  if (changed && mode !== "key") return { kind: "confirm", quote: { unit: "credits", credits: Number(changed[1]) }, text };
  if (typeof data.job_id === "string" && data.job_id) return { kind: "job", job: jobFrom(data), text };
  if (typeof data.popnow_link === "string" && typeof data.asset_id === "string") {
    return { kind: "saved", link: data.popnow_link, name: data.name ?? "", text };
  }
  return { kind: "done", text };
}

/** The price of a call, without starting anything. */
export async function quote(client, mode, tool, rawArgs) {
  // A price is always asked for without any approval in the arguments.
  const args = confirmedArgs(mode, rawArgs, undefined, undefined);
  if (mode === "key") {
    // The developer server never starts a paid call without max_usd, so this only quotes.
    const outcome = classify(await client.callTool(tool, args), mode);
    if (outcome.kind === "confirm") return outcome.quote;
    if (outcome.kind === "error") throw new Error(outcome.text);
    throw new Error("PopNow did not return a price for this.");
  }
  const result = await client.callTool("estimate_cost", { tool, arguments: args });
  if (result.isError) throw new Error(resultText(result) || "PopNow could not price this.");
  const priced = quoteFrom(structured(result), mode);
  if (!priced) throw new Error("PopNow did not return a price for this.");
  return priced;
}

/** Calls the tool with the price the user confirmed (and consent only when the user ticked it). */
export function confirmedArgs(mode, args, approved, consent) {
  const out = { ...args };
  delete out.max_credits;
  delete out.max_usd;
  delete out.currency;
  delete out.consent;
  if (approved) {
    if (mode === "key") {
      out.currency = "USD";
      out.max_usd = approved.usd;
    } else {
      out.max_credits = approved.credits;
    }
  }
  if (consent === true) out.consent = true;
  return out;
}

export async function start(client, mode, tool, args, approved, consent) {
  return classify(await client.callTool(tool, confirmedArgs(mode, args, approved, consent)), mode);
}

// ── Jobs kept in extension storage, so a stopped service worker can pick them up again ────────────

export async function readJobs(storage) {
  const { jobs } = await storage.get("jobs");
  return Array.isArray(jobs) ? jobs : [];
}

/** Applies `change` to the stored list in one read-modify-write. */
export async function updateJobs(storage, change) {
  const jobs = change(await readJobs(storage)) ?? [];
  jobs.sort((a, b) => b.createdAt - a.createdAt);
  await storage.set({ jobs: jobs.slice(0, KEEP_JOBS) });
  return jobs;
}

export async function patchJob(storage, id, patch) {
  let found;
  await updateJobs(storage, (jobs) =>
    jobs.map((job) => {
      if (job.id !== id) return job;
      found = { ...job, ...patch };
      return found;
    }),
  );
  return found;
}

export function isRunning(job) {
  return job.status === "starting" || (job.status !== undefined && !DONE_STATES.has(job.status) && job.status !== "lost");
}

/**
 * Starts a confirmed run and records it. The record exists before the call, so a run whose answer
 * never arrived is shown as lost (check My creations) instead of silently started again.
 */
export async function runAndRecord({ storage, client, mode, tool, args, approved, consent, title, source, now = Date.now, id }) {
  const recordId = id ?? `r${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = now();
  await updateJobs(storage, (jobs) => [...jobs, { id: recordId, mode, tool, title, status: "starting", createdAt, updatedAt: createdAt, ...(source ? { source } : {}) }]);
  let outcome;
  try {
    outcome = await start(client, mode, tool, args, approved, consent);
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    if (timedOut) {
      await patchJob(storage, recordId, { status: "lost", updatedAt: now() });
      return { kind: "lost", id: recordId };
    }
    await updateJobs(storage, (jobs) => jobs.filter((job) => job.id !== recordId));
    throw error;
  }
  if (outcome.kind === "job") {
    const record = await patchJob(storage, recordId, { ...outcome.job, updatedAt: now(), text: outcome.text });
    return { ...outcome, id: recordId, record };
  }
  if (outcome.kind === "saved") {
    const record = await patchJob(storage, recordId, { status: "succeeded", saved: outcome.link, updatedAt: now(), text: outcome.text });
    return { ...outcome, id: recordId, record };
  }
  await updateJobs(storage, (jobs) => jobs.filter((job) => job.id !== recordId));
  return outcome;
}

/**
 * One polling pass over running jobs. `clientFor(mode)` returns a client for that mode (or undefined
 * when signed out); `notify(job)` is called once for each job that finished during this pass.
 * Returns how many jobs are still running.
 */
export async function pollJobs({ storage, clientFor, notify = async () => {}, now = Date.now, waitSeconds = 0 }) {
  const running = (await readJobs(storage)).filter(isRunning);
  let still = 0;
  for (const job of running) {
    if (job.status === "starting" || !job.jobId) {
      if (now() - job.createdAt > LOST_AFTER_MS) await patchJob(storage, job.id, { status: "lost", updatedAt: now() });
      else still++;
      continue;
    }
    const client = await clientFor(job.mode);
    if (!client) {
      still++;
      continue;
    }
    let next;
    try {
      next = await client.getJob(job.jobId, waitSeconds);
    } catch {
      still++;
      continue;
    }
    if (!next) {
      still++;
      continue;
    }
    const updated = await patchJob(storage, job.id, { ...next, updatedAt: now() });
    if (updated && DONE_STATES.has(updated.status)) {
      if (!updated.notified) {
        await patchJob(storage, job.id, { notified: true });
        await notify(updated);
      }
    } else {
      still++;
    }
  }
  return still;
}

/** get_job through MCP, as a job patch. */
export async function getMcpJob(client, jobId, waitSeconds = 0) {
  const result = await client.callTool("get_job", { job_id: jobId, wait_seconds: waitSeconds });
  const data = structured(result);
  if (typeof data.job_id !== "string") return undefined;
  const job = jobFrom(data);
  if (job.status === "failed" || job.status === "blocked") job.error = resultText(result);
  return job;
}

// ── Reading text-only tool results ───────────────────────────────────────────────────────────────

/** Rows of list_models: "- Name (model: id) by Provider: tasks [tool], price". */
export function parseModels(text, tool) {
  const models = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = /^- (.+?) \(model: ([^)]+)\) by ([^:]+): (.*)$/.exec(line.trim());
    if (!match) continue;
    const [, name, id, provider, rest] = match;
    if (tool && !rest.includes(`[${tool}]`)) continue;
    const price = /(about [\d,]+(?:\s*(?:to|-|–)\s*[\d,]+)? credits[^,]*)/i.exec(rest)?.[1];
    models.push({ id, name, provider, ...(price ? { price } : {}) });
  }
  return models;
}

/** Effects from list_presets or list_models (effects): "- Name (slug): line" or "- Name (slug) (popular): line". */
export function parseEffects(text, slugs) {
  const effects = [];
  const seen = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const match = /^- (.+?) \(([a-z0-9][a-z0-9-]*)\)(?: \(popular\))?: (.*)$/.exec(line.trim());
    if (!match || seen.has(match[2])) continue;
    if (Array.isArray(slugs) && slugs.length > 0 && !slugs.includes(match[2])) continue;
    seen.add(match[2]);
    effects.push({ id: match[2], name: match[1], line: match[3] });
  }
  return effects;
}

/** list_my_creations: "- Jan 2 15:04 UTC · image · Model · succeeded · 48 credits · job_id j1 · "prompt"\n  https://…" */
export function parseCreations(text) {
  const items = [];
  let current;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("- ")) {
      const parts = line.slice(2).split(" · ");
      const jobPart = parts.find((part) => part.startsWith("job_id "));
      if (!jobPart) {
        current = undefined;
        continue;
      }
      const at = parts.indexOf(jobPart);
      current = {
        when: parts[0],
        kind: parts[1] ?? "",
        model: parts[2] ?? "",
        status: parts[3] ?? "",
        cost: parts.slice(4, at).join(" · "),
        jobId: jobPart.slice("job_id ".length),
        label: parts.slice(at + 1).join(" · ").replace(/^"|"$/g, "").replace(/^made with /, ""),
      };
      items.push(current);
    } else if (current && /^\s+https:\/\//.test(raw)) {
      current.url = raw.trim();
    }
  }
  return items;
}
