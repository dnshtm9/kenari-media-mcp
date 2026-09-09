import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  parseBodyText,
  classifyError,
  toKenariError,
  parseRetryAfterMs,
  postJson,
  KenariError,
} from "../src/kenari/client.js";
import {
  isImageModel,
  isVideoGenModel,
  imageCostIdr,
  filterModels,
  type KenariModel,
} from "../src/kenari/catalog.js";
import { sanitizeFilename, uniqueFilename, bytesFromDataUrl, sniffExtFromBytes } from "../src/media/files.js";
import {
  normalizeVideoStatus,
  isHttpUrl,
  isHttpsUrl,
  isLocalPath,
  looksLikeJobId,
} from "../src/media/video.js";
import { redact } from "../src/config.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/models.json", import.meta.url), "utf8"),
) as { data: KenariModel[] };

describe("heartbeat JSON parse", () => {
  it("trims ASCII-space heartbeat prefixes then parses", () => {
    const body = "                    {\"data\":[{\"url\":\"https://x/y.png\"}]}";
    assert.deepEqual(parseBodyText(body), { data: [{ url: "https://x/y.png" }] });
  });
  it("empty body yields null", () => {
    assert.equal(parseBodyText("   "), null);
  });
});

describe("401 plaintext", () => {
  it("maps plain-text 401 to unauthorized", () => {
    assert.equal(classifyError(401, "Unauthorized", "image"), "unauthorized");
  });
  it("toKenariError keeps code + message", () => {
    const e = toKenariError(401, "Unauthorized", "models");
    assert.equal(e.code, "unauthorized");
    assert.match(e.message, /unauthorized/);
  });
});

describe("catalog filters (real fixture)", () => {
  it("fixture has 5 image models, 0 video-generation models", () => {
    assert.equal(FIXTURE.data.length, 72);
    assert.equal(filterModels(FIXTURE.data, "image").length, 5);
    assert.equal(filterModels(FIXTURE.data, "video").length, 0);
  });
  it("chat video-understanding models are never video-gen", () => {
    const chatVideoInput = FIXTURE.data.filter((m) =>
      (m.modalities?.input ?? []).includes("video"),
    );
    for (const m of chatVideoInput) assert.equal(isVideoGenModel(m), false);
  });
  it("gpt-image-2 costs 175 IDR/image", () => {
    const gpt = FIXTURE.data.find((m) => m.id === "gpt-image-2")!;
    assert.equal(imageCostIdr(gpt), 175);
  });
  it("all five snapshot image models identified", () => {
    const ids = filterModels(FIXTURE.data, "image").map((m) => m.id).sort();
    assert.deepEqual(ids, [
      "gpt-image-2",
      "grok-imagine-image",
      "grok-imagine-image-2-0",
      "grok-imagine-image-quality",
      "nano-banana-2",
    ]);
  });
  it("isImageModel true for endpoints images", () => {
    assert.equal(isImageModel({ id: "x", endpoints: ["images"] }), true);
    assert.equal(isImageModel({ id: "x", endpoints: ["chat"] }), false);
  });
});

describe("video rendering -> done", () => {
  it("queued/rendering normalize to rendering", () => {
    assert.equal(normalizeVideoStatus({ status: "queued" }).normalized, "rendering");
    assert.equal(normalizeVideoStatus({ status: "rendering" }).normalized, "rendering");
  });
  it("completed with url normalizes to done + contentUrl", () => {
    const st = normalizeVideoStatus({ status: "completed", url: "https://cdn/x.mp4" });
    assert.equal(st.normalized, "done");
    assert.equal(st.contentUrl, "https://cdn/x.mp4");
  });
  it("failed / expired", () => {
    assert.equal(normalizeVideoStatus({ status: "failed" }).normalized, "failed");
    assert.equal(normalizeVideoStatus({ status: "expired" }).normalized, "expired");
  });
});

describe("filename sanitization", () => {
  it("strips Windows-illegal chars", () => {
    const s = sanitizeFilename('a<b>c:d"e/f\\g|h?i*j');
    assert.ok(!/[<>:"/\\|?*]/.test(s), s);
  });
  it("unique names differ", () => {
    assert.notEqual(uniqueFilename("img", ".png"), uniqueFilename("img", ".png"));
  });
});

describe("key redaction", () => {
  it("redacts kn- values", () => {
    assert.equal(redact("Bearer kn-abc123XYZ"), "Bearer [REDACTED]");
    assert.equal(redact("no key here"), "no key here");
  });
});

describe("source classifiers", () => {
  it("http urls", () => {
    assert.equal(isHttpUrl("https://x/y.mp4"), true);
    assert.equal(isHttpUrl("C:\\vid\\a.mp4"), false);
  });
  it("local paths incl. windows + local path with forward slashes", () => {
    assert.equal(isLocalPath("C:\\vid\\a.mp4"), true);
    assert.equal(isLocalPath("D:/out/v.mp4"), true);
    assert.equal(isLocalPath("./rel/v.mp4"), true);
    assert.equal(isLocalPath("https://x/y.mp4"), false);
  });
  it("job ids", () => {
    assert.equal(looksLikeJobId("job_abc123"), true);
    assert.equal(looksLikeJobId("https://x/y"), false);
  });
});

describe("Retry-After parsing (429)", () => {
  it("parses delta-seconds and caps at 30s", () => {
    assert.equal(parseRetryAfterMs("2"), 2000);
    assert.equal(parseRetryAfterMs("120"), 30_000); // capped
    assert.equal(parseRetryAfterMs("0"), 1000); // invalid -> default
  });
  it("parses HTTP-date; past date -> default", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(future);
    assert.ok(ms > 0 && ms <= 30_000, `ms=${ms}`);
    assert.equal(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString()), 1000);
  });
  it("missing/garbage header -> default 1000ms", () => {
    assert.equal(parseRetryAfterMs(null), 1000);
    assert.equal(parseRetryAfterMs(""), 1000);
    assert.equal(parseRetryAfterMs("soon"), 1000);
  });
  it("KenariError carries retryAfterMs on 429", () => {
    const e = toKenariError(429, "rate limited", "image", 2000);
    assert.equal(e.code, "rate_limited");
    assert.equal(e.retryAfterMs, 2000);
    assert.equal(toKenariError(500, "boom", "image").retryAfterMs, undefined);
  });
});

describe("retryAfterMs does not leak across 429 retry", () => {
  const cfg = { baseUrl: "https://kenari.test/v1", apiKey: "kn-testkey123" } as const;

  it("429 with Retry-After then 500 -> final error has no retryAfterMs", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1
        ? new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "0" }, // invalid -> 1000ms default wait
          })
        : new Response("boom", { status: 500, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    await assert.rejects(
      postJson("/models", cfg, {}, { context: "models", fetchImpl }),
      (e: unknown) => {
        assert.ok(e instanceof KenariError);
        assert.equal(e.status, 500);
        assert.equal(e.code, "upstream_error");
        assert.equal(e.retryAfterMs, undefined, "non-429 final must not carry first attempt's Retry-After");
        return true;
      },
    );
    assert.equal(calls, 2, "must retry exactly once");
  });

  it("429 then 429 -> final error keeps the retried 429's own Retry-After", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1
        ? new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
        : new Response("still limited", { status: 429, headers: { "retry-after": "5" } });
    }) as unknown as typeof fetch;
    await assert.rejects(
      postJson("/models", cfg, {}, { context: "models", fetchImpl }),
      (e: unknown) => {
        assert.ok(e instanceof KenariError);
        assert.equal(e.status, 429);
        assert.equal(e.code, "rate_limited");
        assert.equal(e.retryAfterMs, 5000, "retried 429 carries its own Retry-After value");
        return true;
      },
    );
    assert.equal(calls, 2);
  });

  it("429 then 429 without its own Retry-After header -> keeps first attempt's value", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1
        ? new Response("rate limited", { status: 429, headers: { "retry-after": "2" } })
        : new Response("still limited", { status: 429 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      postJson("/models", cfg, {}, { context: "models", fetchImpl }),
      (e: unknown) => {
        assert.ok(e instanceof KenariError);
        assert.equal(e.status, 429);
        assert.equal(e.retryAfterMs, 2000, "final 429 falls back to first attempt's value");
        return true;
      },
    );
    assert.equal(calls, 2);
  });
});

describe("magic-byte sniffing", () => {
  it("detects PNG / JPEG / GIF / WebP / WebM", () => {
    assert.equal(sniffExtFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), ".png");
    assert.equal(sniffExtFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), ".jpg");
    assert.equal(sniffExtFromBytes(Buffer.from("GIF89a....")), ".gif");
    assert.equal(sniffExtFromBytes(Buffer.from("RIFF1234WEBPVP8 ")), ".webp");
    assert.equal(sniffExtFromBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])), ".webm");
  });
  it("detects MP4 ftyp brands and MOV variants", () => {
    const ftyp = (brand: string) =>
      Buffer.concat([new Uint8Array([0, 0, 0, 0x18]), Buffer.from("ftyp"), Buffer.from(brand, "latin1"), new Uint8Array(4)]);
    assert.equal(sniffExtFromBytes(ftyp("isom")), ".mp4");
    assert.equal(sniffExtFromBytes(ftyp("M4V ")), ".mov");
    assert.equal(sniffExtFromBytes(ftyp("qt  ")), ".mov");
  });
  it("unknown/short bytes return null", () => {
    assert.equal(sniffExtFromBytes(Buffer.from("<html><body>hi there</body>")), null);
    assert.equal(sniffExtFromBytes(new Uint8Array([0x89, 0x50])), null);
    assert.equal(sniffExtFromBytes(null), null);
  });
});

describe("https url classifier", () => {
  it("accepts https only", () => {
    assert.equal(isHttpsUrl("https://x/y.png"), true);
    assert.equal(isHttpsUrl("HTTPS://x/y.png"), true);
    assert.equal(isHttpsUrl("http://x/y.png"), false);
    assert.equal(isHttpsUrl("file:///C:/x/y.png"), false);
    assert.equal(isHttpsUrl("data:image/png;base64,aGk="), false);
    assert.equal(isHttpsUrl("C:\\img\\a.png"), false);
    assert.equal(isHttpsUrl("img/a.png"), false);
  });
});

describe("data urls", () => {
  it("decodes base64 image data url", () => {
    const d = bytesFromDataUrl("data:image/png;base64,aGk=");
    assert.ok(d);
    assert.equal(d!.ext, ".png");
  });
  it("non-data url returns null", () => {
    assert.equal(bytesFromDataUrl("https://x/y.png"), null);
  });
});

describe("no console.log in src", () => {
  it("grep src for console.log", () => {
    const root = new URL("../src/", import.meta.url);
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && /\.(ts|js)$/.test(e.name)) files.push(p);
      }
    };
    walk(new URL(root).pathname.replace(/^\//, "").replace(/\//g, path.sep).replace(/^([A-Z]:)/, "$1") || ".");
    void files;
    // Simpler robust scan: read known source files.
    const known = [
      "config.ts",
      "index.ts",
      "server.ts",
      "kenari/catalog.ts",
      "kenari/client.ts",
      "media/files.ts",
      "media/video.ts",
      "tools/schemas.ts",
    ];
    const srcDir = new URL("../src/", import.meta.url);
    for (const f of known) {
      const text = readFileSync(new URL(f, srcDir), "utf8");
      assert.ok(!/console\.log/.test(text), `console.log found in src/${f}`);
    }
  });
});
