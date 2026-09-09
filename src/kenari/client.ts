import { getConfig, redact, type KenariConfig } from "../config.js";

export type KenariErrorCode =
  | "unauthorized"
  | "insufficient_balance"
  | "content_policy_violation"
  | "rate_limited"
  | "invalid_model"
  | "video_failed"
  | "video_expired"
  | "still_rendering"
  | "bad_request"
  | "upstream_error";

export class KenariError extends Error {
  code: KenariErrorCode;
  status: number;
  body: string;
  /** Parsed Retry-After value (ms, capped) when the error was an HTTP 429. */
  retryAfterMs?: number;

  constructor(
    code: KenariErrorCode,
    message: string,
    status: number,
    body: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "KenariError";
    this.code = code;
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

export type FetchImpl = typeof fetch;
export type ErrorContext = "models" | "image" | "edit" | "video" | "cdn";

/**
 * Parse a response body. Kenari's 401 is PLAIN TEXT and image POSTs may be
 * prefixed with ASCII-space heartbeats — so always read text first, trim, and
 * only then JSON.parse. Never assume JSON (especially on errors).
 */
export function parseBodyText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

export async function readResponseBody(res: Response): Promise<{ text: string; parsed: unknown }> {
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = parseBodyText(text);
  } catch {
    parsed = null;
  }
  return { text, parsed };
}

export function classifyError(
  status: number,
  bodyText: string,
  context: ErrorContext,
): KenariErrorCode {
  const lower = (bodyText ?? "").toLowerCase();
  // CDN-context 401 means the (unauthenticated) CDN rejected us — NOT a key
  // failure. Only API-origin 401 maps to "unauthorized".
  if (status === 401) return context === "cdn" ? "upstream_error" : "unauthorized";
  if (
    status === 402 ||
    lower.includes("insufficient_balance") ||
    lower.includes("insufficient balance") ||
    lower.includes("insufficient funds") ||
    lower.includes("not enough balance") ||
    lower.includes("balance too low") ||
    lower.includes("top up") ||
    lower.includes("topup")
  ) {
    return "insufficient_balance";
  }
  if (status === 429 || (status === 403 && lower.includes("rate"))) return "rate_limited";
  if (
    lower.includes("content policy") ||
    lower.includes("content_policy") ||
    lower.includes("contentpolicy") ||
    lower.includes("moderation") ||
    lower.includes("prohibited content") ||
    lower.includes("blocked by safety") ||
    lower.includes("safety violation")
  ) {
    return "content_policy_violation";
  }
  if (status === 404 && context === "video") return "video_expired";
  if (status === 404 || status === 400) {
    if (lower.includes("model")) return "invalid_model";
    return "bad_request";
  }
  if (status === 422) return "bad_request";
  if (status >= 500) return "upstream_error";
  return "bad_request";
}

function extractMessage(bodyText: string): string {
  const raw = (bodyText ?? "").trim();
  if (!raw) return "empty response body";
  try {
    const parsed = parseBodyText(bodyText) as Record<string, unknown> | string | null;
    if (parsed === null) return raw.slice(0, 500);
    if (typeof parsed === "string") return parsed.slice(0, 500);
    if (typeof parsed === "object") {
      const err = (parsed as Record<string, unknown>).error;
      if (typeof err === "string" && err) return err.slice(0, 500);
      if (err && typeof err === "object") {
        const msg = (err as Record<string, unknown>).message;
        if (typeof msg === "string" && msg) return msg.slice(0, 500);
      }
      const msg = (parsed as Record<string, unknown>).message;
      if (typeof msg === "string" && msg) return msg.slice(0, 500);
      return JSON.stringify(parsed).slice(0, 500);
    }
    return raw.slice(0, 500);
  } catch {
    // Plain-text error body (e.g. 401) — use as-is, never assume JSON.
    return raw.slice(0, 500);
  }
}

export function toKenariError(
  status: number,
  bodyText: string,
  context: ErrorContext,
  retryAfterMs?: number,
): KenariError {
  const code = classifyError(status, bodyText, context);
  return new KenariError(code, `${code}: ${redact(extractMessage(bodyText))}`, status, bodyText, retryAfterMs);
}

/**
 * Retry-After scoping: only a final HTTP 429 may carry retryAfterMs. A retry
 * that failed with a different status must NOT inherit the first 429's value;
 * a retried 429 uses its own Retry-After header when present.
 */
function retryAfterForFinal(
  finalStatus: number,
  finalHeader: string | null,
  firstAttemptMs: number | undefined,
): number | undefined {
  if (finalStatus !== 429) return undefined;
  return finalHeader !== null ? parseRetryAfterMs(finalHeader) : firstAttemptMs;
}

/**
 * Parse the Retry-After header (seconds or HTTP-date) into a wait duration in
 * ms, capped at MAX_RETRY_AFTER_MS (30s). Returns DEFAULT_RETRY_AFTER_MS
 * (1000ms) when the header is missing or unparseable.
 */
export const MAX_RETRY_AFTER_MS = 30_000;
export const DEFAULT_RETRY_AFTER_MS = 1_000;

export function parseRetryAfterMs(value: string | null): number {
  if (!value) return DEFAULT_RETRY_AFTER_MS;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_RETRY_AFTER_MS;
  if (/^\d+$/.test(trimmed)) {
    const secs = Number.parseInt(trimmed, 10);
    return Math.min(secs > 0 ? secs * 1000 : DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return Math.min(delta, MAX_RETRY_AFTER_MS);
    return DEFAULT_RETRY_AFTER_MS;
  }
  return DEFAULT_RETRY_AFTER_MS;
}

export function authHeaders(cfg: KenariConfig): Record<string, string> {
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
}

/**
 * True when `target` and `base` share the exact hostname (case-insensitive,
 * port-agnostic — so self-hosted bases with ports keep working). False when
 * either URL is missing or unparseable. Used to gate Bearer auth to the
 * configured Kenari origin only.
 */
export function hostMatches(target: string | undefined, base: string | undefined): boolean {
  if (!target || !base) return false;
  try {
    return new URL(target).hostname.toLowerCase() === new URL(base).hostname.toLowerCase();
  } catch {
    return false;
  }
}

export interface OkBody {
  status: number;
  text: string;
  parsed: unknown;
}

interface CallOpts {
  context: ErrorContext;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

function networkError(path: string, e: unknown): KenariError {
  const name = (e as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new KenariError("upstream_error", `upstream_error: request timed out (${path})`, 0, "");
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new KenariError("upstream_error", `upstream_error: ${redact(msg)}`, 0, "");
}

/**
 * Sleep for the 429 Retry-After wait. Honors the request signal so an
 * expiring AbortSignal.timeout aborts the wait instead of extending it.
 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function postJson(
  path: string,
  cfg: KenariConfig,
  body: unknown,
  opts: CallOpts,
): Promise<OkBody> {
  const f = opts.fetchImpl ?? fetch;
  const url = cfg.baseUrl + path;
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: { ...authHeaders(cfg), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw networkError(path, e);
  }
  let retryAfterMs: number | undefined;
  if (res.status === 429) {
    retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    await res.text().catch(() => ""); // drain body before retry
    await sleepAbortable(retryAfterMs, signal);
    try {
      res = await f(url, {
        method: "POST",
        headers: { ...authHeaders(cfg), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw networkError(path, e);
    }
  }
  const { text, parsed } = await readResponseBody(res);
  if (!res.ok) throw toKenariError(res.status, text, opts.context, retryAfterForFinal(res.status, res.headers.get("retry-after"), retryAfterMs));
  return { status: res.status, text, parsed };
}

export async function getJson(path: string, cfg: KenariConfig, opts: CallOpts): Promise<OkBody> {
  const f = opts.fetchImpl ?? fetch;
  const url = cfg.baseUrl + path;
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  let res: Response;
  try {
    res = await f(url, {
      method: "GET",
      headers: { ...authHeaders(cfg) },
      signal,
    });
  } catch (e) {
    throw networkError(path, e);
  }
  let retryAfterMs: number | undefined;
  if (res.status === 429) {
    retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    await res.text().catch(() => ""); // drain body before retry
    await sleepAbortable(retryAfterMs, signal);
    try {
      res = await f(url, {
        method: "GET",
        headers: { ...authHeaders(cfg) },
        signal,
      });
    } catch (e) {
      throw networkError(path, e);
    }
  }
  const { text, parsed } = await readResponseBody(res);
  if (!res.ok) throw toKenariError(res.status, text, opts.context, retryAfterForFinal(res.status, res.headers.get("retry-after"), retryAfterMs));
  return { status: res.status, text, parsed };
}

export async function postMultipart(
  path: string,
  cfg: KenariConfig,
  form: FormData,
  opts: CallOpts,
): Promise<OkBody> {
  const f = opts.fetchImpl ?? fetch;
  const url = cfg.baseUrl + path;
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  let res: Response;
  try {
    // Do NOT set Content-Type manually — fetch sets the multipart boundary.
    res = await f(url, {
      method: "POST",
      headers: { ...authHeaders(cfg) },
      body: form,
      signal,
    });
  } catch (e) {
    throw networkError(path, e);
  }
  let retryAfterMs: number | undefined;
  if (res.status === 429) {
    retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    await res.text().catch(() => ""); // drain body before retry
    await sleepAbortable(retryAfterMs, signal);
    try {
      // Do NOT set Content-Type manually — fetch sets the multipart boundary.
      res = await f(url, {
        method: "POST",
        headers: { ...authHeaders(cfg) },
        body: form,
        signal,
      });
    } catch (e) {
      throw networkError(path, e);
    }
  }
  const { text, parsed } = await readResponseBody(res);
  if (!res.ok) throw toKenariError(res.status, text, opts.context, retryAfterForFinal(res.status, res.headers.get("retry-after"), retryAfterMs));
  return { status: res.status, text, parsed };
}

/** GET bytes (video content download, or image URLs returned by the API). */
export async function getBytes(
  url: string,
  opts: { fetchImpl?: FetchImpl; apiKey?: string; baseUrl?: string; timeoutMs?: number } = {},
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const f = opts.fetchImpl ?? fetch;
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  // Host gate: attach the Bearer key ONLY when the target URL host matches the
  // configured Kenari base URL host. Third-party CDN URLs (returned by the API)
  // are fetched unauthenticated so the key never leaves the Kenari origin.
  // CDN non-2xx is reclassified as upstream/CDN error — never "unauthorized".
  const isApiOrigin = hostMatches(url, opts.baseUrl);
  const headers: Record<string, string> =
    opts.apiKey && isApiOrigin ? { Authorization: `Bearer ${opts.apiKey}` } : {};
  let res: Response;
  try {
    res = await f(url, {
      method: "GET",
      headers,
      signal,
    });
  } catch (e) {
    throw networkError(url, e);
  }
  let retryAfterMs: number | undefined;
  if (res.status === 429) {
    retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    await res.text().catch(() => ""); // drain body before retry
    await sleepAbortable(retryAfterMs, signal);
    try {
      res = await f(url, {
        method: "GET",
        headers,
        signal,
      });
    } catch (e) {
      throw networkError(url, e);
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const context: ErrorContext = isApiOrigin ? "video" : "cdn";
    throw toKenariError(res.status, text, context, retryAfterForFinal(res.status, res.headers.get("retry-after"), retryAfterMs));
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return { bytes: buf, contentType: res.headers.get("content-type") };
}

/** GET /v1/models is public. Returns the raw model array from the envelope. */
export async function fetchModels(
  cfg: KenariConfig,
  fetchImpl?: FetchImpl,
): Promise<Array<Record<string, unknown>>> {
  const { parsed } = await getJson("/models", cfg, { context: "models", fetchImpl });
  const data = (parsed as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new KenariError(
      "upstream_error",
      "upstream_error: unexpected /models envelope (missing data array)",
      200,
      "",
    );
  }
  return data as Array<Record<string, unknown>>;
}

export function defaultConfig(): KenariConfig {
  return getConfig();
}
