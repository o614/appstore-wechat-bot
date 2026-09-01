import { describe, expect, it } from "vitest";

import type { AppSelection } from "../src/appTypes";
import {
  loadAppSelection,
  resolveAppSelectionAction,
  saveAppSelection,
  type MessageStateStore,
} from "../src/state";

function memoryStore(): MessageStateStore {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => {
      values.set(key, value);
    },
  };
}

function selection(trackId: string, trackName: string): AppSelection {
  return {
    app: {
      trackId,
      trackName,
      trackViewUrl: `https://apps.apple.com/us/app/id${trackId}`,
      sellerName: "Developer",
      currency: "USD",
      formattedPrice: "Free",
      price: 0,
      averageUserRating: 4.5,
      userRatingCount: 100,
      fileSizeBytes: "1000000",
      currentVersionReleaseDate: "2026-09-01T00:00:00Z",
      minimumOsVersion: "16.0",
      version: "1.0",
      primaryGenreName: "Utilities",
    },
    query: trackName,
    storefront: "us",
    actions: {
      inAppPurchase: `内购 ${trackName}`,
      priceCompare: `比价 ${trackName}`,
    },
    createdAt: Date.now(),
  };
}

describe("user app selection", () => {
  it("keeps both actions available after either one is used", async () => {
    const store = memoryStore();
    await saveAppSelection(store, "user", selection("6477489729", "Google Gemini"));

    const iap = await resolveAppSelectionAction(
      store,
      "user",
      "inAppPurchase",
      "Google Gemini",
    );
    const compare = await resolveAppSelectionAction(
      store,
      "user",
      "priceCompare",
      "Google Gemini",
    );

    expect(iap?.app.trackId).toBe("6477489729");
    expect(compare?.app.trackId).toBe("6477489729");
  });

  it("overwrites the previous app and rejects stale action text", async () => {
    const store = memoryStore();
    await saveAppSelection(store, "user", selection("1", "Old App"));
    await saveAppSelection(store, "user", selection("2", "New App"));

    await expect(loadAppSelection(store, "user")).resolves.toMatchObject({
      app: { trackId: "2", trackName: "New App" },
    });
    await expect(
      resolveAppSelectionAction(store, "user", "inAppPurchase", "Old App"),
    ).resolves.toBeNull();
  });

  it("normalizes harmless punctuation and whitespace without accepting another app", async () => {
    const store = memoryStore();
    await saveAppSelection(store, "user", selection("3", "Example: App"));

    await expect(
      resolveAppSelectionAction(
        store,
        "user",
        "priceCompare",
        " example app ",
      ),
    ).resolves.toMatchObject({ app: { trackId: "3" } });
    await expect(
      resolveAppSelectionAction(store, "user", "priceCompare", "Other App"),
    ).resolves.toBeNull();
  });
});
