export type CommandKind =
  | "communication_test"
  | "help"
  | "app_search"
  | "in_app_purchase"
  | "price_compare";

export type ParsedCommand =
  | { kind: "communication_test" }
  | { kind: "help" }
  | {
      kind: "app_search" | "in_app_purchase" | "price_compare";
      query: string;
    };

export type CommandParseResult =
  | { status: "matched"; command: ParsedCommand }
  | { status: "invalid"; reply: string }
  | { status: "ignored" };

const MAX_QUERY_CHARACTERS = 120;

interface QueryCommandRule {
  kind: "app_search" | "in_app_purchase" | "price_compare";
  pattern: RegExp;
  example: string;
}

const QUERY_COMMAND_RULES: QueryCommandRule[] = [
  {
    kind: "in_app_purchase",
    pattern: /^(?:查询内购|内购查询|内购)\s*(.*)$/iu,
    example: "内购 ChatGPT",
  },
  {
    kind: "price_compare",
    pattern: /^(?:订阅比价|开始比价|比价)\s*(.*)$/iu,
    example: "比价 ChatGPT",
  },
  {
    kind: "app_search",
    pattern: /^(?:应用查询|查询)\s*(.*)$/iu,
    example: "查询 ChatGPT",
  },
];

export function normalizeUserText(value: string): string {
  return value.normalize("NFKC").replace(/[\t\r\n ]+/gu, " ").trim();
}

function parseQueryCommand(text: string): CommandParseResult | null {
  for (const rule of QUERY_COMMAND_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;

    const query = (match[1] ?? "").trim();
    if (!query) {
      return {
        status: "invalid",
        reply: `请在指令后输入应用名称。\n\n例如：${rule.example}`,
      };
    }

    if ([...query].length > MAX_QUERY_CHARACTERS) {
      return {
        status: "invalid",
        reply: "应用名称过长，请缩短后重试。",
      };
    }

    return {
      status: "matched",
      command: { kind: rule.kind, query },
    };
  }

  return null;
}

export function parseCommand(content: string): CommandParseResult {
  const text = normalizeUserText(content);
  if (!text) return { status: "ignored" };

  if (text === "通信测试") {
    return { status: "matched", command: { kind: "communication_test" } };
  }

  if (["帮助", "菜单", "功能"].includes(text)) {
    return { status: "matched", command: { kind: "help" } };
  }

  return parseQueryCommand(text) ?? { status: "ignored" };
}
