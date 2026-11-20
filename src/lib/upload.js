// Puts image bytes from a page into PopNow and returns popnow:// links.
// Account mode uses an upload window (request_upload → /console/v1/upload-sessions → get_upload).
// API-key mode uses the REST upload ticket (/api/v1/common/upload-url → PUT → commit).
// The signed upload address carries its own authorization: no Authorization header is ever sent to it.

const REQUEST_TIMEOUT_MS = 30_000;
const PUT_TIMEOUT_MS = 10 * 60_000;
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

/** The signed upload address could not be reached from the extension (usually CORS: a host permission is missing). */
export class UploadBlockedError extends Error {
  constructor(origin) {
    super("PopNow needs your permission to upload images from pages.");
    this.name = "UploadBlockedError";
    this.origin = origin;
  }
}

function kindOf(contentType) {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  throw new TypeError(`Only images, videos and audio can be uploaded (got ${contentType}).`);
}

function sizeOf(body) {
  return body.byteLength ?? body.size;
}

async function putSigned(fetchImpl, ticket, file) {
  const headers = {};
  for (const [key, value] of Object.entries(ticket.headers ?? {})) {
    if (!/^(content-length|host|authorization)$/i.test(key)) headers[key] = value;
  }
  let response;
  try {
    response = await fetchImpl(ticket.uploadUrl, {
      method: typeof ticket.method === "string" && ticket.method ? ticket.method : "PUT",
      headers,
      body: file.body,
      credentials: "omit",
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TypeError") throw new UploadBlockedError(new URL(ticket.uploadUrl).origin);
    throw error;
  }
  if (!response.ok) throw new Error(`Upload of ${file.name} failed (${response.status}).`);
}

async function envelope(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 200) {
    throw new Error(body.msg ? `Upload failed: ${body.msg}` : `Upload failed (${response.status}).`);
  }
  return body.data ?? {};
}

/**
 * files: [{ body: Uint8Array | Blob, name, contentType }]
 * client: an McpClient signed in to the account.
 */
export async function uploadToAccount(client, fetchImpl, files, note = "Images from PopNow for Chrome") {
  if (files.length === 0) return [];
  if (files.length > 10) throw new TypeError("Upload at most 10 files at once.");
  for (const file of files) {
    if (sizeOf(file.body) === 0) throw new Error(`${file.name} is empty.`);
    if (sizeOf(file.body) > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is too large to upload.`);
  }
  const kinds = [...new Set(files.map((file) => kindOf(file.contentType)))];
  const opened = await client.callTool("request_upload", { kinds, max_files: files.length, note });
  const data = opened.structuredContent ?? {};
  const uploadId = typeof data.upload_id === "string" ? data.upload_id : undefined;
  const pageUrl = typeof data.url === "string" ? data.url : undefined;
  if (!uploadId || !pageUrl) throw new Error("PopNow did not open an upload window.");
  const token = new URL(pageUrl).pathname.split("/").filter(Boolean).at(-1) ?? "";
  const api = `${new URL(await client.endpoint()).origin}/console/v1/upload-sessions/${encodeURIComponent(token)}`;
  const post = (path, body) =>
    fetchImpl(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "omit",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  for (const file of files) {
    const ticket = await envelope(await post("/files", { contentType: file.contentType, bytes: sizeOf(file.body), name: file.name }));
    if (typeof ticket.uploadUrl !== "string" || typeof ticket.fileId !== "string") throw new Error("Upload failed: no upload address.");
    await putSigned(fetchImpl, ticket, file);
    await envelope(await post(`/files/${encodeURIComponent(ticket.fileId)}/commit`));
  }
  await post("/close").then(envelope).catch(() => undefined);

  const result = await client.callTool("get_upload", { upload_id: uploadId, wait_seconds: 0 });
  const listed = Array.isArray(result.structuredContent?.files) ? [...result.structuredContent.files] : [];
  return files.map((file) => {
    const at = listed.findIndex((item) => item.name === file.name);
    const item = at >= 0 ? listed.splice(at, 1)[0] : listed.shift();
    if (!item || typeof item.popnow_link !== "string") throw new Error(`PopNow did not return a link for ${file.name}.`);
    return item.popnow_link;
  });
}

/** API-key mode: one file through the REST upload ticket. Returns its popnow://f/ link. */
export async function uploadWithKey(fetchImpl, apiKey, file, apiUrl = "https://api.popnow.ai/api/v1") {
  const size = sizeOf(file.body);
  if (size === 0) throw new Error(`${file.name} is empty.`);
  const call = async (path, body) => {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // A proxy page; the status is reported below.
    }
    if (!response.ok) throw new Error(parsed.error?.message ?? parsed.msg ?? `Upload failed (${response.status}).`);
    return parsed.data ?? parsed;
  };
  const ticket = await call("/common/upload-url", { contentType: file.contentType, bytes: size });
  if (typeof ticket.uploadUrl !== "string" || typeof ticket.fileId !== "string") throw new Error("Upload failed: no upload address.");
  if (typeof ticket.maxBytes === "number" && size > ticket.maxBytes) throw new Error(`${file.name} is too large to upload.`);
  await putSigned(fetchImpl, ticket, file);
  const committed = await call(`/files/${encodeURIComponent(ticket.fileId)}/commit`);
  if (typeof committed.uri !== "string") throw new Error("Upload failed: no link for the file.");
  return committed.uri;
}
