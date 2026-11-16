// Stand-in for `agents/mcp`. The real McpAgent is a Durable Object base class
// that imports `cloudflare:workers`, which Node cannot load. EmailMCP only
// needs `this.env` and `this.server`, which the harness sets directly.
export class McpAgent {}
