import type { MediaGenerationProvider } from "@rakazo/adapter-kit";
import {
  FakeMediaGenerationProvider,
  FalMediaGenerationProvider,
} from "./media-generation-provider.js";
import { NewApiMediaGenerationProvider } from "./newapi-media-generation-provider.js";

export function createMediaGenerationProvider(
  env: NodeJS.ProcessEnv = process.env,
): MediaGenerationProvider | undefined {
  const kind = env.MEDIA_GENERATION_PROVIDER?.trim().toLowerCase();
  if (!kind || kind === "disabled") return undefined;
  if (kind === "fake") return new FakeMediaGenerationProvider();
  if (kind !== "fal" && kind !== "newapi") throw new Error("Unknown media generation provider");
  const apiKey = env.MEDIA_GENERATION_API_KEY?.trim();
  const imageModel = env.MEDIA_GENERATION_IMAGE_MODEL?.trim();
  const videoModel = env.MEDIA_GENERATION_VIDEO_MODEL?.trim();
  if (!apiKey || (!imageModel && !videoModel))
    throw new Error("Media generation requires credentials and at least one model");
  if (kind === "newapi") {
    const baseUrl = env.MEDIA_GENERATION_BASE_URL?.trim();
    if (!baseUrl) throw new Error("New API media generation requires MEDIA_GENERATION_BASE_URL");
    const duration = Number(env.MEDIA_GENERATION_VIDEO_DURATION);
    return new NewApiMediaGenerationProvider({
      apiKey,
      baseUrl,
      imageModel,
      videoModel,
      imageSize: env.MEDIA_GENERATION_IMAGE_SIZE?.trim() || undefined,
      videoRatio: env.MEDIA_GENERATION_VIDEO_RATIO?.trim() || undefined,
      videoDuration: Number.isInteger(duration) && duration > 0 ? duration : undefined,
      videoResolution: env.MEDIA_GENERATION_VIDEO_RESOLUTION?.trim() || undefined,
    });
  }
  return new FalMediaGenerationProvider({
    apiKey,
    imageModel,
    videoModel,
    baseUrl: env.MEDIA_GENERATION_BASE_URL,
  });
}
