# App Store WeChat Bot

一个从零构建、仅服务微信公众号的 App Store 助手后端。应用查询、内购查询、订阅比价、榜单和后续公众号功能都将在本仓库中按模块实现。旧网站、旧 Vercel 项目和旧公众号机器人不在本仓库的运行链路中。

## 当前阶段

阶段一只验证基础通信：

- `GET /health`：健康检查
- `GET /wechat`：微信公众号服务器签名验证
- `POST /wechat`：签名验证后返回文字回声
- 请求方法限制、请求体上限、安全响应头和结构化日志

尚未接入 App 搜索、内购、比价、KV、D1、Queue 或定时任务。

## 本地运行

```bash
npm install
copy .dev.vars.example .dev.vars
npm run types
npm run check
npm run dev
```

不要提交 `.dev.vars`。生产环境的 `WECHAT_TOKEN` 必须通过 Cloudflare Secret 设置。

## 部署边界

- 预发布 Worker：`appstore-wechat-bot-staging`
- 生产 Worker：`appstore-wechat-bot`
- 第一阶段使用 `workers.dev` 地址验证，确认稳定后再绑定正式域名。
