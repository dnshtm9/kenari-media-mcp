export interface KenariModel {
  id: string;
  owned_by?: string;
  endpoints?: string[];
  modalities?: { input?: string[]; output?: string[] };
  pricing_lines?: Array<{
    billable?: string;
    endpoint?: string;
    micro_idr?: number | null;
    unit?: string;
    variant?: string | null;
  }>;
  [key: string]: unknown;
}

/** Image-capable: endpoints includes "images" OR output modalities include "image". */
export function isImageModel(m: KenariModel): boolean {
  const endpoints = m.endpoints ?? [];
  const output = m.modalities?.output ?? [];
  return endpoints.includes("images") || output.includes("image");
}

/**
 * Video-generation-capable: endpoints includes "video"/"videos" OR output
 * modalities include "video". NEVER treat modalities.input containing "video"
 * as generation (those are chat video-understanding models).
 */
export function isVideoGenModel(m: KenariModel): boolean {
  const endpoints = m.endpoints ?? [];
  const output = m.modalities?.output ?? [];
  return (
    endpoints.includes("video") || endpoints.includes("videos") || output.includes("video")
  );
}

/**
 * Per-image cost in IDR. Uses pricing_lines where billable == "output_image"
 * and unit == "image": IDR = micro_idr / 1_000_000. Ignores pricing.input /
 * pricing.output (zeros on image models). Returns undefined when unknown.
 */
export function imageCostIdr(m: KenariModel): number | undefined {
  const lines = m.pricing_lines ?? [];
  const line = lines.find((l) => l.billable === "output_image" && l.unit === "image");
  if (!line || typeof line.micro_idr !== "number") return undefined;
  return line.micro_idr / 1_000_000;
}

/**
 * Per-unit video cost in IDR (unit decided by the pricing line: per second for
 * `second`-style units, flat per call for `video`/`call` units). Probes
 * pricing_lines where billable == "output_video" and unit matches
 * second|video|call variants (e.g. "second", "second_1m"?) — pattern-based so
 * new unit spellings still parse. No video model has appeared in the catalog
 * yet; this returns undefined (= fail-open) until calibration is possible.
 */
export function videoCostIdr(
  m: KenariModel,
): { perSecond?: number; flatPerCall?: number } | undefined {
  const lines = m.pricing_lines ?? [];
  const line = lines.find(
    (l) =>
      l.billable === "output_video" &&
      typeof l.unit === "string" &&
      /^(second|seconds?_1m|video|call|per_call)$/i.test(l.unit),
  );
  if (!line || typeof line.micro_idr !== "number") return undefined;
  const idr = line.micro_idr / 1_000_000;
  if (/^(video|call|per_call)$/i.test(line.unit!)) return { flatPerCall: idr };
  return { perSecond: idr };
}

export function filterModels(
  models: KenariModel[],
  modality: "image" | "video" | undefined,
): KenariModel[] {
  if (modality === "image") return models.filter(isImageModel);
  if (modality === "video") return models.filter(isVideoGenModel);
  return models.filter((m) => isImageModel(m) || isVideoGenModel(m));
}
