import type { CommandKind, ParsedCommand } from "./commands";

const COMMAND_TIMEOUT_MS = 3_500;

export type ReplyDecision =
  | { kind: "reply"; content: string }
  | { kind: "silent" };

export interface CommandContext {
  requestId: string;
  userKey: string;
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

const handlers: Record<CommandKind, CommandHandler> = {
  communication_test: async () => ({
    kind: "reply",
    content: "通信测试成功",
  }),
  help: async () => ({ kind: "reply", content: HELP_REPLY }),
  app_search: async () => ({
    kind: "reply",
    content: "应用查询功能正在准备中。",
  }),
  in_app_purchase: async () => ({
    kind: "reply",
    content: "内购查询功能正在准备中。",
  }),
  price_compare: async () => ({
    kind: "reply",
    content: "订阅比价功能正在准备中。",
  }),
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
