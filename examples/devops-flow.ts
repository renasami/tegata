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
 *   delete-logs        -> review tier      (policy forces peer review)
 *
 * The example only wires up the server; it does not connect a transport.
 * To actually run the server against an MCP client, uncomment the
 * `stdio` section at the bottom of `main()`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { Tegata } from "../src/index.js";
import type { Proposal, ReviewResult } from "../src/index.js";
import { TegataServer } from "../src/bindings/mcp/index.js";

// ------------------------------------------------------------
// 1. Tegata runtime configuration
// ------------------------------------------------------------

const tegata = new Tegata({
  defaultTier: "auto",
  escalateAbove: 70,
  timeoutMs: 30_000,
  defaultOnTimeout: "deny",
});

// ------------------------------------------------------------
// 2. Agent registration
//
// `deploy-bot` can read everything in CI and operate freely on the
// staging environment, but has NO capability for production.
// Its max approvable risk is 40 — anything above that escalates,
// even for actions it is otherwise capable of.
// ------------------------------------------------------------

const registerResult = tegata.registerAgent({
  id: "deploy-bot",
  name: "Deploy Bot",
  role: "proposer",
  capabilities: ["ci:*:read", "ci:staging:*"],
  maxApprovableRisk: 40,
});

if (!registerResult.ok) {
  console.error(`failed to register agent: ${registerResult.error}`);
  process.exit(1);
}

// ------------------------------------------------------------
// 3. Review handler (demo)
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

  return await Promise.resolve(
    hasRollback
      ? {
          status: "approved",
          decidedBy: "sre-lead",
          reason: "rollback plan documented",
        }
      : {
          status: "denied",
          decidedBy: "sre-lead",
          reason: "no rollback plan provided",
        },
  );
}

// ------------------------------------------------------------
// 4. Policy setup
//
// Production deploys require peer review by senior engineers and the
// security bot, and auto-escalate past riskScore 80. Log deletion is
// irreversible, so it routes through review unconditionally.
// ------------------------------------------------------------

const prodPolicyResult = tegata.addPolicy({
  match: "ci:production:*",
  tier: "review",
  consensus: "majority",
  reviewers: ["senior-dev", "sre-lead", "security-bot"],
  escalateAbove: 80,
  handler: demoReviewer,
});

if (!prodPolicyResult.ok) {
  console.error(`failed to add prod policy: ${prodPolicyResult.error}`);
  process.exit(1);
}

const logsPolicyResult = tegata.addPolicy({
  match: "ci:logs:delete",
  tier: "review",
  consensus: "single",
  reviewers: ["sre-lead"],
  handler: demoReviewer,
});

if (!logsPolicyResult.ok) {
  console.error(`failed to add logs policy: ${logsPolicyResult.error}`);
  process.exit(1);
}

// ------------------------------------------------------------
// 5. MCP server + Tegata wrapper
// ------------------------------------------------------------

const mcp = new McpServer({
  name: "devops-mcp",
  version: "0.1.0",
});

const server = new TegataServer(mcp, tegata, { proposer: "deploy-bot" });

// ------------------------------------------------------------
// 6. Tool registrations
//
// Each tool declares its Tegata actionType + risk metadata alongside
// the normal MCP tool config. Handlers below are stubs — they stand in
// for real CI/CD calls.
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

server.tool(
  "delete-logs",
  { description: "Delete CI logs older than 30 days." },
  {
    actionType: "ci:logs:delete",
    riskScore: 70,
    reversible: false,
  },
  handleDeleteLogs,
);

// ------------------------------------------------------------
// 7. Main — summarize the configuration
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
 * @returns A promise that resolves once the summary has been printed.
 */
async function main(): Promise<void> {
  console.log("Tegata DevOps Flow — configured");
  console.log("Proposer:        deploy-bot");
  console.log("Capabilities:    ci:*:read, ci:staging:*");
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
  console.log("  await server.connect(transport);");

  // --- To run against a real MCP client, uncomment the following: ---
  // const { StdioServerTransport } = await import(
  //   "@modelcontextprotocol/sdk/server/stdio.js"
  // );
  // const transport = new StdioServerTransport();
  // await server.connect(transport);

  await Promise.resolve();
}

// Only run when executed directly (not when imported by tests/tools).
if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
