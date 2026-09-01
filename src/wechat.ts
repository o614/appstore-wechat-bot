import { parseCommand } from "./commands";
import { dispatchCommand } from "./handlers";
import {
  anonymizeUserId,
  claimWechatMessage,
  type MessageStateStore,
} from "./state";

const MAX_WECHAT_BODY_BYTES = 64 * 1024;

const textEncoder = new TextEncoder();

export async function createWechatSignature(
  token: string,
  timestamp: string,
  nonce: string,
): Promise<string> {
  const source = [token, timestamp, nonce].sort().join("");
  const digest = await crypto.subtle.digest("SHA-1", textEncoder.encode(source));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

export async function verifyWechatSignature(
  token: string,
  timestamp: string | null,
  nonce: string | null,
  signature: string | null,
): Promise<boolean> {
  if (!timestamp || !nonce || !signature) return false;
  const expected = await createWechatSignature(token, timestamp, nonce);
  return constantTimeEqual(expected, signature.toLowerCase());
}

function extractXmlValue(xml: string, tag: string): string | null {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cdataPattern = new RegExp(
    `<${escapedTag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${escapedTag}>`,
    "i",
  );
  const cdataMatch = cdataPattern.exec(xml);
  if (cdataMatch?.[1] !== undefined) return cdataMatch[1];

  const textPattern = new RegExp(
    `<${escapedTag}>\\s*([\\s\\S]*?)\\s*</${escapedTag}>`,
    "i",
  );
  const textMatch = textPattern.exec(xml);
  return textMatch?.[1] ?? null;
}

interface IncomingTextMessage {
  toUserName: string;
  fromUserName: string;
  content: string;
  createTime: string;
  messageId: string | null;
}

interface WechatHandlerOptions {
  token: string;
  state: MessageStateStore;
  requestId: string;
}

function parseIncomingTextMessage(xml: string): IncomingTextMessage | null {
  const toUserName = extractXmlValue(xml, "ToUserName");
  const fromUserName = extractXmlValue(xml, "FromUserName");
  const messageType = extractXmlValue(xml, "MsgType");
  const content = extractXmlValue(xml, "Content");
  const createTime = extractXmlValue(xml, "CreateTime") ?? "unknown";

  if (!toUserName || !fromUserName || messageType !== "text" || content === null) {
    return null;
  }

  return {
    toUserName,
    fromUserName,
    content,
    createTime,
    messageId: extractXmlValue(xml, "MsgId"),
  };
}

function toCdata(value: string): string {
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

function buildTextReply(
  toUserName: string,
  fromUserName: string,
  content: string,
): string {
  return [
    "<xml>",
    `<ToUserName>${toCdata(toUserName)}</ToUserName>`,
    `<FromUserName>${toCdata(fromUserName)}</FromUserName>`,
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`,
    `<MsgType>${toCdata("text")}</MsgType>`,
    `<Content>${toCdata(content)}</Content>`,
    "</xml>",
  ].join("");
}

function emptyWechatResponse(): Response {
  return new Response("", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function readBoundedText(request: Request): Promise<string | null> {
  const announcedLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(announcedLength) && announcedLength > MAX_WECHAT_BODY_BYTES) {
    return null;
  }

  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_WECHAT_BODY_BYTES) {
        await reader.cancel("payload_too_large");
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function handleWechat(
  request: Request,
  options: WechatHandlerOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const validSignature = await verifyWechatSignature(
    options.token,
    url.searchParams.get("timestamp"),
    url.searchParams.get("nonce"),
    url.searchParams.get("signature"),
  );

  if (!validSignature) {
    return new Response("Invalid signature", { status: 403 });
  }

  if (request.method === "GET") {
    return new Response(url.searchParams.get("echostr") ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, POST" },
    });
  }

  const xml = await readBoundedText(request);
  if (xml === null) {
    return new Response("Payload too large", { status: 413 });
  }

  const message = parseIncomingTextMessage(xml);
  if (!message) return emptyWechatResponse();

  const userKey = await anonymizeUserId(message.fromUserName);
  const parsed = parseCommand(message.content);
  if (parsed.status === "ignored") {
    console.log(
      JSON.stringify({
        event: "wechat_message_ignored",
        requestId: options.requestId,
        userKey,
      }),
    );
    return emptyWechatResponse();
  }

  const messageIdentity =
    message.messageId !== null
      ? `${message.toUserName}:${message.messageId}`
      : [
          message.toUserName,
          message.fromUserName,
          message.createTime,
          message.content,
        ].join(":");

  try {
    const claimed = await claimWechatMessage(options.state, messageIdentity);
    if (!claimed) {
      console.log(
        JSON.stringify({
          event: "wechat_duplicate_ignored",
          requestId: options.requestId,
          userKey,
        }),
      );
      return emptyWechatResponse();
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "wechat_state_unavailable",
        requestId: options.requestId,
        userKey,
        error: error instanceof Error ? error.message : "unknown_error",
      }),
    );
  }

  const decision =
    parsed.status === "invalid"
      ? { kind: "reply" as const, content: parsed.reply }
      : await dispatchCommand(parsed.command, {
          requestId: options.requestId,
          userKey,
        });

  if (decision.kind === "silent") return emptyWechatResponse();

  const reply = buildTextReply(
    message.fromUserName,
    message.toUserName,
    decision.content,
  );

  return new Response(reply, {
    status: 200,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
