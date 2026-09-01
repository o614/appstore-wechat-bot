import { describe, expect, it, vi } from "vitest";

import { searchFirstUsApp } from "../src/appleSearch";
import type { MessageStateStore } from "../src/state";

function memoryStore(): MessageStateStore {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => {
      values.set(key, value);
    },
  };
}

const gemini = {
  trackId: 6477489729,
  trackName: "Google Gemini",
  trackViewUrl: "https://apps.apple.com/us/app/google-gemini/id6477489729",
  sellerName: "Google LLC",
  currency: "USD",
  formattedPrice: "Free",
  price: 0,
  averageUserRating: 4.7,
  userRatingCount: 500_000,
  fileSizeBytes: "300000000",
  currentVersionReleaseDate: "2026-08-31T00:00:00Z",
  minimumOsVersion: "16.0",
  version: "1.2026.240",
  primaryGenreName: "Productivity",
};

function serializedPage(value: unknown): string {
  return [
    "<!doctype html>",
    '<script type="application/json" id="serialized-server-data">',
    JSON.stringify(value),
    "</script>",
  ].join("");
}

function officialSearchPage(
  apps: Array<{ id: string; name: string; developer: string }>,
): string {
  return serializedPage(
    apps.map((app) => ({
      resultType: "lockup",
      lockup: {
        adamId: app.id,
        title: app.name,
        subtitle: app.developer,
      },
    })),
  );
}

function officialDetailPage(): string {
  return [
    "<!doctype html>",
    '<script type="application/ld+json">',
    JSON.stringify({
      "@type": "SoftwareApplication",
      name: "Google Gemini",
      author: { "@type": "Organization", name: "Google LLC" },
      offers: { "@type": "Offer", price: 0, priceCurrency: "USD" },
      aggregateRating: { ratingValue: 4.7, ratingCount: 500_000 },
      applicationCategory: "Productivity",
    }),
    "</script>",
    '<script type="application/json" id="serialized-server-data">',
    JSON.stringify({
      information: {
        id: "information",
        items: [
          { title: "Seller", description: "Google LLC" },
          { title: "Size", description: "300 MB" },
          { title: "Category", description: "Productivity" },
          { title: "Compatibility", description: "Requires iOS 16.0 or later." },
          { title: "Version", description: "1.2026.240" },
        ],
      },
    }),
    "</script>",
  ].join("");
}

describe("Apple official app search", () => {
  it("uses the US software endpoint, accepts the first result, and caches it", async () => {
    const store = memoryStore();
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ resultCount: 1, results: [gemini] }),
    );

    const first = await searchFirstUsApp("Gemini", store, fetcher);
    const second = await searchFirstUsApp("gemini", store, fetcher);

    expect(first).toMatchObject({
      trackId: "6477489729",
      trackName: "Google Gemini",
      sellerName: "Google LLC",
    });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const [input] = fetcher.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.origin).toBe("https://itunes.apple.com");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("country")).toBe("us");
    expect(url.searchParams.get("entity")).toBe("software");
    expect(url.searchParams.get("media")).toBe("software");
    expect(url.searchParams.get("limit")).toBe("1");
  });

  it("falls back to the official App Store page after an API 429", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "itunes.apple.com") {
        return new Response("rate limited", { status: 429 });
      }
      if (url.pathname === "/us/iphone/search") {
        return new Response(
          officialSearchPage([
            {
              id: "6477489729",
              name: "Google Gemini",
              developer: "Google",
            },
            {
              id: "1673276505",
              name: "Gemini Markets & Credit Card",
              developer: "Gemini Trust Company, LLC",
            },
          ]),
        );
      }
      return new Response(officialDetailPage());
    });

    const app = await searchFirstUsApp("Gemini", memoryStore(), fetcher);

    expect(app).toMatchObject({
      trackId: "6477489729",
      trackName: "Google Gemini",
      sellerName: "Google LLC",
      formattedPrice: "Free",
      primaryGenreName: "Productivity",
      minimumOsVersion: "16.0",
      version: "1.2026.240",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const urls = fetcher.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls[0]?.hostname).toBe("itunes.apple.com");
    expect(urls[1]?.pathname).toBe("/us/iphone/search");
    expect(urls[2]?.pathname).toBe("/us/app/id6477489729");
  });

  it("does not fall back when the API confirms that no app was found", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ resultCount: 0, results: [] }),
    );

    await expect(
      searchFirstUsApp("not-a-real-app", memoryStore(), fetcher),
    ).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps a correctly locked App ID when detail enrichment fails", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "itunes.apple.com") {
        return new Response("rate limited", { status: 429 });
      }
      if (url.pathname === "/us/iphone/search") {
        return new Response(
          officialSearchPage([
            {
              id: "6477489729",
              name: "Google Gemini",
              developer: "Google",
            },
          ]),
        );
      }
      return new Response("detail unavailable", { status: 503 });
    });

    const app = await searchFirstUsApp("Gemini", memoryStore(), fetcher);

    expect(app).toMatchObject({
      trackId: "6477489729",
      trackName: "Google Gemini",
      sellerName: "Google",
      price: -1,
    });
  });

  it("distinguishes a confirmed empty result from an upstream failure", async () => {
    const store = memoryStore();
    const emptyFetcher = vi.fn(async () =>
      Response.json({ resultCount: 0, results: [] }),
    );

    await expect(
      searchFirstUsApp("not-a-real-app", store, emptyFetcher),
    ).resolves.toBeNull();

    const unavailableFetcher = vi.fn(async () =>
      new Response("unavailable", { status: 503 }),
    );
    await expect(
      searchFirstUsApp("another-app", store, unavailableFetcher),
    ).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("rejects malformed Apple payloads instead of guessing fields", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ resultCount: 1, results: [{ trackName: "No ID" }] }),
    );

    await expect(
      searchFirstUsApp("broken", memoryStore(), fetcher),
    ).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("reports a timeout separately", async () => {
    const fetcher = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });

    await expect(
      searchFirstUsApp("slow", memoryStore(), fetcher),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});
