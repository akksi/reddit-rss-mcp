# reddit-rss-mcp

Local, read-only MCP server that reads Reddit's public RSS feeds. A stopgap until official Reddit API access is approved (see akksi/reddit-mcp).

## Tools

- `list_new_posts(subreddit, limit)`: newest posts in a subreddit
- `search_subreddit(subreddit, query, time)`: search within a subreddit, newest first
- `get_post(url)`: a post and its comments

## Etiquette

- One request at a time, paced by Reddit's x-ratelimit-* headers (logged-out RSS is ~1 request per 60 s per IP), at least 8 s apart, 10-minute cache. Waits in-call up to 45 s including queue time (MCP clients time out at 60 s); beyond that it returns stale cache or fails with the time the next request is possible.
- Logged out, descriptive User-Agent, nothing stored beyond the process.
- Read-only. Never posts, votes or messages.

## Run

```
npm install
node test.mjs   # smoke test
```

Claude Desktop config entry:

```json
"reddit-rss": { "command": "node", "args": ["/path/to/reddit-rss-mcp/server.js"] }
```
