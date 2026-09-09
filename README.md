# kenari-media-mcp

MCP server for Kenari media APIs (https://kenari.id/v1): image generation/editing and video generation/extension/polling/download. Stdio transport, 8 tools, saves all media to disk under `KENARI_OUTPUT_DIR` and returns absolute paths (never base64/ImageContent).

## Cost warning

Generation endpoints **spend real IDR** per call (e.g. gpt-image-2 175 IDR/image, grok-imagine-image-2-0 900 IDR/image). `list_media_models` shows per-image IDR costs. `preview` does NOT save money — files are always written. Never call generation endpoints in automated tests; tests use mocked `fetch`.

## Env vars

| Var | Default | Notes |
|---|---|---|
| `KENARI_API_KEY` | (none) | Required for everything except `list_media_models` (`GET /v1/models` is public). |
| `KENARI_BASE_URL` | `https://kenari.id/v1` | Trailing slashes trimmed. |
| `KENARI_OUTPUT_DIR` | `./kenari-output` | Media save dir (mkdir recursive). Absolute path returned. |
| `KENARI_ALLOW_VIDEO` | allow | Set `0`/`false` to disable all video tools with a clear error. |
| `KENARI_MAX_IMAGE_N` | `4` | Preflight cap for `n`. |
| `KENARI_MAX_VIDEO_DURATION` | `15` | Preflight cap for `duration` (seconds). |
| `KENARI_MAX_COST_IDR_PER_CALL` | (none) | Optional per-call IDR ceiling (image tools, best-effort catalog lookup). |

Copy `.env.example` to `.env` for local runs (`pnpm start` loads `.env` if present via a small built-in reader in `config.ts` — no dependency; existing environment variables always win). MCP clients must still inject env via the JSON `env` block below — servers launched by a client do not read `.env` unless its working directory contains one. Never log keys — `kn-*` values are redacted.

## Tools (8)

1. `list_media_models { modality?: "image"|"video" }` — public catalog, per-image IDR costs. Snapshot: 5 image models, 0 video-generation models (video list may be `[]`; video tools still implemented, pass-through to API).
2. `generate_image { model, prompt, n?, size?, background?: transparent|opaque|auto, preview?=false }`
3. `edit_image { model, prompt, image_path, mask_path?, n?, size?, background?: opaque|auto }` — `transparent` rejected by schema.
4. `create_video { model, prompt, duration?, resolution?, image_url?, end_image_url?, input_images?, video_url?, aspect_ratio? }`
5. `extend_video { model, source, prompt?, duration? }` — `source` = job id or https URL; local path rejected before HTTP.
6. `get_video_status { id }` — auto-downloads when done.
7. `wait_for_video { id, timeout_ms?=1200000, download?=true }` — polls 5s, backoff cap 15s, emits `notifications/progress` when the client sends a progress token. Timeout returns `still_rendering` with `isError: false`.
8. `download_video { id }` — `still_rendering` error while rendering.

Error codes in `structuredContent`: `unauthorized | insufficient_balance | content_policy_violation | rate_limited | invalid_model | video_failed | video_expired | still_rendering | bad_request | upstream_error`. 401 bodies are plain text (never assumed JSON); image POSTs may carry ASCII-space heartbeats (trimmed before parse). Image/video HTTP timeout 300s. stdout is JSON-RPC only (`console.error` for logs).

## Windows client config (Claude Desktop / Cursor / OpenCode)

Use `"command": "node"` with an absolute `args` path. Double the backslashes. Save the JSON **without BOM** (UTF-8 plain, e.g. VS Code "Save with Encoding: UTF-8") or the client may fail to parse it.

```json
{
  "mcpServers": {
    "kenari-media": {
      "command": "node",
      "args": ["D:\\multipurpose\\kenari-media-mcp\\dist\\index.js"],
      "env": {
        "KENARI_API_KEY": "kn-REPLACE_ME",
        "KENARI_OUTPUT_DIR": "D:\\multipurpose\\kenari-media-mcp\\kenari-output"
      }
    }
  }
}
```

Build first: `pnpm install && pnpm build`. Entry: `dist/index.js` (`bin`: `kenari-media-mcp`).

### After `npm publish` (npx)

Once the package is published to npm, npx works — Unix/macOS clients:

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

Windows clients must go through `cmd` (npx is `npx.cmd`, which cannot be spawned directly):

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

The `node` + absolute `dist` path above remains the recommended local-dev method.

## Heartbeat / timeouts

- Kenari image POSTs may stream ASCII spaces (~every 20s) before the JSON body — the client reads the full body then trims/parses.
- Default HTTP timeout 300s for image calls; `wait_for_video` default budget 20 min.

## Manual live smoke (do NOT automate — spends money)

1. `pnpm build`; set `KENARI_API_KEY`.
2. `list_media_models` → expect 5 image models.
3. `generate_image` with cheapest model, `n: 1` → check file in output dir.
4. `get_video_status` on a bogus id → expect `video_expired`/`bad_request`, no spend.
5. Only then try `create_video` if a video model exists.

## Dev

- `pnpm install`, `pnpm build` (`tsc`), `pnpm test` (`tsx --test tests/**/*.test.ts`, mocked fetch, no live spend).
- `pnpm typecheck` / `pnpm lint` — both run `tsc --noEmit`.
- Fixture: `tests/fixtures/models.json` (copy of the real `GET /v1/models` snapshot).
