# App Store WeChat Bot

一个从零构建、仅服务微信公众号的 Cloudflare Worker 后端。应用查询、内购查询、订阅比价、榜单和后续公众号功能将在本仓库中按模块实现。旧网站、旧 Vercel 项目和旧公众号机器人不在本仓库的运行链路中。

## 当前阶段

生产 Worker 已完成消息处理底座和应用查询入口：

- 微信签名验证和有界 XML 请求读取
- 仅处理明确指令，普通聊天保持沉默
- 应用查询、内购、比价使用独立处理模块
- 单个模块超时或异常时返回降级结果，不拖垮整个入口
- 使用 Cloudflare KV 保存五分钟的哈希消息指纹，避免微信重试造成重复处理
- KV 暂时不可用时自动跳过去重，继续处理正常回复
- 结构化日志不记录原始 OpenID 和用户消息内容
- 请求方法限制、安全响应头和健康检查
- 固定查询 Apple 美国区官方 Search API，并采用官方第一条结果
- 应用搜索结果缓存六小时，确认未找到的结果缓存五分钟
- 用户选中的 App ID 锁定十分钟，新查询覆盖旧选择
- 应用详情包含地区、价格、分类、评分、大小、更新时间、版本、兼容性、App ID 和开发者

内购数据和订阅比价尚未接入。

## 当前测试指令

- `通信测试`
- `帮助`
- `查询 ChatGPT`
- `内购 ChatGPT`
- `比价 ChatGPT`

`查询`已接入 Apple 官方数据；`内购`和`比价`会先确认并锁定应用，点击操作后暂时返回下一阶段提示。

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
