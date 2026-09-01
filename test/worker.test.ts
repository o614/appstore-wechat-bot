import { beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { MessageStateStore } from "../src/state";
import { createWechatSignature } from "../src/wechat";

const stateValues = new Map<string, string>();
const stateStore: MessageStateStore = {
  get: async (key) => stateValues.get(key) ?? null,
  put: async (key, value) => {
    stateValues.set(key, value);
  },
};

const env: Env = {
  BOT_STATE: stateStore as KVNamespace,
  ENVIRONMENT: "local",
  WECHAT_TOKEN: "test-token",
};

async function invoke(request: Request, bindings: Env = env): Promise<Response> {
  type WorkerRequest = Parameters<typeof worker.fetch>[0];
  return worker.fetch(request as WorkerRequest, bindings);
}

async function signedUrl(path = "/wechat", echostr?: string): Promise<string> {
  const timestamp = "1788220800";
  const nonce = "phase-two";
  const signature = await createWechatSignature(
    env.WECHAT_TOKEN,
    timestamp,
    nonce,
  );
  const url = new URL(`https://example.test${path}`);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("signature", signature);
  if (echostr !== undefined) url.searchParams.set("echostr", echostr);
  return url.toString();
}

function textMessageXml(content: string, messageId: string): string {
  return [
    "<xml>",
    "<ToUserName><![CDATA[official-account]]></ToUserName>",
    "<FromUserName><![CDATA[user-openid]]></FromUserName>",
    "<CreateTime>1788220800</CreateTime>",
    "<MsgType><![CDATA[text]]></MsgType>",
    `<Content><![CDATA[${content}]]></Content>`,
    `<MsgId>${messageId}</MsgId>`,
    "</xml>",
  ].join("");
}

async function sendTextMessage(
  content: string,
  messageId: string,
  bindings: Env = env,
): Promise<Response> {
  return invoke(
    new Request(await signedUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: textMessageXml(content, messageId),
    }),
    bindings,
  );
}

beforeEach(() => {
  stateValues.clear();
  vi.unstubAllGlobals();
});

function mockAppleSearch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const query = new URL(String(input)).searchParams.get("term") ?? "";
    const app =
      query.toLocaleLowerCase("en-US") === "chatgpt"
        ? {
            trackId: 6448311069,
            trackName: "ChatGPT",
            trackViewUrl: "https://apps.apple.com/us/app/chatgpt/id6448311069",
            sellerName: "OpenAI OpCo, LLC",
            currency: "USD",
            formattedPrice: "Free",
            price: 0,
            averageUserRating: 4.8,
            userRatingCount: 1_000_000,
            fileSizeBytes: "254080000",
            currentVersionReleaseDate: "2026-08-30T00:00:00Z",
            minimumOsVersion: "17.0",
            version: "1.2026.238",
            primaryGenreName: "Productivity",
          }
        : {
            trackId: 6477489729,
            trackName: "Google Gemini",
            trackViewUrl:
              "https://apps.apple.com/us/app/google-gemini/id6477489729",
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
    return Response.json({ resultCount: 1, results: [app] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("App Store WeChat Bot foundation", () => {
  it("returns a healthy response with security headers", async () => {
    const response = await invoke(new Request("https://example.test/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "appstore-wechat-bot",
      version: "0.3.0",
      environment: "local",
    });
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("verifies a WeChat GET callback", async () => {
    const response = await invoke(
      new Request(await signedUrl("/wechat", "wechat-ok")),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("wechat-ok");
  });

  it("rejects an invalid WeChat signature", async () => {
    const response = await invoke(
      new Request(
        "https://example.test/wechat?timestamp=1&nonce=2&signature=invalid",
      ),
    );

    expect(response.status).toBe(403);
  });

  it("replies to the explicit communication test command", async () => {
    const response = await sendTextMessage("通信测试", "10001");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(body).toContain("<ToUserName><![CDATA[user-openid]]></ToUserName>");
    expect(body).toContain("通信测试成功");
  });

  it("keeps unrelated conversation silent", async () => {
    const response = await sendTextMessage("今天天气不错", "10002");

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
  });

  it("does not treat an incomplete IAP command as an app query", async () => {
    const response = await sendTextMessage("内购查询", "10003");
    const body = await response.text();

    expect(body).toContain("请在指令后输入应用名称");
    expect(body).toContain("内购 ChatGPT");
    expect(body).not.toContain("应用查询功能正在准备中");
  });

  it("returns the first official US result and renders both actions for app search", async () => {
    const fetchMock = mockAppleSearch();
    const response = await sendTextMessage("查询 Gemini", "search-gemini");
    const body = await response.text();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body).toContain("Google Gemini");
    expect(body).toContain("App ID：6477489729");
    expect(body).toContain("开发者：Google LLC");
    expect(body).toContain("内购 Google Gemini");
    expect(body).toContain("比价 Google Gemini");
    expect(body).not.toContain("Gemini Markets");
  });

  it("shows only the matching action for direct IAP or comparison entry", async () => {
    mockAppleSearch();
    const iap = await sendTextMessage("内购 Gemini", "direct-iap");
    const iapBody = await iap.text();

    expect(iapBody).toContain("内购 Google Gemini");
    expect(iapBody).not.toContain("比价 Google Gemini");

    stateValues.clear();
    const compare = await sendTextMessage("比价 Gemini", "direct-compare");
    const compareBody = await compare.text();

    expect(compareBody).toContain("比价 Google Gemini");
    expect(compareBody).not.toContain("内购 Google Gemini");
  });

  it("reuses one locked App ID for both action buttons without searching again", async () => {
    const fetchMock = mockAppleSearch();
    await sendTextMessage("查询 Gemini", "lock-search");

    const iap = await sendTextMessage(
      "内购 Google Gemini",
      "lock-iap",
    );
    const compare = await sendTextMessage(
      "比价 Google Gemini",
      "lock-compare",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(iap.text()).resolves.toContain("App ID：6477489729");
    await expect(compare.text()).resolves.toContain("App ID：6477489729");
    expect(stateValues.size).toBeGreaterThan(0);
  });

  it("ignores a duplicate WeChat delivery", async () => {
    const first = await sendTextMessage("通信测试", "duplicate-message");
    const second = await sendTextMessage("通信测试", "duplicate-message");

    await expect(first.text()).resolves.toContain("通信测试成功");
    await expect(second.text()).resolves.toBe("");
  });

  it("continues in fail-open mode when the short-term state store is unavailable", async () => {
    const unavailableState: MessageStateStore = {
      get: async () => {
        throw new Error("kv_unavailable");
      },
      put: async () => {
        throw new Error("kv_unavailable");
      },
    };
    const degradedEnv: Env = {
      ...env,
      BOT_STATE: unavailableState as KVNamespace,
    };

    const response = await sendTextMessage(
      "通信测试",
      "degraded-state",
      degradedEnv,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("通信测试成功");
  });

  it("rejects oversized signed payloads", async () => {
    const response = await invoke(
      new Request(await signedUrl(), {
        method: "POST",
        headers: { "Content-Length": "70000" },
        body: "<xml />",
      }),
    );

    expect(response.status).toBe(413);
  });

  it("stops reading an oversized payload without a Content-Length header", async () => {
    const response = await invoke(
      new Request(await signedUrl(), {
        method: "POST",
        body: "x".repeat(70_000),
      }),
    );

    expect(response.status).toBe(413);
  });

  it("does not expose unknown routes", async () => {
    const response = await invoke(new Request("https://example.test/private"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });
});
