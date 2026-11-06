const API_URL = "https://api.popnow.ai/api/v1";
const TERMINAL_STATES = new Set(["succeeded", "failed", "canceled", "expired"]);

export const KEYS_URL = "https://popnow.ai/api/console/keys";
export const BILLING_URL = "https://popnow.ai/api/console/billing";

export class PopNowError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }

  get isBalance() {
    return this.status === 402 || /balance|insufficient/i.test(`${this.code ?? ""} ${this.message}`);
  }

  get isAuth() {
    return this.status === 401 || this.status === 403;
  }
}

export function isFinished(task) {
  if (!TERMINAL_STATES.has(task.state)) return false;
  return !(task.output?.assets ?? []).some((asset) => asset.pending && !asset.unavailable);
}

export function formatPrice(price) {
  if (!price?.perUnit) return "";
  const unit = (price.unit ?? "").replace(/^per_/, "").replace(/_/g, " ");
  return unit ? `$${price.perUnit} / ${unit}` : `$${price.perUnit}`;
}

export function extensionFor(mime) {
  const subtype = mime?.split("/")[1]?.split(";")[0];
  if (subtype === "jpeg") return "jpg";
  if (subtype === "quicktime") return "mov";
  return subtype ?? "bin";
}

export class PopNowClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async request(path, init = {}) {
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", ...init.headers },
    });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // Non-JSON bodies only come from proxies; the status is reported below.
    }
    if (!response.ok) {
      const message = body.error?.message ?? body.msg ?? `PopNow returned HTTP ${response.status}`;
      throw new PopNowError(message, response.status, body.error?.code ?? String(body.code ?? ""));
    }
    return body.data ?? body;
  }

  async listModels(modality, task) {
    const query = new URLSearchParams({ modality, task });
    const data = await this.request(`/models?${query}`);
    return (data.items ?? []).filter((item) => item.available !== false);
  }

  quote(model, input) {
    return this.request("/jobs/quote", { method: "POST", body: JSON.stringify({ model, input }) });
  }

  // The quoted maximum is sent as expectedCostUsd, so a price change fails the call instead of charging more.
  createTask(model, input, quote, idempotencyKey) {
    return this.request("/jobs/createTask", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ model, input, quoteId: quote.quoteId, expectedCostUsd: quote.maxChargeUsd }),
    });
  }

  getTask(taskId) {
    return this.request(`/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
  }
}
