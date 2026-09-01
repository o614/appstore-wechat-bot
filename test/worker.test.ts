import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { createWechatSignature } from "../src/wechat";

const env = {
  ENVIRONMENT: "local",
  WECHAT_TOKEN: "test-token",
} satisfies Env;

async function invoke(request: Request): Promise<Response> {
  type WorkerRequest = Parameters<typeof worker.fetch>[0];
  return worker.fetch(request as WorkerRequest, env);
}

async function signedUrl(path = "/wechat", echostr?: string): Promise<string> {
  const timestamp = "1788220800";
  const nonce = "phase-one";
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

describe("phase-one Worker", () => {
  it("returns a healthy response with security headers", async () => {
    const response = await invoke(new Request("https://example.test/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "appstore-wechat-bot",
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

  it("returns a text reply for a signed WeChat POST", async () => {
    const xml = [
      "<xml>",
      "<ToUserName><![CDATA[official-account]]></ToUserName>",
      "<FromUserName><![CDATA[user-openid]]></FromUserName>",
      "<MsgType><![CDATA[text]]></MsgType>",
      "<Content><![CDATA[测试通信]]></Content>",
      "</xml>",
    ].join("");
    const response = await invoke(
      new Request(await signedUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(body).toContain("<ToUserName><![CDATA[user-openid]]></ToUserName>");
    expect(body).toContain("Cloudflare 通信测试成功");
    expect(body).toContain("测试通信");
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

  it("does not expose unknown routes", async () => {
    const response = await invoke(new Request("https://example.test/private"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });
});
