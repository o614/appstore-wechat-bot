import type { AppSelectionActions, AppSummary } from "./appTypes";

export type AppSelectionMode = "query" | "in_app_purchase" | "price_compare";

const WECHAT_MENU_PREFIX = "weixin://bizmsgmenu?msgmenucontent=";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function actionLink(command: string, id: string): string {
  return `<a href="${WECHAT_MENU_PREFIX}${encodeURIComponent(command)}&msgmenuid=${id}">${escapeHtml(command)}</a>`;
}

function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const amount = bytes / 1024 ** unitIndex;
  return `${Number(amount.toFixed(2))} ${units[unitIndex]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}/${part("month")}/${part("day")}`;
}

function formatPrice(app: AppSummary): string {
  if (/^free$/iu.test(app.formattedPrice)) return "免费";
  if (app.formattedPrice) return app.formattedPrice;
  if (app.price < 0 || !app.currency) return "未知";
  if (app.price === 0) return "免费";
  return `${app.currency} ${app.price.toFixed(2)}`.trim();
}

export function selectionActions(appName: string): AppSelectionActions {
  return {
    inAppPurchase: `内购 ${appName}`,
    priceCompare: `比价 ${appName}`,
  };
}

function displayedActions(
  actions: AppSelectionActions,
  mode: AppSelectionMode,
): string[] {
  if (mode === "in_app_purchase") return [actions.inAppPurchase];
  if (mode === "price_compare") return [actions.priceCompare];
  return [actions.inAppPurchase, actions.priceCompare];
}

export function renderAppSelection(
  app: AppSummary,
  query: string,
  mode: AppSelectionMode,
  actionsAvailable: boolean,
): string {
  const actions = selectionActions(app.trackName);
  const rating =
    app.averageUserRating > 0 ? app.averageUserRating.toFixed(1) : "暂无";
  const minimumOs = app.minimumOsVersion
    ? `${app.minimumOsVersion}+`
    : "未知";

  const lines = [
    `您查询的“${escapeHtml(query)}”最匹配的结果是：`,
    "",
    `<a href="${escapeHtml(app.trackViewUrl)}">${escapeHtml(app.trackName)}</a>`,
    "",
    "地区：美国",
    `价格：${escapeHtml(formatPrice(app))}`,
    `分类：${escapeHtml(app.primaryGenreName || "未知")}`,
    `评分：${rating}`,
    `大小：${formatBytes(app.fileSizeBytes)}`,
    `更新：${formatDate(app.currentVersionReleaseDate)}`,
    `版本：v${escapeHtml(app.version || "未知")}`,
    `兼容：iOS ${escapeHtml(minimumOs)}`,
    `App ID：${app.trackId}`,
    `开发者：${escapeHtml(app.sellerName || "未知")}`,
  ];

  if (actionsAvailable) {
    lines.push("");
    for (const command of displayedActions(actions, mode)) {
      const actionId = command.startsWith("内购 ")
        ? "app_in_app_purchase"
        : "app_price_compare";
      lines.push(`› ${actionLink(command, actionId)}`);
    }
  } else {
    lines.push("", "操作状态暂时无法保存，请稍后重新查询。");
  }

  lines.push("", "*数据来源 Apple 官方");
  return lines.join("\n");
}
