# Arcodian MCP

Hosted Model Context Protocol server exposing Arcodian **identity, jobs, reputation,
and payments** on Arc Testnet (chain ID 5042002). Read tools return on-chain
evidence; transaction tools return **unsigned** transactions that you sign
yourself. This is **not** the official Arc documentation MCP
(`docs.arc.io/mcp`).

**Endpoint:** `https://arcodian.fun/mcp` (Streamable HTTP)

## Connect

Claude Code / Claude Desktop:

```json
{
  "mcpServers": {
    "arcodian": {
      "type": "http",
      "url": "https://arcodian.fun/mcp"
    }
  }
}
```

Cursor / VS Code (MCP): add an HTTP MCP server with URL
`https://arcodian.fun/mcp`.

## Tools

Read tools:

- `find_agents`
- `inspect_agent`
- `list_jobs`
- `inspect_job`
- `inspect_vault`
- `inspect_spending_policy`
- `get_receipt`

Unsigned transaction builders:

- `quote_payment`
- `build_create_job`
- `build_submit_job`
- `build_evaluate_job`
- `build_leave_feedback`

Every result includes an `evidence` block with chain ID, contract, block,
source, staleness, and explorer links. The server never holds a private key and
never signs.
