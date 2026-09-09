import { readFile } from "node:fs/promises";

export type VideoStatusName = "queued" | "rendering" | "done" | "failed" | "expired";

export interface VideoStatus {
  raw: VideoStatusName | string;
  normalized: "rendering" | "done" | "failed" | "expired";
  /** Direct content/download URL when the status payload exposes one. */
  contentUrl?: string;
}

/** Normalise the many shapes Kenari uses for video job status. */
export function normalizeVideoStatus(raw: unknown): VideoStatus {
  if (!raw || typeof raw !== "object") return { raw: "unknown", normalized: "rendering" };
  const o = raw as Record<string, unknown>;
  const candidates = [o.status, o.state, o.job_status, o.video_status, o.phase].filter(
    (v): v is string => typeof v === "string",
  );
  const data =
    o.data && typeof o.data === "object" ? (o.data as Record<string, unknown>) : undefined;
  if (data) {
    for (const k of ["status", "state", "job_status", "video_status", "phase"]) {
      if (typeof data[k] === "string") candidates.push(data[k] as string);
    }
  }
  const lowered = candidates.map((s) => s.toLowerCase());
  let name: VideoStatusName | string = "unknown";
  let normalized: VideoStatus["normalized"] = "rendering";
  if (lowered.some((s) => /expired|not_found|gone/.test(s))) {
    name = "expired";
    normalized = "expired";
  } else if (lowered.some((s) => /fail|error|cancel/.test(s))) {
    name = "failed";
    normalized = "failed";
  } else if (
    lowered.some((s) => /succeed|complete|ready|done|available|finished/.test(s)) ||
    findContentUrl(o) !== undefined
  ) {
    name = "done";
    normalized = "done";
  } else if (lowered.length > 0) {
    name = candidates[0];
    normalized = "rendering";
  }
  const contentUrl = findContentUrl(o) ?? findContentUrl(data);
  return { raw: name, normalized, contentUrl };
}

function findContentUrl(o: Record<string, unknown> | undefined): string | undefined {
  if (!o) return undefined;
  const keys = ["url", "video_url", "download_url", "content_url", "output_url", "result_url"];
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  for (const k of ["video", "result", "output", "data"]) {
    const v = o[k];
    if (v && typeof v === "object") {
      const found = findContentUrl(v as Record<string, unknown>);
      if (found) return found;
      const arr = (v as Record<string, unknown>).urls;
      if (Array.isArray(arr) && typeof arr[0] === "string" && /^https?:\/\//i.test(arr[0])) {
        return arr[0];
      }
    }
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  return undefined;
}

/** True when the value is an http(s) URL. Local paths and data: URLs are false. */
export function isHttpUrl(value: string): boolean {
  const v = String(value ?? "").trim();
  // Windows drive-letter paths (C:\x, D:/x) are NOT urls despite the colon.
  if (/^[a-zA-Z]:[\\/]/.test(v)) return false;
  return /^(https?):\/\//i.test(v);
}

/** True when the value looks like a local filesystem path (win/unix absolute or relative). */
export function isLocalPath(value: string): boolean {
  const v = String(value ?? "").trim();
  if (!v || isHttpUrl(v) || /^data:/i.test(v)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(v) || v.startsWith("\\\\")) return true;
  if (v.startsWith("/") || /^\.{1,2}[\\/]/.test(v)) return true;
  // Relative paths must contain a separator; bare ids (job_abc123) are not paths.
  if (/[\\/]/.test(v) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) return true;
  return false;
}

export function looksLikeJobId(value: string): boolean {
  const v = String(value ?? "").trim();
  return v.length > 0 && !isHttpUrl(v) && !isLocalPath(v) && !v.includes(" ");
}

export function mimeForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

/** Read a local image file into a File for multipart upload. */
export async function fileFromPath(pathValue: string): Promise<File> {
  const bytes = await readFile(pathValue);
  const filename = pathValue.split(/[\\/]/).pop() || "image";
  return new File([bytes], filename, { type: mimeForFilename(filename) });
}
