import type {
  AppSelection,
  AppSelectionActions,
  AppSummary,
} from "./appTypes";

const MESSAGE_DEDUPLICATION_TTL_SECONDS = 5 * 60;
const APP_SELECTION_TTL_SECONDS = 10 * 60;

const textEncoder = new TextEncoder();

export interface MessageStateStore {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function anonymizeUserId(userId: string): Promise<string> {
  return (await sha256(userId)).slice(0, 16);
}

export async function claimWechatMessage(
  store: MessageStateStore,
  messageIdentity: string,
): Promise<boolean> {
  const key = `wechat-message:${await sha256(messageIdentity)}`;
  const existing = await store.get(key);
  if (existing !== null) return false;

  await store.put(key, "1", {
    expirationTtl: MESSAGE_DEDUPLICATION_TTL_SECONDS,
  });
  return true;
}

function appSelectionKey(userKey: string): string {
  return `app-selection:${userKey}`;
}

function normalizeActionValue(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredApp(value: unknown): AppSummary | null {
  if (!isRecord(value)) return null;
  const trackId = String(value.trackId ?? "");
  const trackName = typeof value.trackName === "string" ? value.trackName : "";
  const trackViewUrl =
    typeof value.trackViewUrl === "string" ? value.trackViewUrl : "";
  if (!/^\d+$/u.test(trackId) || !trackName || !trackViewUrl) return null;

  const stringValue = (key: string): string =>
    typeof value[key] === "string" ? value[key] : "";
  const numberValue = (key: string): number => {
    const number = Number(value[key]);
    return Number.isFinite(number) ? number : 0;
  };

  return {
    trackId,
    trackName,
    trackViewUrl,
    sellerName: stringValue("sellerName"),
    currency: stringValue("currency"),
    formattedPrice: stringValue("formattedPrice"),
    price: numberValue("price"),
    averageUserRating: numberValue("averageUserRating"),
    userRatingCount: numberValue("userRatingCount"),
    fileSizeBytes: stringValue("fileSizeBytes"),
    currentVersionReleaseDate: stringValue("currentVersionReleaseDate"),
    minimumOsVersion: stringValue("minimumOsVersion"),
    version: stringValue("version"),
    primaryGenreName: stringValue("primaryGenreName"),
  };
}

function parseStoredActions(value: unknown): AppSelectionActions | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.inAppPurchase !== "string" ||
    typeof value.priceCompare !== "string"
  ) {
    return null;
  }
  return {
    inAppPurchase: value.inAppPurchase,
    priceCompare: value.priceCompare,
  };
}

function parseStoredSelection(value: unknown): AppSelection | null {
  if (!isRecord(value)) return null;
  const app = parseStoredApp(value.app);
  const actions = parseStoredActions(value.actions);
  if (!app || !actions || value.storefront !== "us") return null;
  return {
    app,
    actions,
    storefront: "us",
    query: typeof value.query === "string" ? value.query : "",
    createdAt: Number.isFinite(Number(value.createdAt))
      ? Number(value.createdAt)
      : 0,
  };
}

export async function saveAppSelection(
  store: MessageStateStore,
  userKey: string,
  selection: AppSelection,
): Promise<void> {
  await store.put(appSelectionKey(userKey), JSON.stringify(selection), {
    expirationTtl: APP_SELECTION_TTL_SECONDS,
  });
}

export async function loadAppSelection(
  store: MessageStateStore,
  userKey: string,
): Promise<AppSelection | null> {
  const raw = await store.get(appSelectionKey(userKey));
  if (raw === null) return null;
  try {
    return parseStoredSelection(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function resolveAppSelectionAction(
  store: MessageStateStore,
  userKey: string,
  action: keyof AppSelectionActions,
  query: string,
): Promise<AppSelection | null> {
  const selection = await loadAppSelection(store, userKey);
  if (!selection) return null;
  const expectedCommand = selection.actions[action];
  const expectedQuery = expectedCommand.replace(/^\S+\s*/u, "");
  return normalizeActionValue(expectedQuery) === normalizeActionValue(query)
    ? selection
    : null;
}
