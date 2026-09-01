import type { AppSummary } from "./appTypes";
import { readResponseTextBounded } from "./http";
import type { MessageStateStore } from "./state";

const APPLE_SEARCH_TIMEOUT_MS = 2_300;
const APPLE_RESPONSE_MAX_BYTES = 256 * 1024;
const SEARCH_CACHE_TTL_SECONDS = 6 * 60 * 60;
const NOT_FOUND_CACHE_TTL_SECONDS = 5 * 60;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type SearchCacheEntry =
  | { status: "found"; app: AppSummary }
  | { status: "not_found" };

export type AppleSearchErrorCode =
  | "timeout"
  | "unavailable"
  | "invalid_response";

export class AppleSearchError extends Error {
  constructor(
    readonly code: AppleSearchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppleSearchError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = Number(record[key]);
  return Number.isFinite(value) ? value : 0;
}

function parseApp(value: unknown): AppSummary | null {
  if (!isRecord(value)) return null;

  const trackId = String(value.trackId ?? "");
  const trackName = stringField(value, "trackName");
  const trackViewUrl = stringField(value, "trackViewUrl");
  if (!/^\d+$/u.test(trackId) || !trackName || !trackViewUrl) return null;

  return {
    trackId,
    trackName,
    trackViewUrl,
    sellerName: stringField(value, "sellerName"),
    currency: stringField(value, "currency"),
    formattedPrice: stringField(value, "formattedPrice"),
    price: numberField(value, "price"),
    averageUserRating: numberField(value, "averageUserRating"),
    userRatingCount: numberField(value, "userRatingCount"),
    fileSizeBytes: String(value.fileSizeBytes ?? ""),
    currentVersionReleaseDate: stringField(value, "currentVersionReleaseDate"),
    minimumOsVersion: stringField(value, "minimumOsVersion"),
    version: stringField(value, "version"),
    primaryGenreName: stringField(value, "primaryGenreName"),
  };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeSearchTerm(query: string): string {
  return query.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

async function searchCacheKey(query: string): Promise<string> {
  return `app-search:us:${await sha256(normalizeSearchTerm(query))}`;
}

async function loadCachedSearch(
  store: MessageStateStore,
  key: string,
): Promise<SearchCacheEntry | null> {
  try {
    const raw = await store.get(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.status === "not_found") return { status: "not_found" };
    if (parsed.status !== "found") return null;
    const app = parseApp(parsed.app);
    return app ? { status: "found", app } : null;
  } catch {
    return null;
  }
}

async function saveCachedSearch(
  store: MessageStateStore,
  key: string,
  entry: SearchCacheEntry,
): Promise<void> {
  try {
    await store.put(key, JSON.stringify(entry), {
      expirationTtl:
        entry.status === "found"
          ? SEARCH_CACHE_TTL_SECONDS
          : NOT_FOUND_CACHE_TTL_SECONDS,
    });
  } catch {
    // Search remains available when KV is temporarily unavailable.
  }
}

function parseAppleSearchResponse(value: unknown): AppSummary | null {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new AppleSearchError("invalid_response", "invalid_search_payload");
  }
  if (value.results.length === 0) return null;

  const app = parseApp(value.results[0]);
  if (!app) {
    throw new AppleSearchError("invalid_response", "invalid_app_payload");
  }
  return app;
}

export async function searchFirstUsApp(
  query: string,
  store: MessageStateStore,
  fetcher: Fetcher = fetch,
): Promise<AppSummary | null> {
  const cacheKey = await searchCacheKey(query);
  const cached = await loadCachedSearch(store, cacheKey);
  if (cached?.status === "found") return cached.app;
  if (cached?.status === "not_found") return null;

  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", query);
  url.searchParams.set("media", "software");
  url.searchParams.set("entity", "software");
  url.searchParams.set("country", "us");
  url.searchParams.set("limit", "1");

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(APPLE_SEARCH_TIMEOUT_MS),
    });
  } catch (error) {
    const isTimeout =
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new AppleSearchError(
      isTimeout ? "timeout" : "unavailable",
      isTimeout ? "apple_search_timeout" : "apple_search_unavailable",
    );
  }

  if (!response.ok) {
    if (response.body !== null) await response.body.cancel("upstream_error");
    throw new AppleSearchError("unavailable", `apple_search_http_${response.status}`);
  }

  let payload: unknown;
  try {
    const text = await readResponseTextBounded(
      response,
      APPLE_RESPONSE_MAX_BYTES,
    );
    payload = JSON.parse(text);
  } catch (error) {
    if (error instanceof AppleSearchError) throw error;
    throw new AppleSearchError("invalid_response", "apple_search_invalid_json");
  }

  const app = parseAppleSearchResponse(payload);
  const entry: SearchCacheEntry = app
    ? { status: "found", app }
    : { status: "not_found" };
  await saveCachedSearch(store, cacheKey, entry);
  return app;
}
