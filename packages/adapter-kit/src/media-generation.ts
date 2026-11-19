import type { AdapterContext } from "./types.js";

/** An image the user supplied (a product photo, a style sample) for the model to work from. */
export type MediaReference = { bytes: Uint8Array; mimeType: string; name: string };
export type MediaGenerationInput = { prompt: string; references?: MediaReference[] };
export type GeneratedMedia = {
  bytes: Uint8Array;
  mimeType: "image/png" | "video/mp4";
};
export type MediaVideoJob =
  | { id: string; status: "queued" | "running"; progress?: number }
  | { id: string; status: "completed"; output: GeneratedMedia }
  | { id: string; status: "failed" };
export interface MediaGenerationProvider {
  readonly id: string;
  readonly capabilities: {
    images: boolean;
    video: boolean;
    offline: boolean;
    /** Most reference images one request accepts; absent or 0 means prompt only. */
    references?: number;
  };
  generateImage(input: MediaGenerationInput, context: AdapterContext): Promise<GeneratedMedia>;
  generateVideo(input: MediaGenerationInput, context: AdapterContext): Promise<MediaVideoJob>;
  pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob>;
}
export type MediaGenerationErrorCode =
  | "invalid_input"
  | "unsupported"
  | "authentication"
  | "rate_limit"
  | "provider_failure"
  | "output_limit";
export class MediaGenerationError extends Error {
  /**
   * @param refused the provider answered that it did not take the request (nothing was started
   * or billed), so the caller may give back the submission it counted for it.
   */
  constructor(
    public readonly code: MediaGenerationErrorCode,
    public readonly refused = false,
  ) {
    super(`Media generation: ${code}`);
    this.name = "MediaGenerationError";
  }
}
