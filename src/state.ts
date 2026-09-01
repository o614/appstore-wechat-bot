const MESSAGE_DEDUPLICATION_TTL_SECONDS = 5 * 60;

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
