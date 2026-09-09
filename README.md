# kenari-media-mcp

An MCP (Model Context Protocol) server for the Kenari.id media APIs (`https://kenari.id/v1`). It gives any MCP client (Claude Desktop, Cursor, OpenCode, etc.) 8 tools for image generation and editing plus video generation, extension, status polling, and download. It runs over stdio and is designed for agentic use: all generated media is written to disk under a configurable output directory and returned as **absolute file paths — never base64 or ImageContent** — so the calling agent can open, move, or post-process files directly.

This project fills a gap: Kenari's own official MCP server covers docs, balance, and search, but not the media generation endpoints. This is a third-party, unaffiliated implementation for those endpoints.

> ## ⚠️ Cost warning — real money
>
> Generation endpoints **spend real Indonesian Rupiah (IDR) per call**, billed to your Kenari account. Prices vary per model — `gpt-image-2` is roughly 175 IDR per image, while others cost several times more. Treat the catalog prices you see via `list_media_models` as examples only; **live prices come from `list_media_models`**.
>
> Note that `preview` does **not** save money — files are always written to disk regardless.
>
> Never point automated tests or scheduled jobs at generation tools; the test suite uses a mocked `fetch` and spends nothing.

## Requirements

- **Node.js >= 20** (`engines` field is enforced; `node --version` to check)
- **pnpm** (or npm) for installing and running scripts
- A **Kenari API key** (`kn-...`), obtained from the Kenari dashboard. Required for everything except `list_media_models` (`GET /v1/models` is public).

## Install from source

This is the primary installation path until the package is published to npm (it is **not** on npm yet — `npx` will not work yet).

```bash
git clone https://github.com/dnshtm9/kenari-media-mcp.git
cd kenari-media-mcp
pnpm install
pnpm build
```

The build writes the server entry to `dist/index.js` (the `bin` is `kenari-media-mcp`).

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `KENARI_API_KEY` | (none) | Required for everything except `list_media_models`. |
| `KENARI_BASE_URL` | `https://kenari.id/v1` | Trailing slashes trimmed. |
| `KENARI_OUTPUT_DIR` | `./kenari-output` | Media save directory (created recursively). Absolute paths are returned. |
| `KENARI_ALLOW_VIDEO` | allow | Set to `0`/`false` to disable all video tools with a clear error. |
| `KENARI_MAX_IMAGE_N` | `4` | Preflight cap for `n`. |
| `KENARI_MAX_VIDEO_DURATION` | `15` | Preflight cap for `duration` (seconds). |
| `KENARI_MAX_COST_IDR_PER_CALL` | (none) | Optional per-call IDR ceiling (image tools; best-effort catalog lookup). |

### `.env` files — important caveat

The repository includes a `.env.example`. Copy it to `.env` if you want `pnpm start` (or other local runs) to pick up defaults — `pnpm start` loads `.env` via a small built-in reader; existing environment variables always win.

**MCP clients do not reliably load `.env`.** When a client spawns this server, the server's working directory is often not the repository, so any `.env` next to it may be invisible. **You must inject environment variables in the client JSON `env` block.** Treat `.env` as a local-run convenience only.

Never commit `.env` or any file containing your API key.

## MCP client configuration

### Recommended (local build): `node` + absolute path

Point the client at the built server. Most MCP clients require an **absolute** path in `args` — relative paths are resolved against the client's own working directory, not yours.

Substitute the location where you cloned the repository. On Windows, double every backslash in JSON strings and save the config file as **UTF-8 without BOM** (e.g. VS Code → "Save with Encoding → UTF-8"); a BOM can break config parsing.

Windows pattern:

```json
{
  "mcpServers": {
    "kenari-media": {
      "command": "node",
      "args": ["C:\\\\path\\\\to\\\\kenari-media-mcp\\\\dist\\\\index.js"],
      "env": {
        "KENARI_API_KEY": "kn-REPLACE_ME",
        "KENARI_OUTPUT_DIR": "C:\\\\path\\\\to\\\\kenari-output"
      }
    }
  }
}
```

macOS / Linux pattern:

```json
{
  "mcpServers": {
    "kenari-media": {
      "command": "node",
      "args": ["/path/to/kenari-media-mcp/dist/index.js"],
      "env": {
        "KENARI_API_KEY": "kn-REPLACE_ME",
        "KENARI_OUTPUT_DIR": "/path/to/kenari-output"
      }
    }
  }
}
```

`KENARI_OUTPUT_DIR` is any directory you choose; if you omit it, media is saved to `./kenari-output` relative to the server's working directory (which may not be where you expect — setting it explicitly is safer).

### After npm publish: `npx` (not yet possible)

The package is **not published to npm yet**, so the following does not work today. Once it is published, npx-based config will be:

Unix / macOS:

```json
{
  "mcpServers": {
    "kenari-media": {
      "command": "npx",
      "args": ["-y", "kenari-media-mcp"],
      "env": {
        "KENARI_API_KEY": "kn-REPLACE_ME"
      }
    }
  }
}
```

Windows (npx is `npx.cmd`, which cannot be spawned directly, so clients must go through `cmd`):

```json
{
  "mcpServers": {
    "kenari-media": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "kenari-media-mcp"],
      "env": {
        "KENARI_API_KEY": "kn-REPLACE_ME"
      }
    }
  }
}
```

Until then, use the local `node` + absolute-path config above.

## Tools (8)

1. `list_media_models { modality?: "image"|"video" }` — public catalog with per-image IDR costs. Snapshot example: 5 image models, 0 video-generation models (the video list may be `[]` — video tools are still implemented and pass through to the API).
2. `generate_image { model, prompt, n?, size?, background?: transparent|opaque|auto, preview?=false }` — text-to-image; `n` capped by `KENARI_MAX_IMAGE_N`.
3. `edit_image { model, prompt, image_path, mask_path?, n?, size?, background?: opaque|auto }` — reads local image files you pass; `background: transparent` is rejected by schema.
4. `create_video { model, prompt, duration?, resolution?, image_url?, end_image_url?, input_images?, video_url?, aspect_ratio? }` — text/image-to-video; `duration` capped by `KENARI_MAX_VIDEO_DURATION`.
5. `extend_video { model, source, prompt?, duration? }` — `source` is a job id or an https URL; local file paths are rejected before any HTTP request.
6. `get_video_status { id }` — checks a video job; auto-downloads the result when done.
7. `wait_for_video { id, timeout_ms?=1200000, download?=true }` — polls every 5s with backoff capped at 15s; emits `notifications/progress` when the client sends a progress token. On timeout it returns `still_rendering` with `isError: false` so the agent can retry later.
8. `download_video { id }` — downloads a finished video; returns a `still_rendering` error while rendering.

### Error codes, heartbeat, timeouts

Error codes surfaced in `structuredContent`: `unauthorized | insufficient_balance | content_policy_violation | rate_limited | invalid_model | video_failed | video_expired | still_rendering | bad_request | upstream_error`.

- 401 error bodies are plain text and are never assumed to be JSON.
- Kenari image POSTs may stream ASCII-space "heartbeat" characters (~every 20s) before the JSON body — the server reads the full body, trims, then parses.
- HTTP timeout: 300s for image calls. `wait_for_video` default budget: 20 minutes.
- stdout carries JSON-RPC only; all logs go to stderr (`console.error`).

## Manual live smoke test

⚠️ This **spends real money**. Do it once by hand, never in CI or automated tests.

1. Build (`pnpm build`) and set `KENARI_API_KEY`.
2. Call `list_media_models` → expect the image model catalog.
3. Call `generate_image` with the cheapest model, `n: 1` → confirm a file appears in the output dir.
4. Call `get_video_status` on a bogus id → expect `video_expired`/`bad_request`, no spend.
5. Only then try `create_video` if a video model exists in the catalog.

## Development

```bash
pnpm test       # tsx --test tests/**/*.test.ts — mocked fetch, no live spend
pnpm typecheck  # tsc --noEmit
pnpm lint       # tsc --noEmit
```

Tests mock `fetch` entirely, so running them costs nothing and requires no API key. The model-catalog fixture lives at `tests/fixtures/models.json` (a copy of a real `GET /v1/models` snapshot).

## Security notes

- `kn-*` API key values are redacted in logs.
- Never commit API keys (`.env`, shell history, config dumps).
- `edit_image` reads local files **you** pass to it — only pass files you intend to upload.
- Generation costs money on every call; beware of an agent looping on generation tools and burning IDR unattended.

## License

See [LICENSE](LICENSE).
