import type { CommandKind, ParsedCommand } from "./commands";
import {
  AppleSearchError,
  searchFirstUsApp,
} from "./appleSearch";
import {
  renderAppSelection,
  selectionActions,
  type AppSelectionMode,
} from "./appReply";
import type { AppSelectionActions } from "./appTypes";
import {
  resolveAppSelectionAction,
  saveAppSelection,
  type MessageStateStore,
} from "./state";

const COMMAND_TIMEOUT_MS = 3_500;

export type ReplyDecision =
  | { kind: "reply"; content: string }
  | { kind: "silent" };

export interface CommandContext {
  requestId: string;
  userKey: string;
  state: MessageStateStore;
}

type CommandHandler = (
  command: ParsedCommand,
  context: CommandContext,
) => Promise<ReplyDecision>;

const HELP_REPLY = [
  "目前支持以下指令：",
  "",
  "查询 应用名称",
  "内购 应用名称",
  "比价 应用名称",
].join("\n");

function queryFromCommand(command: ParsedCommand): string {
  return "query" in command ? command.query : "";
}

function searchErrorReply(error: AppleSearchError): string {
  if (error.code === "timeout") {
    return "Apple 官方查询超时，请稍后重试。";
  }
  if (error.code === "invalid_response") {
    return "Apple 返回的数据暂时无法确认，请稍后重试。";
  }
  return "Apple 官方查询暂时不可用，请稍后重试。";
}

async function searchAndRenderApp(
  query: string,
  mode: AppSelectionMode,
  context: CommandContext,
): Promise<ReplyDecision> {
  let app;
  try {
    app = await searchFirstUsApp(query, context.state);
  } catch (error) {
    if (error instanceof AppleSearchError) {
      return { kind: "reply", content: searchErrorReply(error) };
    }
    throw error;
  }

  if (!app) {
    return { kind: "reply", content: "未找到相关 App，请检查输入。" };
  }

  let actionsAvailable = true;
  try {
    await saveAppSelection(context.state, context.userKey, {
      app,
      query,
      storefront: "us",
      actions: selectionActions(app.trackName),
      createdAt: Date.now(),
    });
  } catch (error) {
    actionsAvailable = false;
    console.error(
      JSON.stringify({
        event: "app_selection_store_failed",
        requestId: context.requestId,
        userKey: context.userKey,
        error: error instanceof Error ? error.message : "unknown_error",
      }),
    );
  }

  return {
    kind: "reply",
    content: renderAppSelection(app, query, mode, actionsAvailable),
  };
}

async function resolveLockedAction(
  query: string,
  action: keyof AppSelectionActions,
  context: CommandContext,
): Promise<Awaited<ReturnType<typeof resolveAppSelectionAction>>> {
  try {
    return await resolveAppSelectionAction(
      context.state,
      context.userKey,
      action,
      query,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "app_selection_load_failed",
        requestId: context.requestId,
        userKey: context.userKey,
        error: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    return null;
  }
}

async function handleAppSearch(
  command: ParsedCommand,
  context: CommandContext,
): Promise<ReplyDecision> {
  return searchAndRenderApp(queryFromCommand(command), "query", context);
}

async function handleInAppPurchaseEntry(
  command: ParsedCommand,
  context: CommandContext,
): Promise<ReplyDecision> {
  const query = queryFromCommand(command);
  const selection = await resolveLockedAction(
    query,
    "inAppPurchase",
    context,
  );
  if (selection) {
    return {
      kind: "reply",
      content: [
        selection.app.trackName,
        `App ID：${selection.app.trackId}`,
        "",
        "内购查询功能将在下一阶段接入。",
      ].join("\n"),
    };
  }
  return searchAndRenderApp(query, "in_app_purchase", context);
}

async function handlePriceCompareEntry(
  command: ParsedCommand,
  context: CommandContext,
): Promise<ReplyDecision> {
  const query = queryFromCommand(command);
  const selection = await resolveLockedAction(
    query,
    "priceCompare",
    context,
  );
  if (selection) {
    return {
      kind: "reply",
      content: [
        selection.app.trackName,
        `App ID：${selection.app.trackId}`,
        "",
        "订阅比价功能将在后续阶段接入。",
      ].join("\n"),
    };
  }
  return searchAndRenderApp(query, "price_compare", context);
}

const handlers: Record<CommandKind, CommandHandler> = {
  communication_test: async () => ({
    kind: "reply",
    content: "通信测试成功",
  }),
  help: async () => ({ kind: "reply", content: HELP_REPLY }),
  app_search: handleAppSearch,
  in_app_purchase: handleInAppPurchaseEntry,
  price_compare: handlePriceCompareEntry,
};

class CommandTimeoutError extends Error {
  override name = "CommandTimeoutError";
}

async function runWithTimeout(
  handler: CommandHandler,
  command: ParsedCommand,
  context: CommandContext,
): Promise<ReplyDecision> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new CommandTimeoutError("command_timeout")),
      COMMAND_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([handler(command, context), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function dispatchCommand(
  command: ParsedCommand,
  context: CommandContext,
): Promise<ReplyDecision> {
  const startedAt = performance.now();

  try {
    const result = await runWithTimeout(handlers[command.kind], command, context);
    console.log(
      JSON.stringify({
        event: "command_completed",
        requestId: context.requestId,
        userKey: context.userKey,
        command: command.kind,
        outcome: result.kind,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      }),
    );
    return result;
  } catch (error) {
    const timedOut = error instanceof CommandTimeoutError;
    console.error(
      JSON.stringify({
        event: timedOut ? "command_timed_out" : "command_failed",
        requestId: context.requestId,
        userKey: context.userKey,
        command: command.kind,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        error: error instanceof Error ? error.message : "unknown_error",
      }),
    );

    return {
      kind: "reply",
      content: timedOut
        ? "服务暂时繁忙，请稍后重试。"
        : "服务暂时不可用，请稍后重试。",
    };
  }
}
