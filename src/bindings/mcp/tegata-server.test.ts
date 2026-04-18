import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { Tegata } from "../../core/runtime.js";
import { TegataServer } from "./tegata-server.js";

// ----------------------------------------------------------------
// Mock McpServer
// ----------------------------------------------------------------

type ToolHandler = (...args: unknown[]) => unknown;

const createMockMcpServer = () => {
  const tools = new Map<
    string,
    { config: Record<string, unknown>; handler: ToolHandler }
  >();
  const connectFn = vi
    .fn<(transport: Transport) => Promise<void>>()
    .mockResolvedValue(undefined);

  const mock = {
    registerTool(
      name: string,
      config: Record<string, unknown>,
      handler: ToolHandler,
    ) {
      tools.set(name, { config, handler });
      return { enabled: true } as Record<string, unknown>;
    },
    connect: connectFn,
    tools,
  } as unknown as McpServer;

  return { mock, tools, connectFn };
};

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/** Invoke a registered tool's wrapped handler with args. */
async function callTool(
  tools: Map<string, { handler: ToolHandler }>,
  name: string,
  args?: Record<string, unknown>,
): Promise<CallToolResult> {
  const entry = tools.get(name);
  if (entry === undefined) {
    return {
      content: [{ type: "text", text: "tool not found" }],
      isError: true,
    };
  }
  const extra = {} as Record<string, unknown>;
  if (args !== undefined) {
    return entry.handler(args, extra) as Promise<CallToolResult>;
  }
  return entry.handler(extra) as Promise<CallToolResult>;
}

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe("TegataServer", () => {
  it("approved → original handler executes and returns CallToolResult", async () => {
    const { mock, tools } = createMockMcpServer();
    const tegata = new Tegata(); // default: auto-approve
    const server = new TegataServer(mock, tegata, { proposer: "test-bot" });

    const handler = vi.fn<() => CallToolResult>().mockReturnValue({
      content: [{ type: "text", text: "deployed" }],
    });

    server.tool(
      "deploy",
      { description: "Deploy app" },
      { actionType: "ci:staging:deploy" },
      handler,
    );

    const result = await callTool(tools, "deploy");

    expect(handler).toHaveBeenCalledOnce();
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "deployed" });
  });

  it("denied (riskScore > threshold) → isError:true, handler not called", async () => {
    const { mock, tools } = createMockMcpServer();
    const tegata = new Tegata({ escalateAbove: 50 });
    const server = new TegataServer(mock, tegata, { proposer: "test-bot" });

    const handler = vi.fn<() => CallToolResult>().mockReturnValue({
      content: [{ type: "text", text: "should not run" }],
    });

    server.tool(
      "delete-all",
      { description: "Delete everything" },
      { actionType: "db:users:delete", riskScore: 80 },
      handler,
    );

    const result = await callTool(tools, "delete-all");

    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty("type", "text");
  });

  it("escalated (capability mismatch) → isError:true", async () => {
    const { mock, tools } = createMockMcpServer();
    const tegata = new Tegata();
    tegata.registerAgent({
      id: "limited-bot",
      name: "Limited Bot",
      role: "proposer",
      capabilities: ["ci:staging:*"],
      maxApprovableRisk: 80,
    });
    const server = new TegataServer(mock, tegata, { proposer: "limited-bot" });

    const handler = vi.fn<() => CallToolResult>().mockReturnValue({
      content: [{ type: "text", text: "should not run" }],
    });

    server.tool(
      "prod-deploy",
      { description: "Deploy to production" },
      { actionType: "ci:production:deploy" },
      handler,
    );

    const result = await callTool(tools, "prod-deploy");

    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Tegata denied");
  });

  it("timed_out → isError:true", async () => {
    const { mock, tools } = createMockMcpServer();
    const tegata = new Tegata({ timeoutMs: 50, defaultOnTimeout: "deny" });
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ status: "approved", decidedBy: "slow-reviewer" });
          }, 500);
        }),
    });
    const server = new TegataServer(mock, tegata, { proposer: "test-bot" });

    const handler = vi.fn<() => CallToolResult>().mockReturnValue({
      content: [{ type: "text", text: "should not run" }],
    });

    server.tool(
      "write-users",
      { description: "Write users" },
      { actionType: "db:users:write" },
      handler,
    );

    const result = await callTool(tools, "write-users");

    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Tegata denied");
  });

  it("params mapping → tool args appear in proposal.params", async () => {
    const { mock, tools } = createMockMcpServer();
    const tegata = new Tegata();
    const server = new TegataServer(mock, tegata, { proposer: "test-bot" });

    server.tool(
      "delete-user",
      { description: "Delete a user" },
      { actionType: "db:users:delete" },
      () => ({ content: [{ type: "text" as const, text: "done" }] }),
    );

    await callTool(tools, "delete-user", { userId: "42" });

    const log = tegata.getAuditLog();
    const proposed = log.find((e) => e.eventType === "proposed");
    expect(proposed?.proposal.params).toEqual({ userId: "42" });
  });

  it("description fallback → uses MCP description when tegata description omitted", async () => {
    const { mock, tools } = createMockMcpServer();
    const tegata = new Tegata();
    const server = new TegataServer(mock, tegata, { proposer: "test-bot" });

    server.tool(
      "read-data",
      { description: "Read data from store" },
      { actionType: "store:data:read" },
      () => ({ content: [{ type: "text" as const, text: "data" }] }),
    );

    await callTool(tools, "read-data");

    const log = tegata.getAuditLog();
    const proposed = log.find((e) => e.eventType === "proposed");
    expect(proposed?.proposal.action.description).toBe("Read data from store");
  });

  it("description override → tegata description takes priority", async () => {
    const { mock, tools } = createMockMcpServer();
    const tegata = new Tegata();
    const server = new TegataServer(mock, tegata, { proposer: "test-bot" });

    server.tool(
      "read-data",
      { description: "MCP description" },
      { actionType: "store:data:read", description: "Tegata description" },
      () => ({ content: [{ type: "text" as const, text: "data" }] }),
    );

    await callTool(tools, "read-data");

    const log = tegata.getAuditLog();
    const proposed = log.find((e) => e.eventType === "proposed");
    expect(proposed?.proposal.action.description).toBe("Tegata description");
  });

  it("handler error (try/catch) → isError:true, does not crash", async () => {
    const { mock, tools } = createMockMcpServer();
    const tegata = new Tegata();
    const server = new TegataServer(mock, tegata, { proposer: "test-bot" });

    server.tool(
      "broken-tool",
      { description: "Broken" },
      { actionType: "test:tool:broken" },
      () => {
        throw new Error("handler exploded");
      },
    );

    const result = await callTool(tools, "broken-tool");

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("handler exploded");
  });

  it("connect() → delegates to inner McpServer", async () => {
    const { mock, connectFn } = createMockMcpServer();
    const tegata = new Tegata();
    const server = new TegataServer(mock, tegata, { proposer: "test-bot" });

    const transport = {} as Transport;
    await server.connect(transport);

    expect(connectFn).toHaveBeenCalledWith(transport);
  });

  it("multiple tools → each operates independently", async () => {
    const { mock, tools } = createMockMcpServer();
    const tegata = new Tegata({ escalateAbove: 50 });
    const server = new TegataServer(mock, tegata, { proposer: "test-bot" });

    const readHandler = vi.fn<() => CallToolResult>().mockReturnValue({
      content: [{ type: "text", text: "read ok" }],
    });
    const writeHandler = vi.fn<() => CallToolResult>().mockReturnValue({
      content: [{ type: "text", text: "write ok" }],
    });

    server.tool(
      "read",
      { description: "Read" },
      { actionType: "db:data:read" },
      readHandler,
    );
    server.tool(
      "write",
      { description: "Write" },
      { actionType: "db:data:write", riskScore: 80 },
      writeHandler,
    );

    const readResult = await callTool(tools, "read");
    const writeResult = await callTool(tools, "write");

    expect(readHandler).toHaveBeenCalledOnce();
    expect(writeHandler).not.toHaveBeenCalled();
    expect(readResult.isError).not.toBe(true);
    expect(writeResult.isError).toBe(true);
  });

  it("denied response contains proposalId for audit correlation", async () => {
    const { mock, tools } = createMockMcpServer();
    const tegata = new Tegata({ escalateAbove: 50 });
    const server = new TegataServer(mock, tegata, { proposer: "test-bot" });

    server.tool(
      "risky",
      { description: "Risky op" },
      { actionType: "db:data:delete", riskScore: 80 },
      () => ({ content: [{ type: "text" as const, text: "should not run" }] }),
    );

    const result = await callTool(tools, "risky");

    const text = (result.content[0] as { text: string }).text;
    // proposalId is a UUID — check the format
    expect(text).toMatch(/proposal: [0-9a-f-]{36}/);

    // Verify the proposalId in the response matches the audit log
    const uuidMatch = /proposal: ([0-9a-f-]{36})/.exec(text);
    expect(uuidMatch).not.toBeNull();
    const proposalId = (uuidMatch as RegExpExecArray)[1] as string;
    const auditLog = tegata.getAuditLog({ proposalId });
    expect(auditLog.length).toBeGreaterThan(0);
  });
});
