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

  constructor(code: KenariErrorCode, message: string, status: number, body: string) {
    super(message);
    this.name = "KenariError";
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

export type FetchImpl = typeof fetch;
export type ErrorContext = "models" | "image" | "edit" | "video";

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
  if (status === 401) return "unauthorized";
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
): KenariError {
  const code = classifyError(status, bodyText, context);
  return new KenariError(code, `${code}: ${redact(extractMessage(bodyText))}`, status, bodyText);
}

export function authHeaders(cfg: KenariConfig): Record<string, string> {
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
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

export async function postJson(
  path: string,
  cfg: KenariConfig,
  body: unknown,
  opts: CallOpts,
): Promise<OkBody> {
  const f = opts.fetchImpl ?? fetch;
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  let res: Response;
  try {
    res = await f(cfg.baseUrl + path, {
      method: "POST",
      headers: { ...authHeaders(cfg), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw networkError(path, e);
  }
  const { text, parsed } = await readResponseBody(res);
  if (!res.ok) throw toKenariError(res.status, text, opts.context);
  return { status: res.status, text, parsed };
}

export async function getJson(path: string, cfg: KenariConfig, opts: CallOpts): Promise<OkBody> {
  const f = opts.fetchImpl ?? fetch;
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  let res: Response;
  try {
    res = await f(cfg.baseUrl + path, {
      method: "GET",
      headers: { ...authHeaders(cfg) },
      signal,
    });
  } catch (e) {
    throw networkError(path, e);
  }
  const { text, parsed } = await readResponseBody(res);
  if (!res.ok) throw toKenariError(res.status, text, opts.context);
  return { status: res.status, text, parsed };
}

export async function postMultipart(
  path: string,
  cfg: KenariConfig,
  form: FormData,
  opts: CallOpts,
): Promise<OkBody> {
  const f = opts.fetchImpl ?? fetch;
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  let res: Response;
  try {
    // Do NOT set Content-Type manually — fetch sets the multipart boundary.
    res = await f(cfg.baseUrl + path, {
      method: "POST",
      headers: { ...authHeaders(cfg) },
      body: form,
      signal,
    });
  } catch (e) {
    throw networkError(path, e);
  }
  const { text, parsed } = await readResponseBody(res);
  if (!res.ok) throw toKenariError(res.status, text, opts.context);
  return { status: res.status, text, parsed };
}

/** GET bytes (video content download, or image URLs returned by the API). */
export async function getBytes(
  url: string,
  opts: { fetchImpl?: FetchImpl; apiKey?: string; timeoutMs?: number } = {},
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const f = opts.fetchImpl ?? fetch;
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  let res: Response;
  try {
    res = await f(url, {
      method: "GET",
      headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {},
      signal,
    });
  } catch (e) {
    throw networkError(url, e);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw toKenariError(res.status, text, "video");
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
