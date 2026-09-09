import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Input schemas — every field described for the LLM.                 */
/* ------------------------------------------------------------------ */

export const listMediaModelsSchema = z.object({
  modality: z
    .enum(["image", "video"])
    .optional()
    .describe(
      "Filter by media modality: 'image' returns image generation/edit models, 'video' returns video-generation models (the video list may be empty). Omit to list all media-capable models.",
    ),
});

export const generateImageSchema = z.object({
  model: z
    .string()
    .min(1)
    .describe(
      "Kenari image model id, e.g. 'gpt-image-2'. Call list_media_models first for exact ids and per-image IDR costs.",
    ),
  prompt: z
    .string()
    .min(1)
    .describe("What to generate. Be specific and descriptive for best results."),
  n: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "How many images to generate (integer >= 1). Defaults to 1. Capped by KENARI_MAX_IMAGE_N (default 4). Each image costs IDR.",
    ),
  size: z
    .string()
    .optional()
    .describe("Image dimensions, e.g. '1024x1024'. Optional and model-dependent."),
  background: z
    .enum(["transparent", "opaque", "auto"])
    .optional()
    .describe(
      "Background handling: 'transparent', 'opaque', or 'auto'. Optional; not all models support transparency.",
    ),
  preview: z
    .boolean()
    .default(false)
    .describe(
      "Request lower-quality previews. Files are still saved and no base64 is returned. Does NOT reduce Kenari cost.",
    ),
});

export const editImageSchema = z.object({
  model: z
    .string()
    .min(1)
    .describe(
      "Kenari image model id, e.g. 'gpt-image-2'. Call list_media_models first for exact ids and per-image IDR costs.",
    ),
  prompt: z
    .string()
    .min(1)
    .describe("What to change in the image. Be specific about the edit."),
  image_path: z
    .string()
    .min(1)
    .describe("Absolute path to the local image file to edit (uploaded as multipart 'image')."),
  mask_path: z
    .string()
    .optional()
    .describe(
      "Optional absolute path to a mask image (multipart 'mask'). Transparent areas of the mask mark where to edit.",
    ),
  n: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "How many edited images to produce (integer >= 1). Defaults to 1. Capped by KENARI_MAX_IMAGE_N (default 4). Each image costs IDR.",
    ),
  size: z
    .string()
    .optional()
    .describe("Output image dimensions, e.g. '1024x1024'. Optional and model-dependent."),
  background: z
    .enum(["opaque", "auto"])
    .optional()
    .describe(
      "Background handling for the edited result: 'opaque' or 'auto' only. 'transparent' is rejected here — use generate_image instead.",
    ),
});

export const createVideoSchema = z.object({
  model: z
    .string()
    .min(1)
    .describe(
      "Kenari video-generation model id. Call list_media_models (modality='video') first for exact ids and availability.",
    ),
  prompt: z
    .string()
    .min(1)
    .describe("Describe the video to generate."),
  duration: z
    .number()
    .positive()
    .optional()
    .describe("Clip length in seconds. Optional; capped by KENARI_MAX_VIDEO_DURATION (default 15)."),
  resolution: z
    .string()
    .optional()
    .describe("Output resolution, e.g. '720p' or '1080p'. Optional and model-dependent."),
  image_url: z
    .string()
    .optional()
    .describe("Optional https or data: URL of an image to use as the first/start frame."),
  end_image_url: z
    .string()
    .optional()
    .describe("Optional https or data: URL of an image to use as the final frame (interpolated transition)."),
  input_images: z
    .array(z.string())
    .optional()
    .describe("Optional list of https or data: image URLs to condition the video on."),
  video_url: z
    .string()
    .optional()
    .describe("Optional https URL of a source video for video-to-video transforms."),
  aspect_ratio: z
    .string()
    .optional()
    .describe("Aspect ratio, e.g. '16:9' or '9:16'. Optional and model-dependent."),
});

export const extendVideoSchema = z.object({
  model: z
    .string()
    .min(1)
    .describe("Kenari video-generation model id to use for the extension."),
  source: z
    .string()
    .min(1)
    .describe(
      "A Kenari video job id (from create_video/extend_video) or an https URL of a finished video. Local file paths are rejected before any HTTP call.",
    ),
  prompt: z
    .string()
    .optional()
    .describe("Optional continuation prompt describing how the video should continue."),
  duration: z
    .number()
    .positive()
    .optional()
    .describe("Extension length in seconds. Optional; capped by KENARI_MAX_VIDEO_DURATION (default 15)."),
});

export const getVideoStatusSchema = z.object({
  id: z.string().min(1).describe("Kenari video job id returned by create_video or extend_video."),
});

export const waitForVideoSchema = z.object({
  id: z.string().min(1).describe("Kenari video job id returned by create_video or extend_video."),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .default(1_200_000)
    .describe(
      "Maximum time to keep polling in milliseconds (>= 1000). Defaults to 1200000 (20 min). On timeout returns still_rendering (not an error) — call again.",
    ),
  download: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), auto-download the finished video to KENARI_OUTPUT_DIR and return its absolute path.",
    ),
});

export const downloadVideoSchema = z.object({
  id: z.string().min(1).describe("Kenari video job id whose finished bytes should be downloaded."),
});

/* ------------------------------------------------------------------ */
/* Output schemas — handlers return BOTH success (ok()) and error     */
/* (err()) payloads, and the SDK validates structuredContent against  */
/* outputSchema whenever the result is not isError. So every success  */
/* field is OPTIONAL and objects are loose (extra keys never fail).   */
/* ------------------------------------------------------------------ */

/** Optional error/status fields shared by all tool outputs. */
const errorFields = {
  code: z
    .string()
    .optional()
    .describe(
      "Machine-readable code: an error code (e.g. unauthorized, bad_request, upstream_error) or a state marker (e.g. rendering, done, still_rendering).",
    ),
  op: z.string().optional().describe("Tool operation name the error occurred in."),
  status: z
    .union([z.number(), z.string()])
    .optional()
    .describe(
      "HTTP status number (on API errors) or the Kenari job status string (on video status results).",
    ),
  hint: z.string().optional().describe("Human-readable remediation hint (e.g. set KENARI_API_KEY)."),
  disabled: z
    .boolean()
    .optional()
    .describe("True when video tools are disabled via KENARI_ALLOW_VIDEO=0."),
  id: z.string().optional().describe("Kenari video job id, when relevant to the result or error."),
};

export const listMediaModelsOutputSchema = z.looseObject({
  models: z
    .array(
      z.looseObject({
        id: z.string().optional().describe("Kenari model id."),
        owned_by: z.string().nullable().optional().describe("Owner/org of the model, when known."),
        endpoints: z
          .array(z.string())
          .optional()
          .describe("Kenari endpoints the model serves (e.g. 'images', 'chat')."),
        modalities: z.unknown().optional().describe("Input/output modalities reported by the catalog."),
        cost_idr_per_image: z
          .number()
          .nullable()
          .optional()
          .describe("Kenari price in IDR per generated image; null when not priced."),
      }),
    )
    .optional()
    .describe("Kenari media-capable models matching the modality filter."),
  ...errorFields,
});

const imageOutputFields = () => ({
  model: z.string().optional().describe("Kenari image model id used."),
  paths: z
    .array(z.string())
    .optional()
    .describe("Absolute local paths of the saved image files under KENARI_OUTPUT_DIR."),
  count: z.number().optional().describe("Number of images saved."),
  ...errorFields,
});

export const generateImageOutputSchema = z.looseObject(imageOutputFields());
export const editImageOutputSchema = z.looseObject(imageOutputFields());

const videoJobOutputFields = () => ({
  ...errorFields,
  model: z.string().optional().describe("Kenari video model id used."),
  raw: z.unknown().optional().describe("Raw Kenari API response object."),
});

export const createVideoOutputSchema = z.looseObject(videoJobOutputFields());
export const extendVideoOutputSchema = z.looseObject(videoJobOutputFields());

const videoStatusOutputFields = () => ({
  ...errorFields,
  paths: z
    .array(z.string())
    .optional()
    .describe("Absolute local paths of downloaded video files (when done and downloaded)."),
});

export const getVideoStatusOutputSchema = z.looseObject(videoStatusOutputFields());
export const waitForVideoOutputSchema = z.looseObject(videoStatusOutputFields());
export const downloadVideoOutputSchema = z.looseObject(videoStatusOutputFields());
