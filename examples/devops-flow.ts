/**
 * DevOps Deployment Flow — Tegata MCP Binding Example
 *
 * Scenario: An autonomous `deploy-bot` agent is exposed to an LLM via an
 * MCP server. The server offers four tools — read-only status, a staging
 * deploy, a production deploy, and a log-cleanup operation. Tegata
 * intercepts every tool call and decides whether it is:
 *
 *   - auto-approved      (safe read, within budget)
 *   - escalated          (outside capability scope OR above risk threshold)
 *   - reviewed/approved  (matching policy requires human or peer sign-off)
 *
 * Expected decisions for each tool (given the agent + policy setup below):
 *
 *   ci-status          -> auto-approved    (riskScore 5, within budget)
 *   deploy-staging     -> auto-approved    (riskScore 30, capability match)
 *   deploy-production  -> escalated        (capability gap + riskScore 85)
 *   delete-logs        -> review tier      (capability + risk within budget,
 *                                           policy forces peer sign-off)
 *
 * The example only wires up the server; it does not connect a transport.
 * To actually run the server against an MCP client, uncomment the
 * `stdio` section at the bottom of `main()`.
 */

import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { Tegata } from "../src/index.js";
import type { Proposal, Result, ReviewResult } from "../src/index.js";
import { TegataServer } from "../src/bindings/mcp/index.js";

// ------------------------------------------------------------
// Demo reviewer
//
// Real deployments would route this to Slack, PagerDuty, an approval UI,
// or another agent. For the example we approve anything with an explicit
// `rollbackPlan` and deny the rest.
// ------------------------------------------------------------

/**
 * Demo reviewer that approves actions with a rollback plan and denies
 * everything else. Replace with a real integration in production.
 *
 * @param proposal - The proposal under review.
 * @returns A ReviewResult with an explicit decidedBy identifier.
 */
async function demoReviewer(proposal: Proposal): Promise<ReviewResult> {
  const hasRollback =
    typeof proposal.action.rollbackPlan === "string" &&
    proposal.action.rollbackPlan.length > 0;

  return hasRollback
    ? {
        status: "approved",
        decidedBy: "sre-lead",
        reason: "rollback plan documented",
      }
    : {
        status: "denied",
        decidedBy: "sre-lead",
        reason: "no rollback plan provided",
      };
}

// ------------------------------------------------------------
// Tool handlers (stubs)
// ------------------------------------------------------------

/**
 * Return the current CI status. Stub handler for the example.
 *
 * @returns A text CallToolResult describing the current CI state.
 */
function handleCiStatus(): CallToolResult {
  return {
    content: [{ type: "text", text: "CI green. Last build: passed." }],
  };
}

/**
 * Deploy the current build to the staging environment. Stub handler.
 *
 * @returns A text CallToolResult confirming the staging deploy.
 */
function handleDeployStaging(): CallToolResult {
  return {
    content: [{ type: "text", text: "Deployed v2.3.1 to staging." }],
  };
}

/**
 * Deploy the current build to production. Stub handler — only reached
 * if Tegata approves the proposal.
 *
 * @returns A text CallToolResult confirming the production deploy.
 */
function handleDeployProduction(): CallToolResult {
  return {
    content: [{ type: "text", text: "Deployed v2.3.1 to production." }],
  };
}

/**
 * Delete old CI logs. Stub handler — irreversible, so Tegata routes it
 * through a review policy before reaching this code.
 *
 * @returns A text CallToolResult confirming log deletion.
 */
function handleDeleteLogs(): CallToolResult {
  return {
    content: [{ type: "text", text: "Deleted logs older than 30 days." }],
  };
}

// ------------------------------------------------------------
// Setup
// ------------------------------------------------------------

type ServerBundle = {
  server: TegataServer;
};

/**
 * Build the Tegata runtime, register the demo agent + policies, and
 * wrap an McpServer with tool registrations. Returns a Result so the
 * caller (main) can report errors without module-load side effects.
 *
 * @returns The configured TegataServer, or an error Result.
 */
function setup(): Result<ServerBundle> {
  const tegata = new Tegata({
    defaultTier: "auto",
    escalateAbove: 70,
    timeoutMs: 30_000,
    defaultOnTimeout: "deny",
  });

  // `deploy-bot` can read everything in CI, operate freely on staging,
  // and delete logs. Production capability is intentionally withheld.
  // maxApprovableRisk 40 — anything above that escalates, even for
  // actions it is otherwise capable of.
  const registerResult = tegata.registerAgent({
    id: "deploy-bot",
    name: "Deploy Bot",
    role: "proposer",
    capabilities: ["ci:*:read", "ci:staging:*", "ci:logs:delete"],
    maxApprovableRisk: 40,
  });

  if (!registerResult.ok) {
    return { ok: false, error: `registerAgent: ${registerResult.error}` };
  }

  // Production deploys require peer review by senior engineers and the
  // security bot, and auto-escalate past riskScore 80.
  const prodPolicyResult = tegata.addPolicy({
    match: "ci:production:*",
    tier: "review",
    consensus: "majority",
    reviewers: ["senior-dev", "sre-lead", "security-bot"],
    escalateAbove: 80,
    handler: demoReviewer,
  });

  if (!prodPolicyResult.ok) {
    return { ok: false, error: `prod policy: ${prodPolicyResult.error}` };
  }

  // Log deletion is irreversible, so it routes through review even at
  // low riskScore — the policy intentionally overrides the default
  // auto tier for this actionType.
  const logsPolicyResult = tegata.addPolicy({
    match: "ci:logs:delete",
    tier: "review",
    consensus: "single",
    reviewers: ["sre-lead"],
    handler: demoReviewer,
  });

  if (!logsPolicyResult.ok) {
    return { ok: false, error: `logs policy: ${logsPolicyResult.error}` };
  }

  const mcp = new McpServer({
    name: "devops-mcp",
    version: "0.1.0",
  });

  const server = new TegataServer(mcp, tegata, { proposer: "deploy-bot" });

  // Each tool declares its Tegata actionType + risk metadata alongside
  // the normal MCP tool config. Handlers above are stubs — they stand in
  // for real CI/CD calls.

  server.tool(
    "ci-status",
    { description: "Read the current CI/CD pipeline status." },
    { actionType: "ci:prod:read", riskScore: 5 },
    handleCiStatus,
  );

  server.tool(
    "deploy-staging",
    { description: "Deploy the current build to the staging environment." },
    { actionType: "ci:staging:deploy", riskScore: 30, reversible: true },
    handleDeployStaging,
  );

  server.tool(
    "deploy-production",
    { description: "Deploy the current build to the production environment." },
    {
      actionType: "ci:production:deploy",
      riskScore: 85,
      reversible: true,
      rollbackPlan: "Revert to previous release via `ci rollback --last`.",
    },
    handleDeployProduction,
  );

  // riskScore 35 stays within deploy-bot's maxApprovableRisk (40), so
  // the runtime does NOT pre-escalate on agent enforcement. Control
  // reaches the policy layer, which forces the review tier.
  server.tool(
    "delete-logs",
    { description: "Delete CI logs older than 30 days." },
    {
      actionType: "ci:logs:delete",
      riskScore: 35,
      reversible: false,
    },
    handleDeleteLogs,
  );

  return { ok: true, value: { server } };
}

// ------------------------------------------------------------
// Main — summarize the configuration
// ------------------------------------------------------------

type ToolSummary = {
  name: string;
  actionType: string;
  expected: string;
};

const TOOL_SUMMARY: readonly ToolSummary[] = [
  {
    name: "ci-status",
    actionType: "ci:prod:read",
    expected: "auto-approved (read within budget)",
  },
  {
    name: "deploy-staging",
    actionType: "ci:staging:deploy",
    expected: "auto-approved (capability match, riskScore 30 <= 40)",
  },
  {
    name: "deploy-production",
    actionType: "ci:production:deploy",
    expected: "escalated (no capability + riskScore 85 > 40)",
  },
  {
    name: "delete-logs",
    actionType: "ci:logs:delete",
    expected: "review tier (policy forces peer sign-off)",
  },
];

/**
 * Print the server configuration so operators can eyeball the expected
 * approval flow before wiring up an actual transport.
 *
 * @returns Process exit code (0 on success, 1 on setup failure).
 */
async function main(): Promise<number> {
  const result = setup();
  if (!result.ok) {
    console.error(`setup failed: ${result.error}`);
    return 1;
  }

  // `server` is intentionally unused here — the point of this example
  // is the configuration, not the live transport. Uncomment the block
  // at the end of main() to wire it up to stdio.
  void result.value.server;

  console.log("Tegata DevOps Flow — configured");
  console.log("Proposer:        deploy-bot");
  console.log("Capabilities:    ci:*:read, ci:staging:*, ci:logs:delete");
  console.log("maxApprovableRisk: 40");
  console.log("");
  console.log("Policies:");
  console.log(
    "  ci:production:*  tier=review  consensus=majority  escalateAbove=80",
  );
  console.log("  ci:logs:delete   tier=review  consensus=single");
  console.log("");
  console.log("Tools:");
  for (const t of TOOL_SUMMARY) {
    const name = t.name.padEnd(18);
    const actionType = t.actionType.padEnd(22);
    console.log(`  ${name} ${actionType} -> ${t.expected}`);
  }
  console.log("");
  console.log("Connect via stdio to test live. Example (uncomment in source):");
  console.log("  const transport = new StdioServerTransport();");
  console.log("  await result.value.server.connect(transport);");

  // --- To run against a real MCP client, uncomment the following: ---
  // const { StdioServerTransport } = await import(
  //   "@modelcontextprotocol/sdk/server/stdio.js"
  // );
  // const transport = new StdioServerTransport();
  // await result.value.server.connect(transport);

  await Promise.resolve();
  return 0;
}

// Only run when executed directly (not when imported by tests/tools).
// `fileURLToPath` normalizes `import.meta.url` to a native filesystem
// path, which matches `process.argv[1]` on both POSIX and Windows.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && fileURLToPath(import.meta.url) === entryPoint) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
