import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getConfig, type KenariConfig } from "./config.js";
import {
  fetchModels,
  getBytes,
  getJson,
  postJson,
  postMultipart,
  KenariError,
  type FetchImpl,
} from "./kenari/client.js";
import {
  filterModels,
  imageCostIdr,
  isImageModel,
  isVideoGenModel,
  type KenariModel,
} from "./kenari/catalog.js";
import {
  bytesFromDataUrl,
  extFromContentType,
  saveBytes,
} from "./media/files.js";
import {
  fileFromPath,
  isHttpUrl,
  isLocalPath,
  normalizeVideoStatus,
} from "./media/video.js";
import {
  createVideoOutputSchema,
  createVideoSchema,
  downloadVideoOutputSchema,
  downloadVideoSchema,
  editImageOutputSchema,
  editImageSchema,
  extendVideoOutputSchema,
  extendVideoSchema,
  generateImageOutputSchema,
  generateImageSchema,
  getVideoStatusOutputSchema,
  getVideoStatusSchema,
  listMediaModelsOutputSchema,
  listMediaModelsSchema,
  waitForVideoOutputSchema,
  waitForVideoSchema,
} from "./tools/schemas.js";

export interface ToolResult {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export function ok(text: string, structured: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: structured };
}

export function err(
  text: string,
  structured: Record<string, unknown>,
  isError = true,
) {
  return {
    content: [{ type: "text" as const, text }],
    isError: (isError ? true : undefined) as true | undefined,
    structuredContent: structured,
  };
}

export function errFromKenari(e: unknown, fallbackOp: string) {
  if (e instanceof KenariError) {
    return err(`${e.code}: ${e.message}`, {
      code: e.code,
      status: e.status,
      op: fallbackOp,
    });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return err(`upstream_error: ${msg}`, { code: "upstream_error", op: fallbackOp });
}

function videoDisabled(text = "Video tools are disabled (KENARI_ALLOW_VIDEO=0).") {
  return err(text, { code: "bad_request", disabled: true });
}

export function requireApiKey(cfg: KenariConfig) {
  if (!cfg.apiKey) {
    return err("unauthorized: KENARI_API_KEY is not set.", {
      code: "unauthorized",
      hint: "Set KENARI_API_KEY in the environment.",
    });
  }
  return null;
}

/** Warn (stderr) when no key is configured — list_media_models still works (public). */
export function warnNoKey(cfg: KenariConfig, op: string): void {
  if (!cfg.apiKey) console.error(`[kenari-media-mcp] ${op}: KENARI_API_KEY not set.`);
}

export interface ServerDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  modelList?: () => Promise<Array<Record<string, unknown>>>;
  sleepMs?: (ms: number) => Promise<void>;
}

export function getDepsFetch(deps: ServerDeps | undefined): FetchImpl | undefined {
  return deps?.fetchImpl;
}

const sleepDefault = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Download a remote URL or decode a data: URL into saved files. Returns absolute paths. */
async function saveFromUrlOrData(
  cfg: KenariConfig,
  url: string,
  base: string,
  fallbackExt: string,
  fetchImpl?: FetchImpl,
): Promise<{ paths: string[]; ext: string }> {
  const data = bytesFromDataUrl(url);
  if (data) {
    const p = await saveBytes(cfg.outputDir, base, data.ext, data.bytes);
    return { paths: [p], ext: data.ext };
  }
  const { bytes, contentType } = await getBytes(url, {
    fetchImpl,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.imageTimeoutMs,
  });
  const ext = extFromContentType(contentType, fallbackExt);
  const p = await saveBytes(cfg.outputDir, base, ext, bytes);
  return { paths: [p], ext };
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: "kenari-media-mcp", version: "0.1.0" });
  const cfgOf = (): KenariConfig => getConfig(deps.env ?? process.env);
  const sleep = deps.sleepMs ?? sleepDefault;

  /**
   * PRE-flight cost cap: estimate (per-image IDR from catalog pricing_lines *
   * n) BEFORE any Kenari POST. Returns an err ToolResult when over the cap,
   * null when allowed. Unknown model/price never blocks (stderr warning).
   */
  async function preflightCostCap(
    cfg: KenariConfig,
    model: string,
    n: number,
    op: string,
  ): Promise<ReturnType<typeof err> | null> {
    if (cfg.maxCostIdrPerCall === undefined) return null;
    let raw: Array<Record<string, unknown>>;
    try {
      raw = await (deps.modelList
        ? deps.modelList()
        : fetchModels(cfg, getDepsFetch(deps)));
    } catch {
      return null; // Catalog lookup is best-effort; never block on lookup failure.
    }
    const found = (raw as unknown as KenariModel[]).find((m) => m.id === model);
    const per = found ? imageCostIdr(found) : undefined;
    if (per === undefined) {
      console.error(`[kenari-media-mcp] ${op}: no catalog price for model ${model}; skipping cost cap.`);
      return null;
    }
    const estimate = per * n;
    if (estimate > cfg.maxCostIdrPerCall) {
      return err(
        `bad_request: estimated cost ${estimate} IDR exceeds KENARI_MAX_COST_IDR_PER_CALL=${cfg.maxCostIdrPerCall}.`,
        { code: "bad_request", op },
      );
    }
    return null;
  }

  // ---------------------------------------------------------------- 1. list
  server.registerTool(
    "list_media_models",
    {
      title: "List Kenari Media Models",
      description:
        "List Kenari media-capable models (image/video). Public, no key needed.",
      inputSchema: listMediaModelsSchema,
      outputSchema: listMediaModelsOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      const cfg = cfgOf();
      try {
        const raw = await (deps.modelList
          ? deps.modelList()
          : fetchModels(cfg, getDepsFetch(deps)));
        const models = raw as unknown as KenariModel[];
        const filtered = filterModels(models, args.modality);
        const items = filtered.map((m) => ({
          id: m.id,
          owned_by: m.owned_by,
          endpoints: m.endpoints,
          modalities: m.modalities,
          cost_idr_per_image: isImageModel(m) ? (imageCostIdr(m) ?? null) : null,
        }));
        const imageCount = filtered.filter(isImageModel).length;
        const videoCount = filtered.filter(isVideoGenModel).length;
        const text =
          `Kenari media models (${items.length}; image=${imageCount}, video=${videoCount})` +
          (args.modality ? ` [modality=${args.modality}]` : "") +
          ":\n" +
          items
            .map(
              (i) =>
                `- ${i.id}${i.owned_by ? ` (${i.owned_by})` : ""}` +
                (typeof i.cost_idr_per_image === "number"
                  ? ` ${i.cost_idr_per_image} IDR/image`
                  : ""),
            )
            .join("\n");
        return ok(text, { models: items });
      } catch (e) {
        return errFromKenari(e, "list_media_models");
      }
    },
  );

  // ------------------------------------------------------------ 2. generate
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate image(s) via POST /v1/images/generations. Saves PNG/JPG to KENARI_OUTPUT_DIR and returns absolute path(s). Costs IDR per image — check list_media_models first.",
      inputSchema: generateImageSchema,
      outputSchema: generateImageOutputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      const cfg = cfgOf();
      const missing = requireApiKey(cfg);
      if (missing) return missing;
      const n = args.n ?? 1;
      if (n > cfg.maxImageN) {
        return err(
          `bad_request: n=${n} exceeds KENARI_MAX_IMAGE_N=${cfg.maxImageN}.`,
          { code: "bad_request", op: "generate_image" },
        );
      }
      const body: Record<string, unknown> = { model: args.model, prompt: args.prompt, n };
      if (args.size) body.size = args.size;
      if (args.background) body.background = args.background;
      if (cfg.maxCostIdrPerCall !== undefined) {
        const blocked = await preflightCostCap(cfg, args.model, n, "generate_image");
        if (blocked) return blocked;
      }
      try {
        const { parsed } = await postJson("/images/generations", cfg, body, {
          context: "image",
          timeoutMs: cfg.imageTimeoutMs,
          fetchImpl: getDepsFetch(deps),
        });
        const saved = await saveImageResponse(cfg, parsed, args.model, getDepsFetch(deps));
        const text =
          `Generated ${saved.paths.length} image(s) with ${args.model}:\n` +
          saved.paths.map((p) => `- ${p}`).join("\n") +
          (args.preview ? "\n(preview requested — files are authoritative; no base64 returned)" : "");
        return ok(text, { model: args.model, paths: saved.paths, count: saved.paths.length });
      } catch (e) {
        return errFromKenari(e, "generate_image");
      }
    },
  );

  // ---------------------------------------------------------------- 3. edit
  server.registerTool(
    "edit_image",
    {
      title: "Edit Image",
      description:
        "Edit a local image via POST /v1/images/edits (multipart: image, mask?, prompt, model, n?, size?, background?). background=transparent is rejected (use generate_image instead).",
      inputSchema: editImageSchema,
      outputSchema: editImageOutputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      const cfg = cfgOf();
      const missing = requireApiKey(cfg);
      if (missing) return missing;
      const n = args.n ?? 1;
      if (n > cfg.maxImageN) {
        return err(
          `bad_request: n=${n} exceeds KENARI_MAX_IMAGE_N=${cfg.maxImageN}.`,
          { code: "bad_request", op: "edit_image" },
        );
      }
      if (cfg.maxCostIdrPerCall !== undefined) {
        const blocked = await preflightCostCap(cfg, args.model, n, "edit_image");
        if (blocked) return blocked;
      }
      try {
        const form = new FormData();
        const imageFile = await fileFromPath(args.image_path);
        form.append("image", imageFile, imageFile.name);
        if (args.mask_path) {
          const maskFile = await fileFromPath(args.mask_path);
          form.append("mask", maskFile, maskFile.name);
        }
        form.append("prompt", args.prompt);
        form.append("model", args.model);
        form.append("n", String(n));
        if (args.size) form.append("size", args.size);
        if (args.background) form.append("background", args.background);
        const { parsed } = await postMultipart("/images/edits", cfg, form, {
          context: "edit",
          timeoutMs: cfg.imageTimeoutMs,
          fetchImpl: getDepsFetch(deps),
        });
        const saved = await saveImageResponse(cfg, parsed, args.model, getDepsFetch(deps));
        const text =
          `Edited ${saved.paths.length} image(s) with ${args.model}:\n` +
          saved.paths.map((p) => `- ${p}`).join("\n");
        return ok(text, { model: args.model, paths: saved.paths, count: saved.paths.length });
      } catch (e) {
        // Local file errors should surface as bad_request, not upstream.
        if (e instanceof KenariError) return errFromKenari(e, "edit_image");
        const msg = e instanceof Error ? e.message : String(e);
        if (/ENOENT|no such file/i.test(msg)) {
          return err(`bad_request: image file not found: ${args.image_path}`, {
            code: "bad_request",
            op: "edit_image",
          });
        }
        return errFromKenari(e, "edit_image");
      }
    },
  );

  // ------------------------------------------------------------- 4. create
  server.registerTool(
    "create_video",
    {
      title: "Create Video",
      description:
        "Start a Kenari video job via POST /v1/videos/generations. Returns job id; poll with get_video_status/wait_for_video. Costs money.",
      inputSchema: createVideoSchema,
      outputSchema: createVideoOutputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      const cfg = cfgOf();
      if (!cfg.allowVideo) return videoDisabled();
      const missing = requireApiKey(cfg);
      if (missing) return missing;
      if (args.duration !== undefined && args.duration > cfg.maxVideoDuration) {
        return err(
          `bad_request: duration=${args.duration}s exceeds KENARI_MAX_VIDEO_DURATION=${cfg.maxVideoDuration}.`,
          { code: "bad_request", op: "create_video" },
        );
      }
      const body: Record<string, unknown> = { model: args.model, prompt: args.prompt };
      for (const k of [
        "duration",
        "resolution",
        "image_url",
        "end_image_url",
        "input_images",
        "video_url",
        "aspect_ratio",
      ] as const) {
        const v = args[k];
        if (v !== undefined) body[k] = v;
      }
      try {
        const { parsed } = await postJson("/videos/generations", cfg, body, {
          context: "video",
          timeoutMs: cfg.imageTimeoutMs,
          fetchImpl: getDepsFetch(deps),
        });
        const id = extractVideoId(parsed);
        const text = id
          ? `Video job created: ${id} (model ${args.model}). Poll get_video_status.`
          : `Video job submitted (model ${args.model}). Response: ${JSON.stringify(parsed).slice(0, 300)}`;
        return ok(text, { id, model: args.model, raw: parsed as Record<string, unknown> });
      } catch (e) {
        return errFromKenari(e, "create_video");
      }
    },
  );

  // ------------------------------------------------------------- 5. extend
  server.registerTool(
    "extend_video",
    {
      title: "Extend Video",
      description:
        "Extend a finished video via POST /v1/videos/extensions {model, video:{url}, prompt?, duration?}. source is a job id or https URL — local paths are rejected before any HTTP call.",
      inputSchema: extendVideoSchema,
      outputSchema: extendVideoOutputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      const cfg = cfgOf();
      if (!cfg.allowVideo) return videoDisabled();
      const missing = requireApiKey(cfg);
      if (missing) return missing;
      if (isLocalPath(args.source)) {
        return err(
          `bad_request: source looks like a local path (${args.source}). extend_video needs a Kenari job id or https URL — upload elsewhere or use download_video output URLs.`,
          { code: "bad_request", op: "extend_video" },
        );
      }
      if (args.duration !== undefined && args.duration > cfg.maxVideoDuration) {
        return err(
          `bad_request: duration=${args.duration}s exceeds KENARI_MAX_VIDEO_DURATION=${cfg.maxVideoDuration}.`,
          { code: "bad_request", op: "extend_video" },
        );
      }
      const videoRef = isHttpUrl(args.source)
        ? args.source
        : await resolveJobToUrl(args.source, cfg, getDepsFetch(deps));
      if (typeof videoRef !== "string") return videoRef; // error ToolResult
      const body: Record<string, unknown> = { model: args.model, video: { url: videoRef } };
      if (args.prompt) body.prompt = args.prompt;
      if (args.duration !== undefined) body.duration = args.duration;
      try {
        const { parsed } = await postJson("/videos/extensions", cfg, body, {
          context: "video",
          timeoutMs: cfg.imageTimeoutMs,
          fetchImpl: getDepsFetch(deps),
        });
        const id = extractVideoId(parsed);
        return ok(`Video extension job created: ${id ?? "(no id in response)"}.`, {
          id,
          model: args.model,
          raw: parsed as Record<string, unknown>,
        });
      } catch (e) {
        return errFromKenari(e, "extend_video");
      }
    },
  );

  // -------------------------------------------------------- 6. status
  server.registerTool(
    "get_video_status",
    {
      title: "Get Video Status",
      description:
        "GET /v1/videos/{id}. Reports queued/rendering/done/failed/expired. Auto-downloads to KENARI_OUTPUT_DIR when done.",
      inputSchema: getVideoStatusSchema,
      outputSchema: getVideoStatusOutputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    },
    async (args) => {
      const cfg = cfgOf();
      if (!cfg.allowVideo) return videoDisabled();
      const missing = requireApiKey(cfg);
      if (missing) return missing;
      try {
        const { parsed } = await getJson(`/videos/${encodeURIComponent(args.id)}`, cfg, {
          context: "video",
          fetchImpl: getDepsFetch(deps),
        });
        return await statusResult(args.id, parsed, cfg, true, getDepsFetch(deps));
      } catch (e) {
        return errFromKenari(e, "get_video_status");
      }
    },
  );

  // ---------------------------------------------------------- 7. wait
  server.registerTool(
    "wait_for_video",
    {
      title: "Wait For Video",
      description:
        "Poll GET /v1/videos/{id} every 5s (backoff cap 15s) until done/failed/expired or timeout (default 20 min). Auto-downloads when done. Timeout returns still_rendering with isError=false.",
      inputSchema: waitForVideoSchema,
      outputSchema: waitForVideoOutputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (args, ctx) => {
      const cfg = cfgOf();
      if (!cfg.allowVideo) return videoDisabled();
      const missing = requireApiKey(cfg);
      if (missing) return missing;
      const deadline = Date.now() + args.timeout_ms;
      let interval = 5_000;
      let attempt = 0;
      const progressToken = findProgressToken(ctx);
      for (;;) {
        attempt += 1;
        let parsed: unknown;
        try {
          ({ parsed } = await getJson(`/videos/${encodeURIComponent(args.id)}`, cfg, {
            context: "video",
            fetchImpl: getDepsFetch(deps),
          }));
        } catch (e) {
          return errFromKenari(e, "wait_for_video");
        }
        const st = normalizeVideoStatus(parsed);
        if (progressToken && ctx) {
          await safeNotify(ctx, {
            progressToken,
            progress: attempt,
            message: `poll ${attempt}: ${String(st.raw)}`,
          });
        }
        if (st.normalized !== "rendering") {
          if (st.normalized === "done" && args.download) {
            return await statusResult(args.id, parsed, cfg, true, getDepsFetch(deps));
          }
          return await statusResult(args.id, parsed, cfg, false, getDepsFetch(deps));
        }
        if (Date.now() >= deadline) {
          return {
            content: [
              {
                type: "text",
                text: `Video ${args.id} still rendering after ${args.timeout_ms} ms (poll ${attempt}). Retry wait_for_video.`,
              },
            ],
            structuredContent: { code: "still_rendering", id: args.id, status: String(st.raw) },
          };
        }
        await sleep(Math.min(interval, deadline - Date.now()));
        interval = Math.min(interval * 1.5, 15_000);
      }
    },
  );

  // -------------------------------------------------------- 8. download
  server.registerTool(
    "download_video",
    {
      title: "Download Video",
      description:
        "Download finished video bytes via GET /v1/videos/{id}/content to KENARI_OUTPUT_DIR. Errors with still_rendering while the job renders.",
      inputSchema: downloadVideoSchema,
      outputSchema: downloadVideoOutputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      const cfg = cfgOf();
      if (!cfg.allowVideo) return videoDisabled();
      const missing = requireApiKey(cfg);
      if (missing) return missing;
      try {
        const { parsed } = await getJson(`/videos/${encodeURIComponent(args.id)}`, cfg, {
          context: "video",
          fetchImpl: getDepsFetch(deps),
        });
        const st = normalizeVideoStatus(parsed);
        if (st.normalized === "rendering") {
          return err(`still_rendering: video ${args.id} is still rendering (${String(st.raw)}).`, {
            code: "still_rendering",
            id: args.id,
            status: String(st.raw),
          });
        }
        if (st.normalized === "failed") {
          return err(`video_failed: video ${args.id} failed.`, { code: "video_failed", id: args.id });
        }
        if (st.normalized === "expired") {
          return err(`video_expired: video ${args.id} expired.`, { code: "video_expired", id: args.id });
        }
        if (st.contentUrl) {
          const { paths } = await saveFromUrlOrData(cfg, st.contentUrl, `video-${args.id}`, ".mp4", getDepsFetch(deps));
          return ok(`Video ${args.id} downloaded:\n- ${paths[0]}`, {
            id: args.id,
            paths,
            status: String(st.raw),
          });
        }
        const { bytes, contentType } = await getBytes(
          `${cfg.baseUrl}/videos/${encodeURIComponent(args.id)}/content`,
          { fetchImpl: getDepsFetch(deps), apiKey: cfg.apiKey, timeoutMs: cfg.imageTimeoutMs },
        );
        const ext = extFromContentType(contentType, ".mp4");
        const p = await saveBytes(cfg.outputDir, `video-${args.id}`, ext, bytes);
        return ok(`Video ${args.id} downloaded:\n- ${p}`, { id: args.id, paths: [p] });
      } catch (e) {
        return errFromKenari(e, "download_video");
      }
    },
  );

  return server;

  // ------------------------------------------------------------- helpers
  async function saveImageResponse(
    cfg: KenariConfig,
    parsed: unknown,
    model: string,
    fetchImpl?: FetchImpl,
  ): Promise<{ paths: string[] }> {
    const urls = extractImageUrls(parsed);
    const paths: string[] = [];
    if (urls.length > 0) {
      let i = 0;
      for (const u of urls) {
        i += 1;
        const { paths: saved } = await saveFromUrlOrData(cfg, u, `img-${model}`, ".png", fetchImpl);
        paths.push(...saved.map((p) => p));
        void i;
      }
      return { paths };
    }
    // b64_json fallback
    const b64s = extractB64(parsed);
    let j = 0;
    for (const b of b64s) {
      j += 1;
      const bytes = Buffer.from(b.replace(/\s+/g, ""), "base64");
      const p = await saveBytes(cfg.outputDir, `img-${model}`, ".png", bytes);
      paths.push(p);
    }
    if (paths.length === 0) {
      throw new KenariError(
        "upstream_error",
        "upstream_error: image response contained no url/b64_json data",
        200,
        "",
      );
    }
    return { paths };
  }

  async function statusResult(
    id: string,
    parsed: unknown,
    cfg: KenariConfig,
    autoDownload: boolean,
    fetchImpl?: FetchImpl,
  ) {
    const st = normalizeVideoStatus(parsed);
    const base = { id, status: String(st.raw) };
    if (st.normalized === "rendering") {
      return ok(`Video ${id} status: ${String(st.raw)} (rendering).`, {
        ...base,
        code: "rendering",
      });
    }
    if (st.normalized === "failed") {
      return err(`video_failed: video ${id} failed (status ${String(st.raw)}).`, {
        ...base,
        code: "video_failed",
      });
    }
    if (st.normalized === "expired") {
      return err(`video_expired: video ${id} expired/not found.`, { ...base, code: "video_expired" });
    }
    // done
    if (autoDownload) {
      try {
        if (st.contentUrl) {
          const { paths } = await saveFromUrlOrData(cfg, st.contentUrl, `video-${id}`, ".mp4", fetchImpl);
          return ok(`Video ${id} done:\n- ${paths[0]}`, { ...base, code: "done", paths });
        }
        const { bytes, contentType } = await getBytes(
          `${cfg.baseUrl}/videos/${encodeURIComponent(id)}/content`,
          { fetchImpl, apiKey: cfg.apiKey, timeoutMs: cfg.imageTimeoutMs },
        );
        const ext = extFromContentType(contentType, ".mp4");
        const p = await saveBytes(cfg.outputDir, `video-${id}`, ext, bytes);
        return ok(`Video ${id} done:\n- ${p}`, { ...base, code: "done", paths: [p] });
      } catch (e) {
        if (e instanceof KenariError) {
          return err(`Video ${id} done but download failed: ${e.message}`, {
            ...base,
            code: e.code,
          });
        }
        throw e;
      }
    }
    return ok(`Video ${id} done (status ${String(st.raw)}).`, { ...base, code: "done" });
  }

  async function resolveJobToUrl(
    id: string,
    cfg: KenariConfig,
    fetchImpl?: FetchImpl,
  ): Promise<string | ReturnType<typeof err> | ReturnType<typeof errFromKenari>> {
    try {
      const { parsed } = await getJson(`/videos/${encodeURIComponent(id)}`, cfg, {
        context: "video",
        fetchImpl,
      });
      const st = normalizeVideoStatus(parsed);
      if (st.normalized !== "done" || !st.contentUrl) {
        return err(
          `bad_request: job ${id} is not downloadable (status ${String(st.raw)}). extend_video needs a finished video URL or job id.`,
          { code: "bad_request", op: "extend_video" },
        );
      }
      return st.contentUrl;
    } catch (e) {
      return errFromKenari(e, "extend_video");
    }
  }
}

function extractVideoId(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const o = parsed as Record<string, unknown>;
  for (const k of ["id", "video_id", "job_id", "jobId"]) {
    if (typeof o[k] === "string" && (o[k] as string).length > 0) return o[k] as string;
  }
  for (const k of ["video", "data", "result", "job"]) {
    const v = o[k];
    if (v && typeof v === "object") {
      const found = extractVideoId(v);
      if (found) return found;
    }
  }
  return undefined;
}

export function extractImageUrls(parsed: unknown): string[] {
  const urls: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const o = node as Record<string, unknown>;
    if (typeof o.url === "string" && o.url.length > 0) urls.push(o.url);
    for (const v of Object.values(o)) {
      if (v && typeof v === "object") walk(v);
    }
  };
  if (parsed && typeof parsed === "object") {
    const root = parsed as Record<string, unknown>;
    const data = root.data;
    if (Array.isArray(data)) {
      for (const item of data) walk(item);
    } else {
      walk(root);
    }
  }
  // Dedupe, keep order.
  return [...new Set(urls)];
}

function extractB64(parsed: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const o = node as Record<string, unknown>;
    if (typeof o.b64_json === "string" && o.b64_json.length > 0) out.push(o.b64_json);
    for (const v of Object.values(o)) {
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(parsed);
  return out;
}

/** Find a progress token in the v2 handler ctx (shapes differ by transport/era). */
export function findProgressToken(ctx: unknown): string | number | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const c = ctx as Record<string, unknown>;
  const candidates: unknown[] = [];
  const mcpReq = c.mcpReq;
  if (mcpReq && typeof mcpReq === "object") {
    const m = mcpReq as Record<string, unknown>;
    const meta = m._meta;
    if (meta && typeof meta === "object") {
      candidates.push((meta as Record<string, unknown>).progressToken);
    }
  }
  // Fallbacks for alternate ctx shapes.
  for (const k of ["progressToken", "_meta"]) {
    candidates.push(c[k]);
  }
  if (c._meta && typeof c._meta === "object") {
    candidates.push((c._meta as Record<string, unknown>).progressToken);
  }
  for (const t of candidates) {
    if (typeof t === "string" || typeof t === "number") return t;
  }
  return undefined;
}

async function safeNotify(
  ctx: Record<string, unknown>,
  params: { progressToken: string | number; progress: number; message?: string },
): Promise<void> {
  try {
    const mcpReq = ctx.mcpReq as { notify?: (n: unknown) => Promise<void> } | undefined;
    if (mcpReq && typeof mcpReq.notify === "function") {
      await mcpReq.notify({
        method: "notifications/progress",
        params: { progressToken: params.progressToken, progress: params.progress, message: params.message },
      });
    }
  } catch {
    // Progress is best-effort; never fail the poll on notify errors.
  }
}

export { z };
export type { KenariModel };
