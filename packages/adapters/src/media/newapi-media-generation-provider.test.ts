import type { AdapterContext } from "@rakazo/adapter-kit";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createMediaGenerationProvider } from "./media-generation-factory.js";
import { NewApiMediaGenerationProvider } from "./newapi-media-generation-provider.js";

const context: AdapterContext = {
  spaceId: "space",
  userId: "owner",
  operationId: "op",
  traceId: "trace",
  signal: new AbortController().signal,
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function setup(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return {
    fetch,
    provider: new NewApiMediaGenerationProvider({
      apiKey: "relay-token",
      baseUrl: "https://gateway.example.test",
      imageModel: "doubao-seedream-5-0-260128",
      videoModel: "doubao-seedance-2-0-260128",
      fetch,
      resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
  };
}

describe("New API media generation", () => {
  it("is selected by the factory and requires a base URL", () => {
    const env = {
      MEDIA_GENERATION_PROVIDER: "newapi",
      MEDIA_GENERATION_API_KEY: "k",
      MEDIA_GENERATION_IMAGE_MODEL: "doubao-seedream-5-0-260128",
    };
    expect(() => createMediaGenerationProvider(env)).toThrow(/BASE_URL/);
    const provider = createMediaGenerationProvider({
      ...env,
      MEDIA_GENERATION_BASE_URL: "https://gateway.example.test/",
    });
    expect(provider?.id).toBe("newapi");
    expect(provider?.capabilities).toEqual({ images: true, video: false, offline: false });
  });

  it("generates an image and re-encodes the JPEG as PNG", async () => {
    const jpeg = await sharp({
      create: { width: 64, height: 32, channels: 3, background: "#808080" },
    })
      .jpeg()
      .toBuffer();
    const { fetch, provider } = setup(json({ data: [{ b64_json: jpeg.toString("base64") }] }));
    const output = await provider.generateImage(
      { prompt: "grey blanket in a living room" },
      context,
    );
    expect(output.mimeType).toBe("image/png");
    const meta = await sharp(output.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 64, 32]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://gateway.example.test/v1/images/generations");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer relay-token" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "doubao-seedream-5-0-260128",
      response_format: "b64_json",
      watermark: false,
      n: 1,
    });
  });

  it("maps gateway rejections to error codes", async () => {
    await expect(
      setup(json({}, 401)).provider.generateImage({ prompt: "x" }, context),
    ).rejects.toMatchObject({ code: "authentication" });
    await expect(
      setup(json({}, 429)).provider.generateImage({ prompt: "x" }, context),
    ).rejects.toMatchObject({ code: "rate_limit" });
  });

  it("submits a video task and polls it to completion", async () => {
    const mp4 = Buffer.from("00000018667479706d703432", "hex");
    const { fetch, provider } = setup(
      json({ id: "cgt-123" }),
      json({ id: "cgt-123", status: "running" }),
      json({
        id: "cgt-123",
        status: "succeeded",
        content: { video_url: "https://ark-output.example.test/v.mp4" },
      }),
      new Response(mp4, { headers: { "content-type": "video/mp4" } }),
    );
    expect(await provider.generateVideo({ prompt: "rotating blanket" }, context)).toEqual({
      id: "cgt-123",
      status: "queued",
    });
    expect(fetch.mock.calls[0]![0]).toBe(
      "https://gateway.example.test/doubao/api/v3/contents/generations/tasks",
    );
    expect(await provider.pollVideo("cgt-123", context)).toEqual({
      id: "cgt-123",
      status: "running",
    });
    const done = await provider.pollVideo("cgt-123", context);
    expect(done.status).toBe("completed");
    expect(fetch.mock.calls[2]![0]).toBe(
      "https://gateway.example.test/doubao/api/v3/contents/generations/tasks/cgt-123",
    );
    // The gateway token never reaches the output host.
    const outputInit = fetch.mock.calls[3]![1];
    expect(JSON.stringify(outputInit?.headers ?? {})).not.toContain("relay-token");
  });

  it("reports failed video tasks and rejects malformed ids", async () => {
    const { provider } = setup(json({ id: "cgt-1", status: "failed" }));
    expect(await provider.pollVideo("cgt-1", context)).toEqual({ id: "cgt-1", status: "failed" });
    await expect(provider.pollVideo("../x", context)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
