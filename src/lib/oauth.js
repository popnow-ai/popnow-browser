// Sign-in with a PopNow account: OAuth 2.1 authorization code with PKCE (S256) and a dynamically
// registered public client, the same flow MCP apps use against https://api.popnow.ai/mcp.
// The browser part (chrome.identity.launchWebAuthFlow) is passed in as `launch`, so this module
// runs unchanged in the extension and in Node tests.

export const DEFAULT_MCP_URL = "https://api.popnow.ai/mcp";
export const SCOPES = "generate read";
const CLIENT_NAME = "PopNow for Chrome";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export class SignInRequiredError extends Error {
  constructor(message = "Sign in to PopNow to continue.") {
    super(message);
    this.name = "SignInRequiredError";
  }
}

function isLoopback(url) {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

/** Only https, except a server on this computer (for local testing). */
export function requireSecure(raw, what) {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
    throw new Error(`${what} must use https: ${url.origin}`);
  }
  return url;
}

function str(value, what) {
  if (typeof value !== "string" || value === "") throw new Error(`The sign-in server did not return ${what}.`);
  return value;
}

const trimSlash = (value) => value.replace(/\/$/, "");

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/** Finds the authorization server from the MCP endpoint's protected-resource metadata (RFC 9728). */
export async function discover(fetchImpl, mcpUrl) {
  const mcp = requireSecure(mcpUrl, "The PopNow server");
  const resourceMeta = await getJson(
    fetchImpl,
    `${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname === "/" ? "" : mcp.pathname}`,
  );
  const servers = resourceMeta.authorization_servers;
  const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : mcp.origin;
  requireSecure(issuer, "The sign-in server");
  const meta = await getJson(fetchImpl, `${trimSlash(issuer)}/.well-known/oauth-authorization-server`);
  const declared = str(meta.issuer, "an issuer");
  if (trimSlash(declared) !== trimSlash(issuer)) {
    throw new Error("The sign-in server's metadata does not match it (issuer mismatch).");
  }
  for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    requireSecure(str(meta[key], key.replace(/_/g, " ")), "The sign-in server");
  }
  const server = {
    issuer: declared,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
  };
  if (typeof meta.revocation_endpoint === "string") {
    requireSecure(meta.revocation_endpoint, "The sign-in server");
    server.revocationEndpoint = meta.revocation_endpoint;
  }
  return server;
}

export async function registerClient(fetchImpl, server, redirectUri) {
  const response = await fetchImpl(server.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPES,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Client registration failed (${response.status}).`);
  return str((await response.json()).client_id, "a client id");
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(size = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(size)));
}

export async function pkcePair() {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function authorizeUrl(server, { clientId, redirectUri, state, challenge, resource }) {
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", resource);
  return url.toString();
}

/**
 * Reads the URL the sign-in window ended on. A reply for another state or from another issuer is
 * refused (nothing is exchanged or saved); the user simply signs in again.
 */
export function readCallback(redirected, { redirectUri, state, issuer }) {
  let url;
  try {
    url = new URL(redirected);
  } catch {
    throw new Error("Sign-in did not finish. Try again.");
  }
  const expected = new URL(redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new Error("Sign-in came back to an unexpected address. Nothing was saved; try again.");
  }
  // Some servers answer in the fragment; read both.
  const params = new URLSearchParams(url.search);
  for (const [key, value] of new URLSearchParams(url.hash.replace(/^#/, ""))) if (!params.has(key)) params.set(key, value);
  if (params.get("state") !== state) {
    throw new Error("This sign-in reply is not the one PopNow was waiting for. Nothing was saved; try again.");
  }
  const iss = params.get("iss");
  if (iss !== null && trimSlash(iss) !== trimSlash(issuer)) {
    throw new Error("The sign-in reply came from an unexpected server. Nothing was saved; try again.");
  }
  const error = params.get("error");
  const code = params.get("code");
  if (error || !code) {
    throw new Error(error === "access_denied" ? "Sign-in was canceled." : `Sign-in failed: ${error ?? "no code in the reply"}.`);
  }
  return code;
}

async function tokenRequest(fetchImpl, endpoint, form) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const reply = await response.json().catch(() => ({}));
  if (!response.ok || typeof reply.access_token !== "string") {
    const reason = typeof reply.error === "string" ? reply.error : String(response.status);
    const error = new Error(`The sign-in server refused the request (${reason}).`);
    error.oauthError = reason;
    throw error;
  }
  return reply;
}

function sessionFrom(reply, base, now) {
  const session = { ...base, accessToken: reply.access_token };
  if (typeof reply.refresh_token === "string") session.refreshToken = reply.refresh_token;
  if (typeof reply.expires_in === "number") session.expiresAt = now + reply.expires_in * 1000;
  else delete session.expiresAt;
  if (typeof reply.scope === "string") session.scope = reply.scope;
  return session;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Full sign-in. `launch(url)` opens the sign-in page and resolves with the URL the browser was
 * sent back to (chrome.identity.launchWebAuthFlow does exactly that).
 */
export async function login({ fetch: fetchImpl, mcpUrl = DEFAULT_MCP_URL, redirectUri, launch, now = Date.now, timeoutMs = LOGIN_TIMEOUT_MS }) {
  requireSecure(redirectUri, "The sign-in return address");
  const server = await discover(fetchImpl, mcpUrl);
  const clientId = await registerClient(fetchImpl, server, redirectUri);
  const { verifier, challenge } = await pkcePair();
  const state = randomToken(16);
  const url = authorizeUrl(server, { clientId, redirectUri, state, challenge, resource: mcpUrl });
  const redirected = await withTimeout(launch(url), timeoutMs, "Sign-in timed out. Try again.");
  const code = readCallback(redirected, { redirectUri, state, issuer: server.issuer });
  const reply = await tokenRequest(fetchImpl, server.tokenEndpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    resource: mcpUrl,
  });
  const base = { issuer: server.issuer, mcpUrl, tokenEndpoint: server.tokenEndpoint, clientId };
  if (server.revocationEndpoint) base.revocationEndpoint = server.revocationEndpoint;
  return sessionFrom(reply, base, now());
}

/** Uses the refresh token; throws when there is none or the server refuses it. */
export async function refresh(fetchImpl, session, now = Date.now()) {
  if (!session.refreshToken) throw new SignInRequiredError("Your PopNow sign-in expired. Sign in again.");
  const reply = await tokenRequest(fetchImpl, session.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: session.clientId,
    resource: session.mcpUrl,
  });
  const { accessToken: _old, ...base } = session;
  return sessionFrom(reply, base, now);
}

/** Best effort: a failed revocation never blocks signing out locally. */
export async function revoke(fetchImpl, session) {
  if (!session?.revocationEndpoint) return false;
  let ok = true;
  for (const [token, hint] of [
    [session.refreshToken, "refresh_token"],
    [session.accessToken, "access_token"],
  ]) {
    if (!token) continue;
    try {
      const response = await fetchImpl(session.revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: session.clientId }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      ok &&= response.ok;
    } catch {
      ok = false;
    }
  }
  return ok;
}
