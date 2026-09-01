import { beforeEach, describe, expect, it } from "vitest";

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
});

describe("App Store WeChat Bot foundation", () => {
  it("returns a healthy response with security headers", async () => {
    const response = await invoke(new Request("https://example.test/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "appstore-wechat-bot",
      version: "0.2.0",
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

  it.each([
    ["查询 ChatGPT", "应用查询功能正在准备中"],
    ["内购 ChatGPT", "内购查询功能正在准备中"],
    ["比价 ChatGPT", "订阅比价功能正在准备中"],
  ])("routes %s to its isolated module", async (command, expected) => {
    const response = await sendTextMessage(command, `route-${command}`);

    await expect(response.text()).resolves.toContain(expected);
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
