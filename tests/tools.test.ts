import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";

const FIXTURE_MODELS = JSON.parse(
  readFileSync(new URL("./fixtures/models.json", import.meta.url), "utf8"),
).data as Array<Record<string, unknown>>;

type Handler = (args: Record<string, unknown>, ctx?: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}>;

/** Captured registerTool configs, keyed by tool name (see withCapturedConfigs). */
type CapturedCfg = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

function withCapturedConfigs<T>(fn: () => T): Map<string, CapturedCfg> {
  const configs = new Map<string, CapturedCfg>();
  const proto = McpServer.prototype as unknown as {
    registerTool: (name: string, cfg: unknown, cb: Handler) => unknown;
  };
  const orig = proto.registerTool;
  proto.registerTool = function (name: string, cfg: unknown, cb: Handler) {
    configs.set(name, cfg as CapturedCfg);
    return orig.call(this, name, cfg, cb);
  };
  try {
    fn();
  } finally {
    proto.registerTool = orig;
  }
  return configs;
}

function mockFetch(
  routes: Array<{
    match: (url: string, init?: RequestInit) => boolean;
    respond: () => Response | Promise<Response>;
  }>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    for (const r of routes) {
      if (r.match(String(url), init)) return r.respond();
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain" } });
const response429 = (retryAfter?: string) =>
  new Response("rate limited", {
    status: 429,
    headers: {
      "content-type": "text/plain",
      ...(retryAfter !== undefined ? { "retry-after": retryAfter } : {}),
    },
  });

/** Capture handlers registered by createServer via a temporary prototype hook. */
async function invoke(
  toolName: string,
  args: Record<string, unknown>,
  opts: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    modelList?: () => Promise<Array<Record<string, unknown>>>;
    sleepMs?: (ms: number) => Promise<void>;
    ctx?: unknown;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const proto = McpServer.prototype as unknown as {
    registerTool: (name: string, cfg: unknown, cb: Handler) => unknown;
  };
  const orig = proto.registerTool;
  proto.registerTool = function (name: string, cfg: unknown, cb: Handler) {
    handlers.set(name, cb);
    return orig.call(this, name, cfg, cb);
  };
  try {
    createServer({
      env: opts.env,
      fetchImpl: opts.fetchImpl,
      modelList: opts.modelList,
      sleepMs: opts.sleepMs,
    });
  } finally {
    proto.registerTool = orig;
  }
  const h = handlers.get(toolName);
  assert.ok(h, `tool not registered: ${toolName}`);
  return h(args, opts.ctx);
}

let outDir: string;
beforeEach(() => {
  outDir = mkdtempSync(path.join(tmpdir(), "kenari-test-"));
});
afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

const baseEnv = (): NodeJS.ProcessEnv =>
  ({
    KENARI_API_KEY: "kn-testkey123",
    KENARI_OUTPUT_DIR: outDir,
  }) as NodeJS.ProcessEnv;

describe("list_media_models", () => {
  it("lists fixture models with costs", async () => {
    const res = await invoke(
      "list_media_models",
      {},
      { env: baseEnv(), modelList: async () => FIXTURE_MODELS },
    );
    assert.ok(!res.isError);
    const models = res.structuredContent!.models as Array<{
      id: string;
      cost_idr_per_image: number | null;
    }>;
    assert.equal(models.length, 5);
    assert.equal(models.find((m) => m.id === "gpt-image-2")!.cost_idr_per_image, 175);
  });
  it("video modality may be empty", async () => {
    const res = await invoke(
      "list_media_models",
      { modality: "video" },
      { env: baseEnv(), modelList: async () => FIXTURE_MODELS },
    );
    assert.ok(!res.isError);
    assert.deepEqual(res.structuredContent!.models, []);
  });
});

describe("generate_image", () => {
  it("saves b64_json response to disk, returns absolute path", async () => {
    const b64 = Buffer.from("fakepngbytes").toString("base64");
    const { impl } = mockFetch([
      {
        match: (u) => u.endsWith("/images/generations"),
        respond: () => json({ data: [{ b64_json: b64 }] }),
      },
    ]);
    const res = await invoke(
      "generate_image",
      { model: "gpt-image-2", prompt: "a cat" },
      { env: baseEnv(), fetchImpl: impl },
    );
    assert.ok(!res.isError, JSON.stringify(res));
    const paths = res.structuredContent!.paths as string[];
    assert.equal(paths.length, 1);
    assert.ok(path.isAbsolute(paths[0]));
  });
  it("401 plaintext -> unauthorized", async () => {
    const { impl } = mockFetch([
      {
        match: (u) => u.endsWith("/images/generations"),
        respond: () => text("Unauthorized", 401),
      },
    ]);
    const res = await invoke(
      "generate_image",
      { model: "gpt-image-2", prompt: "a cat" },
      { env: baseEnv(), fetchImpl: impl },
    );
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent!.code, "unauthorized");
  });
  it("spaces heartbeat prefix parses", async () => {
    const b64 = Buffer.from("x").toString("base64");
    const { impl } = mockFetch([
      {
        match: (u) => u.endsWith("/images/generations"),
        respond: () => text(`                    {"data":[{"b64_json":"${b64}"}]}`, 200),
      },
    ]);
    const res = await invoke(
      "generate_image",
      { model: "gpt-image-2", prompt: "a cat" },
      { env: baseEnv(), fetchImpl: impl },
    );
    assert.ok(!res.isError, JSON.stringify(res));
  });
  it("cost cap blocks BEFORE POST (no fetch to /images/generations)", async () => {
    const b64 = Buffer.from("x").toString("base64");
    const { impl, calls } = mockFetch([
      {
        match: (u) => u.endsWith("/images/generations"),
        respond: () => json({ data: [{ b64_json: b64 }] }),
      },
    ]);
    const res = await invoke(
      "generate_image",
      { model: "gpt-image-2", prompt: "a cat" },
      {
        env: { ...baseEnv(), KENARI_MAX_COST_IDR_PER_CALL: "1" } as NodeJS.ProcessEnv,
        fetchImpl: impl,
        modelList: async () => FIXTURE_MODELS,
      },
    );
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent!.code, "bad_request");
    assert.ok(!calls.some((c) => c.url.endsWith("/images/generations")), "must not POST when over cap");
  });
  it("unknown model price skips cap (does not block)", async () => {
    const b64 = Buffer.from("x").toString("base64");
    const { impl } = mockFetch([
      {
        match: (u) => u.endsWith("/images/generations"),
        respond: () => json({ data: [{ b64_json: b64 }] }),
      },
    ]);
    const res = await invoke(
      "generate_image",
      { model: "no-such-model", prompt: "a cat" },
      {
        env: { ...baseEnv(), KENARI_MAX_COST_IDR_PER_CALL: "1" } as NodeJS.ProcessEnv,
        fetchImpl: impl,
        modelList: async () => FIXTURE_MODELS,
      },
    );
    assert.ok(!res.isError, JSON.stringify(res));
  });
});

describe("edit_image", () => {
  it("transparent rejected by schema (edit allows only opaque|auto)", async () => {
    const { editImageSchema } = await import("../src/tools/schemas.js");
    const parsed = editImageSchema.safeParse({
      model: "gpt-image-2",
      prompt: "x",
      image_path: "a.png",
      background: "transparent",
    });
    assert.equal(parsed.success, false);
  });
});

describe("extend_video local path fails before HTTP", () => {
  it("no fetch call for local path", async () => {
    let fetched = false;
    const impl = (async () => {
      fetched = true;
      throw new Error("should not fetch");
    }) as typeof fetch;
    const res = await invoke(
      "extend_video",
      { model: "m", source: "C:\\videos\\a.mp4" },
      { env: baseEnv(), fetchImpl: impl },
    );
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent!.code, "bad_request");
    assert.equal(fetched, false);
  });
});

describe("video poll flows", () => {
  it("rendering -> done with auto-download", async () => {
    let n = 0;
    const { impl } = mockFetch([
      {
        match: (u) => u.includes("/videos/v1") && !u.endsWith("/content"),
        respond: () => {
          n += 1;
          if (n === 1) return json({ status: "rendering" });
          return json({ status: "completed", url: "https://cdn/x.mp4" });
        },
      },
      {
        match: (u) => u === "https://cdn/x.mp4",
        respond: () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "video/mp4" },
          }),
      },
      {
        match: (u) => u.includes("/videos/v1/content"),
        respond: () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "video/mp4" },
          }),
      },
    ]);
    const res = await invoke(
      "wait_for_video",
      { id: "v1", timeout_ms: 60_000, download: true },
      { env: baseEnv(), fetchImpl: impl, sleepMs: async () => {} },
    );
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(res.structuredContent!.code, "done");
    const paths = res.structuredContent!.paths as string[];
    assert.ok(paths && paths.length === 1 && path.isAbsolute(paths[0]));
  });
  it("wait timeout -> still_rendering, isError false", async () => {
    const { impl } = mockFetch([
      {
        match: (u) => u.includes("/videos/"),
        respond: () => json({ status: "rendering" }),
      },
    ]);
    let now = 0;
    const origNow = Date.now;
    (Date as unknown as { now: () => number }).now = () => now;
    try {
      const res = await invoke(
        "wait_for_video",
        { id: "v9", timeout_ms: 10_000, download: false },
        {
          env: baseEnv(),
          fetchImpl: impl,
          sleepMs: async (ms: number) => {
            now += ms + 1_000;
          },
        },
      );
      assert.ok(!res.isError, JSON.stringify(res));
      assert.equal(res.structuredContent!.code, "still_rendering");
    } finally {
      (Date as unknown as { now: () => number }).now = origNow;
    }
  });
  it("download while rendering isError still_rendering", async () => {
    const { impl } = mockFetch([
      {
        match: (u) => u.includes("/videos/"),
        respond: () => json({ status: "rendering" }),
      },
    ]);
    const res = await invoke(
      "download_video",
      { id: "v2" },
      { env: baseEnv(), fetchImpl: impl },
    );
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent!.code, "still_rendering");
  });
  it("get_video_status auto-downloads on done via content endpoint", async () => {
    const { impl, calls } = mockFetch([
      {
        match: (u) => u.endsWith("/videos/v3"),
        respond: () => json({ status: "succeeded" }),
      },
      {
        match: (u) => u.endsWith("/videos/v3/content"),
        respond: () =>
          new Response(new Uint8Array([9, 9]), {
            status: 200,
            headers: { "content-type": "video/mp4" },
          }),
      },
    ]);
    const res = await invoke(
      "get_video_status",
      { id: "v3" },
      { env: baseEnv(), fetchImpl: impl },
    );
    assert.ok(!res.isError, JSON.stringify(res));
    assert.ok(calls.some((c) => c.url.endsWith("/content")));
  });
});

describe("video disabled", () => {
  it("KENARI_ALLOW_VIDEO=0 blocks create_video", async () => {
    const res = await invoke(
      "create_video",
      { model: "m", prompt: "p" },
      { env: { ...baseEnv(), KENARI_ALLOW_VIDEO: "0" } as NodeJS.ProcessEnv },
    );
    assert.equal(res.isError, true);
  });
});

describe("tool registration metadata", () => {
  it("registerTool configs carry outputSchema + annotations (list_media_models, generate_image)", () => {
    const configs = withCapturedConfigs(() => createServer({ env: baseEnv() }));
    for (const name of ["list_media_models", "generate_image"]) {
      const cfg = configs.get(name);
      assert.ok(cfg, `tool not registered: ${name}`);
      assert.ok(cfg.outputSchema, `${name}: outputSchema missing`);
      assert.ok(
        typeof (cfg.outputSchema as { "~standard"?: unknown })["~standard"] === "object",
        `${name}: outputSchema is not a Standard Schema`,
      );
      assert.ok(cfg.title, `${name}: title missing`);
      assert.ok(cfg.annotations, `${name}: annotations missing`);
    }
    const list = configs.get("list_media_models")!;
    assert.equal(list.annotations!.readOnlyHint, true);
    assert.equal(list.annotations!.openWorldHint, true);
    assert.equal(list.annotations!.destructiveHint, false);

    const gen = configs.get("generate_image")!;
    assert.equal(gen.annotations!.readOnlyHint, false);
    assert.equal(gen.annotations!.openWorldHint, true);
    assert.equal(gen.annotations!.destructiveHint, false);

    // Output schemas must accept both success and error structuredContent.
    // Standard Schema validate returns { value } on success, { issues } on failure.
    const listOut = list.outputSchema as {
      "~standard": { validate: (v: unknown) => { readonly issues?: unknown[] } };
    };
    assert.equal(listOut["~standard"].validate({ models: [] }).issues, undefined);
    assert.equal(
      listOut["~standard"].validate({ code: "upstream_error", op: "list_media_models", status: 500 }).issues,
      undefined,
    );
    const genOut = gen.outputSchema as {
      "~standard": { validate: (v: unknown) => { readonly issues?: unknown[] } };
    };
    assert.equal(genOut["~standard"].validate({ model: "m", paths: ["/x/y.png"], count: 1 }).issues, undefined);
    assert.equal(
      genOut["~standard"].validate({ code: "unauthorized", op: "generate_image", status: 401 }).issues,
      undefined,
    );
  });
});

describe("429 retry-once with Retry-After", () => {
  it("get_video_status waits Retry-After seconds then retries exactly once", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      // 429 once, then the retried GET succeeds (job failed -> no download fetch).
      return calls === 1 ? response429("2") : json({ status: "failed" });
    }) as typeof fetch;
    const t0 = Date.now();
    const res = await invoke("get_video_status", { id: "r1" }, { env: baseEnv(), fetchImpl: impl });
    const elapsed = Date.now() - t0;
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent!.code, "video_failed", "retried GET must have succeeded");
    assert.equal(calls, 2, "must retry exactly once (2 fetches total)");
    assert.ok(elapsed >= 2000, `expected >= 2s wait honoring Retry-After: 2, elapsed=${elapsed}ms`);
  });
  it("429 twice on the retried attempt -> rate_limited error (never a second retry)", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return response429("1");
    }) as typeof fetch;
    const res = await invoke(
      "get_video_status",
      { id: "r2" },
      { env: baseEnv(), fetchImpl: impl, sleepMs: async () => {} },
    );
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent!.code, "rate_limited");
    assert.equal(calls, 2, "no third fetch after retried 429");
  });
  it("429 without Retry-After header defaults to 1000ms wait", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return calls === 1 ? response429() : json({ data: [] });
    }) as typeof fetch;
    const t0 = Date.now();
    const res = await invoke("list_media_models", {}, { env: baseEnv(), fetchImpl: impl });
    const elapsed = Date.now() - t0;
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(calls, 2);
    assert.ok(elapsed >= 1000, `expected >= 1s default wait, elapsed=${elapsed}ms`);
  });
});

describe("create_video https-only refs", () => {
  it("schema rejects http:// image_url", async () => {
    const { createVideoSchema } = await import("../src/tools/schemas.js");
    assert.equal(
      createVideoSchema.safeParse({ model: "m", prompt: "p", image_url: "http://x/i.png" }).success,
      false,
    );
  });
  it("schema rejects file:// video_url and bare-path input_images", async () => {
    const { createVideoSchema } = await import("../src/tools/schemas.js");
    assert.equal(
      createVideoSchema.safeParse({ model: "m", prompt: "p", video_url: "file:///C:/v.mp4" }).success,
      false,
    );
    assert.equal(
      createVideoSchema.safeParse({ model: "m", prompt: "p", input_images: ["C:\\img\\a.png"] }).success,
      false,
    );
  });
  it("schema still accepts https and data: image urls", async () => {
    const { createVideoSchema } = await import("../src/tools/schemas.js");
    const ok = createVideoSchema.safeParse({
      model: "m",
      prompt: "p",
      image_url: "data:image/png;base64,aGk=",
      input_images: ["https://x/i.png"],
      video_url: "https://x/v.mp4",
    });
    assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
  });
  it("handler rejects http:// image_url BEFORE any fetch", async () => {
    let fetched = false;
    const impl = (async () => {
      fetched = true;
      throw new Error("should not fetch");
    }) as typeof fetch;
    const res = await invoke(
      "create_video",
      { model: "m", prompt: "p", image_url: "http://x/i.png" },
      { env: baseEnv(), fetchImpl: impl },
    );
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent!.code, "bad_request");
    assert.equal(fetched, false);
  });
  it("handler rejects local-path input_images BEFORE any fetch", async () => {
    let fetched = false;
    const impl = (async () => {
      fetched = true;
      throw new Error("should not fetch");
    }) as typeof fetch;
    const res = await invoke(
      "create_video",
      { model: "m", prompt: "p", input_images: ["./local/a.png"] },
      { env: baseEnv(), fetchImpl: impl },
    );
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent!.code, "bad_request");
    assert.equal(fetched, false);
  });
});

describe("sniff-override on save", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0]);
  it("b64 fallback: JPEG bytes served as image/png saves .jpg (sniff wins)", async () => {
    const b64 = JPEG.toString("base64");
    const { impl } = mockFetch([
      {
        match: (u) => u.endsWith("/images/generations"),
        respond: () => json({ data: [{ b64_json: b64 }] }),
      },
    ]);
    const res = await invoke(
      "generate_image",
      { model: "gpt-image-2", prompt: "a cat" },
      { env: baseEnv(), fetchImpl: impl },
    );
    assert.ok(!res.isError, JSON.stringify(res));
    const paths = res.structuredContent!.paths as string[];
    assert.equal(paths.length, 1);
    assert.ok(paths[0].endsWith(".jpg"), `expected .jpg, got ${paths[0]}`);
  });
  it("content endpoint: status done + lying Content-Type -> sniff wins, saves .mp4", async () => {
    const ftypMp4 = Buffer.concat([
      new Uint8Array([0, 0, 0, 0x18]),
      Buffer.from("ftypisom"),
      new Uint8Array(4),
    ]);
    let calls = 0;
    const impl = (async (url: unknown) => {
      calls += 1;
      const u = String(url);
      if (u.endsWith("/videos/sniff1") && calls === 1) {
        return json({ status: "succeeded" });
      }
      if (u.endsWith("/videos/sniff1/content")) {
        return new Response(new Uint8Array(ftypMp4), {
          status: 200,
          headers: { "content-type": "image/png" }, // lying Content-Type
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;
    const res = await invoke("download_video", { id: "sniff1" }, { env: baseEnv(), fetchImpl: impl });
    assert.ok(!res.isError, JSON.stringify(res));
    const paths = res.structuredContent!.paths as string[];
    assert.ok(paths && paths[0].endsWith(".mp4"), `expected .mp4, got ${paths[0]}`);
  });
  it("url download: PNG bytes with text/plain Content-Type saves .png", async () => {
    const { impl } = mockFetch([
      {
        match: (u) => u === "https://cdn/lying.bin",
        respond: () =>
          new Response(new Uint8Array(PNG), {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      },
    ]);
    // download_video first checks status (fails on fetch) — use saveFromUrlOrData
    // indirectly via get_video_status auto-download: status says done with url.
    const { impl: impl2 } = mockFetch([
      {
        match: (u) => u.endsWith("/videos/sniff2"),
        respond: () => json({ status: "succeeded", url: "https://cdn/lying.bin" }),
      },
      {
        match: (u) => u === "https://cdn/lying.bin",
        respond: () =>
          new Response(new Uint8Array(PNG), {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      },
    ]);
    const res = await invoke(
      "get_video_status",
      { id: "sniff2" },
      { env: baseEnv(), fetchImpl: impl2 },
    );
    assert.ok(!res.isError, JSON.stringify(res));
    const paths = res.structuredContent!.paths as string[];
    assert.ok(paths && paths[0].endsWith(".png"), `expected .png, got ${paths[0]}`);
  });
});

describe("timeout_ms max", () => {
  it("schema rejects timeout_ms over 3600000", async () => {
    const { waitForVideoSchema } = await import("../src/tools/schemas.js");
    assert.equal(waitForVideoSchema.safeParse({ id: "v", timeout_ms: 3_600_001 }).success, false);
    assert.equal(waitForVideoSchema.safeParse({ id: "v", timeout_ms: 3_600_000 }).success, true);
  });
});

describe("poll timeoutMs is passed to per-poll getJson", () => {
  it("wait_for_video status polls carry timeoutMs (AbortSignal.timeout signal)", async () => {
    const signals: unknown[] = [];
    let calls = 0;
    const impl = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/videos/pt")) {
        calls += 1;
        signals.push(init?.signal);
        return json({ status: "succeeded", url: "https://cdn/z.mp4" });
      }
      if (u === "https://cdn/z.mp4") {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;
    const res = await invoke(
      "wait_for_video",
      { id: "pt", timeout_ms: 60_000, download: true },
      { env: baseEnv(), fetchImpl: impl, sleepMs: async () => {} },
    );
    assert.ok(!res.isError, JSON.stringify(res));
    assert.ok(signals.length >= 1, "expected at least one status poll");
    const s = signals[0] as AbortSignal | undefined;
    assert.ok(s instanceof AbortSignal, "poll GET must carry a timeout signal");
  });
  it("download_video status GET carries timeoutMs", async () => {
    const signals: unknown[] = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/videos/dt") && !u.endsWith("/content")) {
        signals.push(init?.signal);
        return json({ status: "rendering" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;
    const res = await invoke("download_video", { id: "dt" }, { env: baseEnv(), fetchImpl: impl });
    assert.equal(res.structuredContent!.code, "still_rendering");
    const s = signals[0] as AbortSignal | undefined;
    assert.ok(s instanceof AbortSignal, "status GET must carry a timeout signal");
  });
  it("extend_video job->url status GET carries timeoutMs (resolveJobToUrl)", async () => {
    const signals: unknown[] = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/videos/xt") && !u.endsWith("/content")) {
        signals.push(init?.signal);
        return json({ status: "succeeded", url: "https://cdn/x.mp4" });
      }
      if (u.endsWith("/videos/extensions")) {
        return json({ id: "job-extended" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;
    const res = await invoke(
      "extend_video",
      { model: "v-model", source: "xt" },
      { env: baseEnv(), fetchImpl: impl },
    );
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(signals.length, 1, "expected exactly one job->url status GET");
    const s = signals[0] as AbortSignal | undefined;
    assert.ok(s instanceof AbortSignal, "resolveJobToUrl GET must carry a timeout signal");
  });
});

describe("progress notify", () => {
  it("wait_for_video notifies when ctx carries a progress token", async () => {
    const seen: unknown[] = [];
    const { impl } = mockFetch([
      {
        match: (u) => u.includes("/videos/"),
        respond: () => json({ status: "succeeded", url: "https://cdn/d.mp4" }),
      },
      {
        match: (u) => u === "https://cdn/d.mp4",
        respond: () =>
          new Response(new Uint8Array([1]), {
            status: 200,
            headers: { "content-type": "video/mp4" },
          }),
      },
    ]);
    const res = await invoke(
      "wait_for_video",
      { id: "vp", timeout_ms: 60_000, download: true },
      {
        env: baseEnv(),
        fetchImpl: impl,
        sleepMs: async () => {},
        ctx: {
          mcpReq: {
            _meta: { progressToken: "tok-1" },
            notify: async (n: unknown) => {
              seen.push(n);
            },
          },
        },
      },
    );
    assert.ok(!res.isError, JSON.stringify(res));
    assert.ok(seen.length >= 1, "expected progress notification");
  });
});
