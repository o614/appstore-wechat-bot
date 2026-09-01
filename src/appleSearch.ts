import type { AppSummary } from "./appTypes";
import { readResponseTextBounded } from "./http";
import type { MessageStateStore } from "./state";

const APPLE_API_TIMEOUT_MS = 900;
const APPLE_PAGE_TIMEOUT_MS = 1_800;
const APPLE_SEARCH_TOTAL_TIMEOUT_MS = 3_200;
const APPLE_API_MAX_BYTES = 256 * 1024;
const APPLE_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const SEARCH_CACHE_TTL_SECONDS = 6 * 60 * 60;
const NOT_FOUND_CACHE_TTL_SECONDS = 5 * 60;
const SERIALIZED_DATA_MARKER =
  '<script type="application/json" id="serialized-server-data">';
const SCRIPT_END_MARKER = "</script>";
const APPLE_HEADERS = {
  Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Safari/537.36",
} as const;

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

function numberField(
  record: Record<string, unknown>,
  key: string,
  fallback = 0,
): number {
  const value = Number(record[key]);
  return Number.isFinite(value) ? value : fallback;
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
    price: numberField(value, "price", -1),
    averageUserRating: numberField(value, "averageUserRating"),
    userRatingCount: numberField(value, "userRatingCount"),
    fileSizeBytes: String(value.fileSizeBytes ?? ""),
    currentVersionReleaseDate: stringField(value, "currentVersionReleaseDate"),
    minimumOsVersion: stringField(value, "minimumOsVersion"),
    version: stringField(value, "version"),
    primaryGenreName: stringField(value, "primaryGenreName"),
  };
}

function emptyApp(trackId: string, trackName: string, sellerName = ""): AppSummary {
  return {
    trackId,
    trackName,
    trackViewUrl: `https://apps.apple.com/us/app/id${trackId}`,
    sellerName,
    currency: "",
    formattedPrice: "",
    price: -1,
    averageUserRating: 0,
    userRatingCount: 0,
    fileSizeBytes: "",
    currentVersionReleaseDate: "",
    minimumOsVersion: "",
    version: "",
    primaryGenreName: "",
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
  return `app-search:v2:us:${await sha256(normalizeSearchTerm(query))}`;
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

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function requestSignal(totalSignal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([totalSignal, AbortSignal.timeout(timeoutMs)]);
}

async function fetchAppleText(
  url: URL,
  maxBytes: number,
  timeoutMs: number,
  totalSignal: AbortSignal,
  fetcher: Fetcher,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: APPLE_HEADERS,
      redirect: "follow",
      signal: requestSignal(totalSignal, timeoutMs),
    });
  } catch (error) {
    throw new AppleSearchError(
      isTimeoutError(error) || totalSignal.aborted ? "timeout" : "unavailable",
      isTimeoutError(error) || totalSignal.aborted
        ? "apple_search_timeout"
        : "apple_search_unavailable",
    );
  }

  if (!response.ok) {
    if (response.body !== null) await response.body.cancel("upstream_error");
    throw new AppleSearchError(
      "unavailable",
      `apple_search_http_${response.status}`,
    );
  }

  try {
    return await readResponseTextBounded(response, maxBytes);
  } catch {
    throw new AppleSearchError("invalid_response", "apple_response_too_large");
  }
}

async function searchDocumentedApi(
  query: string,
  totalSignal: AbortSignal,
  fetcher: Fetcher,
): Promise<AppSummary | null> {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", query);
  url.searchParams.set("media", "software");
  url.searchParams.set("entity", "software");
  url.searchParams.set("country", "us");
  url.searchParams.set("limit", "1");

  const text = await fetchAppleText(
    url,
    APPLE_API_MAX_BYTES,
    APPLE_API_TIMEOUT_MS,
    totalSignal,
    fetcher,
  );
  try {
    return parseAppleSearchResponse(JSON.parse(text));
  } catch (error) {
    if (error instanceof AppleSearchError) throw error;
    throw new AppleSearchError("invalid_response", "apple_search_invalid_json");
  }
}

function parseSerializedData(html: string): unknown {
  const start = html.indexOf(SERIALIZED_DATA_MARKER);
  if (start === -1) {
    throw new AppleSearchError("invalid_response", "apple_page_marker_missing");
  }
  const contentStart = start + SERIALIZED_DATA_MARKER.length;
  const end = html.indexOf(SCRIPT_END_MARKER, contentStart);
  if (end === -1) {
    throw new AppleSearchError("invalid_response", "apple_page_marker_unclosed");
  }
  try {
    return JSON.parse(html.slice(contentStart, end));
  } catch {
    throw new AppleSearchError("invalid_response", "apple_page_invalid_json");
  }
}

function parseFirstAppSearchPage(html: string): AppSummary | null {
  const root = parseSerializedData(html);
  if (!isRecord(root) && !Array.isArray(root)) {
    throw new AppleSearchError("invalid_response", "apple_page_invalid_root");
  }

  const queue: unknown[] = [root];
  let cursor = 0;
  while (cursor < queue.length && cursor < 20_000) {
    const value = queue[cursor];
    cursor += 1;
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;

    const lockup = value.lockup;
    if (isRecord(lockup)) {
      const trackId = String(lockup.adamId ?? "");
      const trackName = stringField(lockup, "title").trim();
      if (
        value.resultType !== "bundle" &&
        /^\d{6,12}$/u.test(trackId) &&
        trackName
      ) {
        return emptyApp(trackId, trackName, stringField(lockup, "subtitle").trim());
      }
    }
    queue.push(...Object.values(value));
  }
  return null;
}

async function searchPublicStorefront(
  query: string,
  totalSignal: AbortSignal,
  fetcher: Fetcher,
): Promise<AppSummary | null> {
  const url = new URL("https://apps.apple.com/us/iphone/search");
  url.searchParams.set("term", query);
  url.searchParams.set("l", "en");
  const html = await fetchAppleText(
    url,
    APPLE_PAGE_MAX_BYTES,
    APPLE_PAGE_TIMEOUT_MS,
    totalSignal,
    fetcher,
  );
  return parseFirstAppSearchPage(html);
}

function parseJsonLd(html: string): Record<string, unknown> | null {
  const pattern =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu;
  for (const match of html.matchAll(pattern)) {
    try {
      const root: unknown = JSON.parse(match[1] ?? "");
      const queue: unknown[] = [root];
      while (queue.length > 0) {
        const value = queue.shift();
        if (Array.isArray(value)) {
          queue.push(...value);
          continue;
        }
        if (!isRecord(value)) continue;
        if (value["@type"] === "SoftwareApplication") return value;
        queue.push(...Object.values(value));
      }
    } catch {
      // A malformed JSON-LD block must not hide a later valid block.
    }
  }
  return null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (!Array.isArray(value)) return null;
  return value.find(isRecord) ?? null;
}

function parseFileSize(value: string): string {
  const match = value.trim().match(/^([\d.,]+)\s*(B|KB|MB|GB|TB)$/iu);
  if (!match) return "";
  const amount = Number((match[1] ?? "").replaceAll(",", ""));
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const unit = (match[2] ?? "B").toUpperCase();
  const powers: Record<string, number> = {
    B: 0,
    KB: 1,
    MB: 2,
    GB: 3,
    TB: 4,
  };
  return String(Math.round(amount * 1024 ** (powers[unit] ?? 0)));
}

function detailText(value: Record<string, unknown>): string {
  for (const key of ["description", "value", "subtitle", "text"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function parseInformation(html: string): Partial<AppSummary> {
  let root: unknown;
  try {
    root = parseSerializedData(html);
  } catch {
    return {};
  }

  const fields = new Map<string, string>();
  const queue: unknown[] = [root];
  let cursor = 0;
  while (cursor < queue.length && cursor < 50_000) {
    const value = queue[cursor];
    cursor += 1;
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;

    const title = stringField(value, "title").trim();
    const text = detailText(value);
    if (title && text && !fields.has(title)) fields.set(title, text);
    queue.push(...Object.values(value));
  }

  const compatibility = fields.get("Compatibility") ?? "";
  const minimumOsVersion = compatibility.match(/iOS[\s\u00a0]+([\d.]+)/iu)?.[1] ?? "";
  return {
    sellerName: fields.get("Seller") ?? "",
    fileSizeBytes: parseFileSize(fields.get("Size") ?? ""),
    primaryGenreName: fields.get("Category") ?? "",
    minimumOsVersion,
    version: fields.get("Version") ?? "",
  };
}

function parseDetailPage(html: string, fallback: AppSummary): AppSummary {
  const jsonLd = parseJsonLd(html);
  const information = parseInformation(html);
  if (!jsonLd) return { ...fallback, ...information };

  const offers = firstRecord(jsonLd.offers);
  const rating = firstRecord(jsonLd.aggregateRating);
  const author = firstRecord(jsonLd.author);
  const price = offers ? numberField(offers, "price", -1) : -1;
  const trackName = stringField(jsonLd, "name") || fallback.trackName;
  const applicationCategory = stringField(jsonLd, "applicationCategory");

  return {
    ...fallback,
    ...information,
    trackName,
    sellerName:
      stringField(author ?? {}, "name") ||
      information.sellerName ||
      fallback.sellerName,
    currency: stringField(offers ?? {}, "priceCurrency"),
    formattedPrice:
      price === 0
        ? "Free"
        : price >= 0
          ? `${stringField(offers ?? {}, "priceCurrency")} ${price}`.trim()
          : "",
    price,
    averageUserRating: numberField(rating ?? {}, "ratingValue"),
    userRatingCount: numberField(rating ?? {}, "ratingCount"),
    primaryGenreName:
      information.primaryGenreName || applicationCategory || fallback.primaryGenreName,
  };
}

async function enrichFromPublicPage(
  app: AppSummary,
  totalSignal: AbortSignal,
  fetcher: Fetcher,
): Promise<AppSummary> {
  const url = new URL(`https://apps.apple.com/us/app/id${app.trackId}`);
  url.searchParams.set("l", "en");
  const html = await fetchAppleText(
    url,
    APPLE_PAGE_MAX_BYTES,
    APPLE_PAGE_TIMEOUT_MS,
    totalSignal,
    fetcher,
  );
  return parseDetailPage(html, app);
}

function logFallback(error: AppleSearchError): void {
  console.warn(
    JSON.stringify({
      event: "apple_search_api_fallback",
      reason: error.code,
      upstream: error.message,
    }),
  );
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

  const totalSignal = AbortSignal.timeout(APPLE_SEARCH_TOTAL_TIMEOUT_MS);
  let app: AppSummary | null;
  let usedPageFallback = false;

  try {
    app = await searchDocumentedApi(query, totalSignal, fetcher);
  } catch (error) {
    if (!(error instanceof AppleSearchError)) throw error;
    logFallback(error);
    usedPageFallback = true;
    app = await searchPublicStorefront(query, totalSignal, fetcher);
  }

  if (app && usedPageFallback) {
    try {
      app = await enrichFromPublicPage(app, totalSignal, fetcher);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "apple_search_detail_degraded",
          reason:
            error instanceof AppleSearchError ? error.code : "unknown_error",
        }),
      );
    }
  }

  const entry: SearchCacheEntry = app
    ? { status: "found", app }
    : { status: "not_found" };
  await saveCachedSearch(store, cacheKey, entry);
  return app;
}
