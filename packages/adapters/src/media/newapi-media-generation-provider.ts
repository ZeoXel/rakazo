import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationInput,
  MediaGenerationProvider,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { deadlineSignal, ResponseTooLargeError } from "@rakazo/core";
import { z } from "zod";
import type { ResolveHostname } from "../web/web-ssrf.js";
import { fetchSafeWebBytes } from "../web/web-ssrf.js";
import { mediaPromptSchema, validateGeneratedMedia } from "./media-generation-provider.js";

/**
 * Media generation through a New API gateway (OpenAI-compatible relay).
 *
 * Images: `POST /v1/images/generations` with a Seedream (or other) image model, base64 output.
 * Video: Volcengine Ark task format relayed by New API at
 * `/doubao/api/v3/contents/generations/tasks`, polled at the same path plus the task id.
 * The gateway token is a relay credential only; it is never sent to an output host.
 */
export type NewApiMediaOptions = {
  apiKey: string;
  baseUrl: string;
  imageModel?: string;
  videoModel?: string;
  /** Seedream accepts "2K" / "4K" or "WxH"; default keeps PNG output under the attachment limit. */
  imageSize?: string;
  /** Ark video parameters. */
  videoRatio?: string;
  videoDuration?: number;
  videoResolution?: string;
  fetch?: typeof fetch;
  resolveHostname?: ResolveHostname;
};

const loadSharp = async () => (await import("sharp")).default;
const MAX_REFERENCES = 4;
const REFERENCE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const TASK_ID = /^[a-zA-Z0-9_.:-]{1,200}$/;
const imageResponse = z.object({
  data: z.array(z.object({ b64_json: z.string().optional(), url: z.string().optional() })).min(1),
});
const videoSubmit = z.object({ id: z.string().regex(TASK_ID) });
const videoStatus = z.object({
  status: z.string(),
  content: z.object({ video_url: z.string().url().optional() }).partial().optional(),
});

export class NewApiMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "newapi";
  readonly capabilities;
  private readonly baseUrl: string;
  constructor(private readonly options: NewApiMediaOptions) {
    const url = new URL(options.baseUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid media generation base URL");
    this.baseUrl = url.href.replace(/\/$/, "");
    for (const model of [options.imageModel, options.videoModel]) {
      if (model && !MODEL.test(model)) throw new Error("Invalid media model id");
    }
    this.capabilities = {
      images: Boolean(options.imageModel),
      video: Boolean(options.videoModel),
      offline: false,
      references: MAX_REFERENCES,
    };
  }

  private async call(
    path: string,
    context: AdapterContext,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    context.signal.throwIfAborted();
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.baseUrl}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        signal: deadlineSignal(timeoutMs, context.signal),
        redirect: "error",
      });
    } catch {
      context.signal.throwIfAborted();
      throw new MediaGenerationError("provider_failure");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MediaGenerationError(
        response.status === 429
          ? "rate_limit"
          : [401, 403].includes(response.status)
            ? "authentication"
            : [400, 422].includes(response.status)
              ? "invalid_input"
              : "provider_failure",
        // A 4xx answer, or a gateway with no channel for the model, means nothing was started.
        (response.status >= 400 && response.status < 500) || response.status === 503,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new MediaGenerationError("provider_failure");
    }
  }

  /** Reference images the model accepts; anything else is re-encoded to PNG. */
  private async references(input: MediaGenerationInput) {
    const refs = input.references ?? [];
    if (refs.length > MAX_REFERENCES) throw new MediaGenerationError("invalid_input");
    return Promise.all(
      refs.map(async (ref) => {
        if (REFERENCE_TYPES.has(ref.mimeType)) return ref;
        try {
          const bytes = await (await loadSharp())(ref.bytes).png().toBuffer();
          return { ...ref, bytes, mimeType: "image/png" };
        } catch {
          throw new MediaGenerationError("invalid_input");
        }
      }),
    );
  }

  /** Rakazo attachments are PNG; Seedream returns JPEG. Re-encode and keep under the limit. */
  private async toPng(bytes: Uint8Array): Promise<GeneratedMedia> {
    for (const side of [2048, 1536, 1024]) {
      const png = await (await loadSharp())(bytes)
        .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();
      if (png.byteLength <= ATTACHMENT_MAX_BYTES) {
        const output: GeneratedMedia = { bytes: png, mimeType: "image/png" };
        validateGeneratedMedia(output, "image/png");
        return output;
      }
    }
    throw new MediaGenerationError("output_limit");
  }

  private async download(url: string, maxBytes: number, context: AdapterContext) {
    try {
      // Output URLs are untrusted: public DNS only, no redirects, no gateway credential sent.
      return await fetchSafeWebBytes(url, {
        fetch: this.options.fetch,
        resolveHostname: this.options.resolveHostname,
        signal: context.signal,
        maxBytes,
        maxRedirects: 0,
        timeoutMs: 90_000,
      });
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof MediaGenerationError) throw error;
      throw new MediaGenerationError(
        error instanceof ResponseTooLargeError ? "output_limit" : "provider_failure",
      );
    }
  }

  async generateImage(
    input: MediaGenerationInput,
    context: AdapterContext,
  ): Promise<GeneratedMedia> {
    const model = this.options.imageModel;
    if (!model) throw new MediaGenerationError("unsupported");
    const parsed = mediaPromptSchema.safeParse(input);
    if (!parsed.success) throw new MediaGenerationError("invalid_input");
    context = { ...context, signal: deadlineSignal(180_000, context.signal) };
    const refs = await this.references(input);
    const fields = {
      model,
      prompt: parsed.data.prompt,
      n: 1,
      size: this.options.imageSize ?? "2K",
      response_format: "b64_json",
      // Seedream adds a visible mark unless told not to; disclosure is handled by the product.
      ...(/seedream/i.test(model) ? { watermark: false } : {}),
    };
    let body: unknown = fields;
    if (refs.length) {
      // With references the gateway's edit endpoint takes the images as repeated `image` parts.
      const form = new FormData();
      for (const ref of refs)
        form.append(
          "image",
          new Blob([new Uint8Array(ref.bytes)], { type: ref.mimeType }),
          ref.name,
        );
      for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
      body = form;
    }
    const result = imageResponse.safeParse(
      await this.call(
        refs.length ? "/v1/images/edits" : "/v1/images/generations",
        context,
        body,
        170_000,
      ),
    );
    if (!result.success) throw new MediaGenerationError("provider_failure");
    const first = result.data.data[0]!;
    let bytes: Uint8Array;
    if (first.b64_json) {
      if (first.b64_json.length > 60 * 1024 * 1024) throw new MediaGenerationError("output_limit");
      bytes = Buffer.from(first.b64_json, "base64");
    } else if (first.url) {
      bytes = (await this.download(first.url, 40 * 1024 * 1024, context)).body;
    } else throw new MediaGenerationError("provider_failure");
    try {
      return await this.toPng(bytes);
    } catch (error) {
      if (error instanceof MediaGenerationError) throw error;
      throw new MediaGenerationError("provider_failure");
    }
  }

  async generateVideo(
    input: MediaGenerationInput,
    context: AdapterContext,
  ): Promise<MediaVideoJob> {
    const model = this.options.videoModel;
    if (!model) throw new MediaGenerationError("unsupported");
    const parsed = mediaPromptSchema.safeParse(input);
    if (!parsed.success) throw new MediaGenerationError("invalid_input");
    const refs = await this.references(input);
    const job = videoSubmit.safeParse(
      await this.call(
        "/doubao/api/v3/contents/generations/tasks",
        context,
        {
          model,
          content: [
            { type: "text", text: parsed.data.prompt },
            ...refs.map((ref) => ({
              type: "image_url",
              role: "reference_image",
              image_url: {
                url: `data:${ref.mimeType};base64,${Buffer.from(ref.bytes).toString("base64")}`,
              },
            })),
          ],
          ratio: this.options.videoRatio ?? "16:9",
          duration: this.options.videoDuration ?? 5,
          resolution: this.options.videoResolution ?? "720p",
          watermark: false,
        },
        120_000,
      ),
    );
    if (!job.success) throw new MediaGenerationError("provider_failure");
    return { id: job.data.id, status: "queued" };
  }

  async pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob> {
    if (!TASK_ID.test(id)) throw new MediaGenerationError("invalid_input");
    const status = videoStatus.safeParse(
      await this.call(
        `/doubao/api/v3/contents/generations/tasks/${encodeURIComponent(id)}`,
        context,
      ),
    );
    if (!status.success) throw new MediaGenerationError("provider_failure");
    const state = status.data.status;
    if (["failed", "cancelled", "expired"].includes(state)) return { id, status: "failed" };
    if (state === "queued") return { id, status: "queued" };
    if (state !== "succeeded") return { id, status: "running" };
    const url = status.data.content?.video_url;
    if (!url) throw new MediaGenerationError("provider_failure");
    const fetched = await this.download(url, ATTACHMENT_MAX_BYTES, context);
    const type = fetched.contentType?.split(";")[0]?.trim().toLowerCase();
    if (type && type !== "video/mp4" && type !== "application/octet-stream")
      throw new MediaGenerationError("provider_failure");
    const output: GeneratedMedia = { bytes: fetched.body, mimeType: "video/mp4" };
    validateGeneratedMedia(output, "video/mp4");
    return { id, status: "completed", output };
  }
}
