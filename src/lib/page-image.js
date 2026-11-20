// Images on web pages. A public https image is passed to PopNow as a link; anything else (data:,
// blob:, http:, or an https image the server can't open because it needs the page's sign-in) is
// read inside the page and uploaded.

/** "link" when PopNow can fetch the address itself, "page" when the bytes must be read in the page. */
export function imageSource(srcUrl) {
  try {
    return new URL(srcUrl).protocol === "https:" ? "link" : "page";
  } catch {
    return "page";
  }
}

const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/svg+xml": "svg" };

/** A short file name for an image address. */
export function fileNameFor(srcUrl, contentType) {
  const ext = EXTENSIONS[contentType] ?? "png";
  try {
    const url = new URL(srcUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
      const base = last.replace(/\.[a-z0-9]+$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 60);
      if (base) return `${base}.${ext}`;
    }
  } catch {
    // fall through
  }
  return `image.${ext}`;
}

/** Decodes a data: URL into bytes and a content type. */
export function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(dataUrl ?? "");
  if (!match) throw new Error("PopNow could not read this image.");
  const contentType = (match[1] || "application/octet-stream").toLowerCase();
  const isBase64 = /;base64/i.test(match[2]);
  let bytes;
  if (isBase64) {
    const binary = atob(match[3]);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(match[3]));
  }
  return { contentType, bytes };
}

/**
 * Runs inside the page (chrome.scripting.executeScript), so it must not use anything from this
 * module. Reads the image the user right-clicked with the page's own access (cookies, blob: URLs),
 * and falls back to drawing the image that is already on screen.
 */
export async function grabImageInPage(srcUrl, maxBytes) {
  const toDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  try {
    const response = await fetch(srcUrl, { credentials: "include" });
    if (response.ok) {
      const blob = await response.blob();
      if (blob.size > maxBytes) return { error: "too_large" };
      if (blob.type.startsWith("image/")) return { dataUrl: await toDataUrl(blob) };
    }
  } catch {
    // Cross-origin images without CORS land here; try the copy on screen.
  }
  try {
    const image = [...document.images].find((img) => img.currentSrc === srcUrl || img.src === srcUrl);
    if (image && image.naturalWidth > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);
      return { dataUrl: canvas.toDataURL("image/png") };
    }
  } catch {
    // A tainted canvas: the page does not let other code read this image.
  }
  return { error: "unreadable" };
}
