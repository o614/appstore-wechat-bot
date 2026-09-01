# App Store WeChat Bot

一个从零构建、仅服务微信公众号的 Cloudflare Worker 后端。应用查询、内购查询、订阅比价、榜单和后续公众号功能将在本仓库中按模块实现。旧网站、旧 Vercel 项目和旧公众号机器人不在本仓库的运行链路中。

## 当前阶段

生产 Worker 已完成消息处理底座：

- 微信签名验证和有界 XML 请求读取
- 仅处理明确指令，普通聊天保持沉默
- 应用查询、内购、比价使用独立处理模块
- 单个模块超时或异常时返回降级结果，不拖垮整个入口
- 使用 Cloudflare KV 保存五分钟的哈希消息指纹，避免微信重试造成重复处理
- KV 暂时不可用时自动跳过去重，继续处理正常回复
- 结构化日志不记录原始 OpenID 和用户消息内容
- 请求方法限制、安全响应头和健康检查

Apple 数据查询尚未接入。

## 当前测试指令

- `通信测试`
- `帮助`
- `查询 ChatGPT`
- `内购 ChatGPT`
- `比价 ChatGPT`

后三项当前只验证是否进入正确模块，不会请求 Apple。

## 本地运行

```bash
npm install
copy .dev.vars.example .dev.vars
npm run types
npm run check
npm run dev
```

不要提交 `.dev.vars`。生产环境的 `WECHAT_TOKEN` 必须通过 Cloudflare Secret 设置。

## 部署

- 预发布 Worker：`appstore-wechat-bot-staging`
- 生产 Worker：`appstore-wechat-bot`
- 生产回调：`https://wxbot.290935.xyz/wechat`
- 健康检查：`https://wxbot.290935.xyz/health`
