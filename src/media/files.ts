import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/** Strip Windows-illegal filename chars (<>:"/\|?* + control chars). */
export function sanitizeFilename(name: string): string {
  let s = String(name ?? "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  s = s.replace(/[. ]+$/g, "");
  s = s.trim();
  if (!s || /^\.+$/.test(s)) s = "file";
  if (s.length > 100) s = s.slice(0, 100);
  return s;
}

/** Unique name: sanitized base + timestamp + short hash + ext. */
export function uniqueFilename(base: string, ext: string): string {
  const safe = sanitizeFilename(base);
  const suffix = ext.startsWith(".") ? ext : `.${ext}`;
  const hash = createHash("sha256")
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 8);
  return `${safe}-${Date.now()}-${hash}${suffix}`;
}

export function resolveOutputDir(dir: string): string {
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
}

/** mkdir recursive + write. Returns the absolute path of the saved file. */
export async function saveBytes(
  outputDir: string,
  base: string,
  ext: string,
  data: Uint8Array,
): Promise<string> {
  const dir = resolveOutputDir(outputDir);
  await mkdir(dir, { recursive: true });
  const abs = path.join(dir, uniqueFilename(base, ext));
  await writeFile(abs, data);
  return abs;
}

export function extFromContentType(contentType: string | null, fallback: string): string {
  if (contentType) {
    const m = /(?:image|video)\/(png|jpe?g|webp|gif|mp4|webm|mov|m4v)/i.exec(contentType);
    if (m) {
      const t = m[1].toLowerCase();
      if (t === "jpeg" || t === "jpg") return contentType.toLowerCase().startsWith("video") ? ".m4v" : ".jpg";
      return `.${t}`;
    }
  }
  return fallback.startsWith(".") ? fallback : `.${fallback}`;
}

/** Parse data: URLs (data:image/png;base64,...). Returns null when not a data URL. */
export function bytesFromDataUrl(url: string): { bytes: Uint8Array; ext: string } | null {
  const m = /^data:(image|video)\/([a-z0-9+.-]+);base64,([\s\S]*)$/i.exec(url.trim());
  if (!m) return null;
  const kind = m[1].toLowerCase();
  let subtype = m[2].toLowerCase();
  if (subtype === "jpeg") subtype = kind === "video" ? "m4v" : "jpg";
  else if (subtype === "jpg" && kind === "video") subtype = "m4v";
  return { bytes: Buffer.from(m[3].replace(/\s+/g, ""), "base64"), ext: `.${subtype}` };
}
