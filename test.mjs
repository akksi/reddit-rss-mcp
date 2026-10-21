import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "t", version: "0" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ["server.js"] }));
console.log((await c.listTools()).tools.map(t => t.name).join(", "));
const r = await c.callTool({ name: "list_new_posts", arguments: { subreddit: "lovable", limit: 5 } });
const t = r.content[0].text; try { console.log(JSON.parse(t).map(p => p.updated + " | " + p.title).join("\n")); } catch { console.log(t); }
await c.close();
