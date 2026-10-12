// Connect to the MCP server over stdio and list tools or call one.
// Usage (from the repo root): npx tsx apps/mcp/scripts/smoke.ts [tool] [json-args]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, args = "{}"] = process.argv.slice(2);
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", new URL("../src/index.ts", import.meta.url).pathname] }));
if (!tool) {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(t.name, JSON.stringify(t.inputSchema).slice(0, 400), "\n");
} else {
  const res = await client.callTool({ name: tool, arguments: JSON.parse(args) }, undefined, { timeout: 120_000 });
  console.log(JSON.stringify(res, null, 2));
}
await client.close();
