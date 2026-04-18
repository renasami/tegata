// ============================================================
// Tegata MCP Binding — TegataServer
//
// Composition wrapper around McpServer that intercepts every
// tool call with Tegata's authorization flow. MCP Server
// developers add one line to get approval governance:
//
//   const server = new TegataServer(mcp, tegata, { proposer: "my-agent" });
//   server.tool("deploy", { description: "Deploy" }, { actionType: "ci:prod:deploy" }, handler);
//
// Denied/escalated/timed-out calls return `isError: true` so
// the LLM sees the denial and can adjust its behavior.
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  RegisteredTool,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ZodRawShapeCompat,
  AnySchema,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";

import type { Tegata } from "../../core/runtime.js";
import type { Action, Proposal } from "../../core/types.js";
import type { TegataServerConfig, TegataToolOptions } from "./types.js";

/** Config object accepted by `registerTool`. */
type ToolConfig<InputArgs extends undefined | ZodRawShapeCompat | AnySchema> = {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: ZodRawShapeCompat | AnySchema;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/**
 * Build a Tegata {@link Action} from tool registration options,
 * falling back to the MCP tool description when no explicit
 * description is provided.
 *
 * Uses conditional spread to avoid assigning `undefined` to
 * optional fields (`exactOptionalPropertyTypes`).
 *
 * @param opts - Tegata tool options.
 * @param mcpDescription - MCP tool description (fallback).
 * @returns An Action ready for proposal.
 */
function buildAction(
  opts: TegataToolOptions,
  mcpDescription: string | undefined,
): Action {
  const desc = opts.description ?? mcpDescription;
  return {
    type: opts.actionType,
    ...(desc !== undefined && { description: desc }),
    ...(opts.riskScore !== undefined && { riskScore: opts.riskScore }),
    ...(opts.reversible !== undefined && { reversible: opts.reversible }),
    ...(opts.rollbackPlan !== undefined && { rollbackPlan: opts.rollbackPlan }),
  };
}

/**
 * Build a denied/escalated/timed-out CallToolResult.
 *
 * Includes the proposalId so callers can correlate with
 * Tegata's audit log.
 *
 * @param reason - Human-readable denial reason.
 * @param proposalId - Tegata proposal ID for audit trail linkage.
 * @returns A CallToolResult with `isError: true`.
 */
function deniedResult(reason: string, proposalId: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Tegata denied: ${reason} (proposal: ${proposalId})`,
      },
    ],
    isError: true,
  };
}

/**
 * Composition wrapper around {@link McpServer} that intercepts
 * every tool call with Tegata's authorization flow.
 *
 * **Proposer validation**: The `proposer` field is not validated
 * in the constructor (`no-throw-statements` constraint). An empty
 * proposer will cause `Tegata.propose()` to return
 * `status: "denied"` with reason `"proposer must not be empty"`.
 */
export class TegataServer {
  private readonly mcp: McpServer;
  private readonly tegata: Tegata;
  private readonly config: TegataServerConfig;

  /**
   * @param mcp - The McpServer instance to wrap.
   * @param tegata - The Tegata runtime for authorization.
   * @param config - Server configuration (must include `proposer`).
   */
  constructor(mcp: McpServer, tegata: Tegata, config: TegataServerConfig) {
    this.mcp = mcp;
    this.tegata = tegata;
    this.config = config;
  }

  /**
   * Register a tool with Tegata authorization intercept.
   *
   * Wraps the original handler: before execution, a proposal is
   * submitted to Tegata. If approved, the handler runs normally.
   * Otherwise, an `isError: true` result is returned with the
   * denial reason and proposal ID.
   *
   * @param name - MCP tool name.
   * @param toolConfig - MCP tool configuration (description, inputSchema, etc.).
   * @param tegataOpts - Tegata authorization options (actionType, riskScore, etc.).
   * @param handler - The original tool handler.
   * @returns The RegisteredTool from the underlying McpServer.
   */
  tool<InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined>(
    name: string,
    toolConfig: ToolConfig<InputArgs>,
    tegataOpts: TegataToolOptions,
    handler: ToolCallback<InputArgs>,
  ): RegisteredTool {
    const action = buildAction(tegataOpts, toolConfig.description);
    const proposer = this.config.proposer;
    const tegata = this.tegata;

    const wrappedHandler = (
      ...handlerArgs: Parameters<ToolCallback<InputArgs>>
    ): Promise<CallToolResult> => {
      // Extract args: first param is args (if schema defined), last is extra
      const args =
        handlerArgs.length > 1
          ? (handlerArgs[0] as Record<string, unknown>)
          : undefined;

      const proposal: Proposal = {
        proposer,
        action,
        ...(args !== undefined && { params: args }),
      };

      return tegata.propose(proposal).then((decision) => {
        if (decision.status !== "approved") {
          return deniedResult(
            decision.reason ?? decision.status,
            decision.proposalId,
          );
        }

        // Handler approved — execute original.
        // Wrap in Promise.resolve().then() so sync throws and async
        // rejections are caught in a single chain (same pattern as
        // core executeHandler).
        return Promise.resolve()
          .then(
            () =>
              (handler as (...a: unknown[]) => unknown)(
                ...handlerArgs,
              ) as CallToolResult,
          )
          .catch(
            (err: unknown): CallToolResult => ({
              content: [
                {
                  type: "text",
                  text: `Tool handler error: ${err instanceof Error ? err.message : "unknown error"}`,
                },
              ],
              isError: true,
            }),
          );
      });
    };

    // Cast narrows generic InputArgs to satisfy registerTool's signature.
    // The inputSchema *value* is preserved and passed through — only the
    // TypeScript generic parameter is erased. MCP SDK validates at runtime
    // using the schema value, so this is safe.
    return this.mcp.registerTool(
      name,
      toolConfig as ToolConfig<undefined>,
      wrappedHandler as ToolCallback,
    );
  }

  /**
   * Connect the underlying McpServer to a transport.
   *
   * @param transport - The MCP transport to connect to.
   * @returns A promise that resolves when connected.
   */
  async connect(transport: Transport): Promise<void> {
    return this.mcp.connect(transport);
  }
}
