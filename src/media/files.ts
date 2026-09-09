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

/**
 * Magic-byte sniffing: returns an extension from the file's leading bytes, or
 * null when the format is unrecognized. Detection covers PNG, JPEG, GIF,
 * WebP (RIFF....WEBP), MP4/MOV (ftyp with brand/variant), WebM/Matroska.
 */
export function sniffExtFromBytes(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes || bytes.length < 6) return null;
  const b = bytes;
  const ascii = (start: number, len: number): string =>
    Buffer.from(b.slice(start, start + len)).toString("latin1");
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ".png";
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
  // GIF: GIF87a / GIF89a
  const gif = ascii(0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return ".gif";
  if (b.length >= 12) {
    // RIFF container: WebP (RIFF....WEBP)
    if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return ".webp";
    // ISO-BMFF container: ftyp at offset 4 — MP4 brands vs MOV variants.
    if (ascii(4, 4) === "ftyp") {
      const brand = ascii(8, 4).toLowerCase();
      if (brand === "qt  " || /^(m4v|m4a|moov|trak|msnh|cmfc)/.test(brand)) return ".mov";
      return ".mp4";
    }
  }
  // WebM / Matroska: EBML header 1A 45 DF A3
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ".webm";
  return null;
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
