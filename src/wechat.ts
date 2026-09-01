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

  const body = await request.text();
  return textEncoder.encode(body).byteLength <= MAX_WECHAT_BODY_BYTES ? body : null;
}

export async function handleWechat(
  request: Request,
  token: string,
): Promise<Response> {
  const url = new URL(request.url);
  const validSignature = await verifyWechatSignature(
    token,
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

  const toUserName = extractXmlValue(xml, "ToUserName");
  const fromUserName = extractXmlValue(xml, "FromUserName");
  const messageType = extractXmlValue(xml, "MsgType");
  const content = extractXmlValue(xml, "Content");

  if (!toUserName || !fromUserName || messageType !== "text" || content === null) {
    return emptyWechatResponse();
  }

  const reply = buildTextReply(
    fromUserName,
    toUserName,
    `Cloudflare 通信测试成功\n\n你发送了：${content.trim()}`,
  );

  return new Response(reply, {
    status: 200,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
