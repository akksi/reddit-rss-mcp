// Local, read-only Reddit reader over Reddit's public RSS feeds.
// Stopgap until official API access is approved. Gentle by design:
// one request at a time, min gap between requests, 10-minute cache, backoff on 429.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

const UA = "macos:reddit-rss-reader:0.1 (by /u/akksi1)";
const MIN_GAP_MS = 8000;
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
  const job = queue.then(async () => {
    if (Date.now() < blockedUntil) {
      throw new Error(`Rate limited by Reddit; retry after ${new Date(blockedUntil).toLocaleTimeString()}`);
    }
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after")) || 300;
      blockedUntil = Date.now() + ra * 1000;
      throw new Error(`Reddit returned 429; backing off ${ra}s`);
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
