// Local, read-only Reddit reader over Reddit's public RSS feeds.
// Stopgap until official API access is approved. Gentle by design:
// one request at a time, paced by Reddit's x-ratelimit-* headers, 10-minute cache,
// stale cache served on 429. Logged-out RSS is currently ~1 request per 60 s per IP.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

const UA = "macos:reddit-rss-reader:0.1 (by /u/akksi1)";
const MIN_GAP_MS = 8000;        // floor between requests even when headers allow more
const MAX_WAIT_MS = 45 * 1000;  // per-call wait budget incl. queue time; MCP clients time out at 60 s
const FALLBACK_BLOCK_S = 60;    // 429 without usable headers
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();
let last = 0;
let blockedUntil = 0;
let queue = Promise.resolve();

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (html = "") =>
  String(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();

function fetchFeed(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.data);
  const calledAt = Date.now();
  const budgetLeft = () => MAX_WAIT_MS - (Date.now() - calledAt);
  const job = queue.then(async () => {
    const readyAt = Math.max(blockedUntil, last + MIN_GAP_MS);
    const wait = readyAt - Date.now();
    if (wait > budgetLeft()) {
      if (hit) return hit.data;
      throw new Error(`Reddit rate window busy; next request possible at ${new Date(readyAt).toLocaleTimeString()}`);
    }
    if (wait > 0) await sleep(wait);
    let res;
    for (let attempt = 0; ; attempt++) {
      last = Date.now();
      res = await fetch(url, { headers: { "User-Agent": UA } });
      const remaining = Number(res.headers.get("x-ratelimit-remaining"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      if (Number.isFinite(remaining) && remaining < 1 && Number.isFinite(reset)) {
        blockedUntil = Date.now() + (reset + 1) * 1000;
      }
      if (res.status !== 429) break;
      const ra = Number(res.headers.get("retry-after")) || (Number.isFinite(reset) ? reset + 1 : FALLBACK_BLOCK_S);
      blockedUntil = Math.max(blockedUntil, Date.now() + ra * 1000);
      if (attempt === 0 && blockedUntil - Date.now() <= budgetLeft()) { await sleep(blockedUntil - Date.now()); continue; }
      if (hit) return hit.data;
      throw new Error(`Reddit returned 429; next request possible at ${new Date(blockedUntil).toLocaleTimeString()}`);
    }
    if (!res.ok) throw new Error(`Reddit returned ${res.status}`);
    const xml = await res.text();
    const feed = parser.parse(xml).feed || {};
    const entries = [].concat(feed.entry || []);
    const data = entries.map((e) => ({
      title: strip(e.title),
      url: e.link?.href,
      author: e.author?.name,
      subreddit: e.category?.label || e.category?.term,
      updated: e.updated || e.published,
      text: strip(e.content?.["#text"] ?? e.content).slice(0, 1500),
    }));
    cache.set(url, { at: Date.now(), data });
    return data;
  });
  queue = job.catch(() => {});
  return job;
}

const sub = z.string().regex(/^[A-Za-z0-9_]{2,21}$/).describe("Subreddit name without r/");
const out = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

const server = new McpServer({ name: "reddit-rss", version: "0.1.0" });

server.tool("list_new_posts", "Newest posts in a subreddit (public RSS).",
  { subreddit: sub, limit: z.number().int().min(1).max(25).default(15) },
  async ({ subreddit, limit }) =>
    out(await fetchFeed(`https://www.reddit.com/r/${subreddit}/new/.rss?limit=${limit}`)));

server.tool("search_subreddit", "Search posts within a subreddit, newest first (public RSS).",
  { subreddit: sub, query: z.string().min(1).max(200),
    time: z.enum(["day", "week", "month", "year", "all"]).default("week") },
  async ({ subreddit, query, time }) =>
    out(await fetchFeed(`https://www.reddit.com/r/${subreddit}/search.rss?q=${encodeURIComponent(query)}&restrict_sr=on&sort=new&t=${time}`)));

server.tool("get_post", "A post and its top-level comments, by the post URL (public RSS).",
  { url: z.string().url().refine((u) => /^https:\/\/(www|old)\.reddit\.com\/r\/\w+\/comments\//.test(u), "Must be a reddit.com post URL") },
  async ({ url }) => {
    const u = new URL(url); u.hostname = "www.reddit.com";
    const path = u.pathname.replace(/\/$/, "");
    return out(await fetchFeed(`https://www.reddit.com${path}/.rss`));
  });

await server.connect(new StdioServerTransport());
