import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Optional .env loader (no dependency): fills process.env from ./.env only for unset keys. */
let dotenvLoaded = false;
function loadDotEnvOnce(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  try {
    const p = path.resolve(process.cwd(), ".env");
    if (!existsSync(p)) return;
    const text = readFileSync(p, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const body = line.startsWith("export ") ? line.slice(7).trimStart() : line;
      const eq = body.indexOf("=");
      if (eq <= 0) continue;
      const key = body.slice(0, eq).trim();
      let val = body.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // .env is optional; ignore read/parse failures.
  }
}

loadDotEnvOnce();

export interface KenariConfig {
  baseUrl: string;
  apiKey: string | undefined;
  outputDir: string;
  allowVideo: boolean;
  maxImageN: number;
  maxVideoDuration: number;
  maxCostIdrPerCall: number | undefined;
  imageTimeoutMs: number;
}

const VIDEO_DISABLED = new Set(["0", "false", "no", "off"]);

/**
 * Parse a non-negative integer env var. Unset/garbage/zero/negative all mean
 * "not set" -> default. Warns (stderr) when a value was provided but is not a
 * positive integer (negatives and 0 previously locked out tools or behaved
 * inconsistently). No throw: config is re-read lazily per call and the
 * codebase is fail-open.
 */
function clampPositiveInt(
  raw: string | undefined,
  fallback: number,
  label: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(
      `[kenari-media-mcp] config: ${label}="${raw}" is not a positive integer; using default ${fallback}.`,
    );
    return fallback;
  }
  return n;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): KenariConfig {
  const allowRaw = env.KENARI_ALLOW_VIDEO;
  const maxImageN = clampPositiveInt(env.KENARI_MAX_IMAGE_N, 4, "KENARI_MAX_IMAGE_N");
  const maxVideoDuration = clampPositiveInt(env.KENARI_MAX_VIDEO_DURATION, 15, "KENARI_MAX_VIDEO_DURATION");
  const maxCostRaw = env.KENARI_MAX_COST_IDR_PER_CALL;
  // KENARI_MAX_COST_IDR_PER_CALL is optional (absent = no cap); when set it
  // must be a positive integer — non-positive values fall back to "unset"
  // (fail-open) with a warning instead of silently blocking every tool call.
  let maxCostIdrPerCall: number | undefined;
  if (maxCostRaw !== undefined && maxCostRaw !== "") {
    const n = Number.parseInt(maxCostRaw, 10);
    if (Number.isFinite(n) && n > 0) maxCostIdrPerCall = n;
    else
      console.error(
        `[kenari-media-mcp] config: KENARI_MAX_COST_IDR_PER_CALL="${maxCostRaw}" is not a positive integer; ignoring (no cost cap).`,
      );
  }
  return {
    baseUrl: (env.KENARI_BASE_URL ?? "https://kenari.id/v1").replace(/\/+$/, ""),
    apiKey: env.KENARI_API_KEY || undefined,
    outputDir: env.KENARI_OUTPUT_DIR || "./kenari-output",
    allowVideo:
      allowRaw === undefined || allowRaw === ""
        ? true
        : !VIDEO_DISABLED.has(allowRaw.toLowerCase()),
    maxImageN,
    maxVideoDuration,
    maxCostIdrPerCall,
    imageTimeoutMs: 300_000,
  };
}

/** Redact API-key-like values (kn- prefix) anywhere in a string. Never log raw keys. */
export function redact(value: string): string {
  return String(value).replace(/kn-[A-Za-z0-9_.-]+/g, "[REDACTED]");
}
