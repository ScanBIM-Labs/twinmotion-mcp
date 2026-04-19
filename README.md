# Twinmotion MCP

**Twinmotion rendering pipeline via APS** — Import Revit models, set environments, render images, export walkthrough videos.

[![Live](https://img.shields.io/badge/status-live-brightgreen)](https://twinmotion-mcp.itmartin24.workers.dev/)
[![MCP](https://img.shields.io/badge/protocol-MCP%202024--11--05-blue)](https://modelcontextprotocol.io)

## Tools (5)

| Tool | Description |
|------|-------------|
| `tm_import_rvt` | Import Revit model into Twinmotion |
| `tm_set_environment` | Set weather, time-of-day, environment |
| `tm_render_image` | Render still image (up to 8K) |
| `tm_export_video` | Export walkthrough video (MP4/MOV/WebM) |
| `tm_list_scenes` | List saved scenes and animations |

## Quick Start

```json
{
  "mcpServers": {
    "twinmotion": {
      "url": "https://twinmotion-mcp.itmartin24.workers.dev/mcp"
    }
  }
}
```

## Architecture

- **Runtime**: Cloudflare Workers
- **Auth**: APS OAuth2 (client_credentials)
- **Cache**: Cloudflare KV (token caching)

## Part of [ScanBIM Labs AEC MCP Ecosystem](https://github.com/ScanBIM-Labs)

MIT — ScanBIM Labs LLC

## Authentication

Two accepted header formats. **Use one, do NOT mix:**

1. `x-scanbim-api-key: <your_user_key>` — value is the user_key verbatim.
2. `Authorization: Bearer sk_scanbim_<your_user_key>` — value is the entire string including the `sk_scanbim_` prefix; the D1 `user_key` column must match this full string.

Mixing formats auto-creates a fresh free-plan row for the alternate key (you'll silently get a new 50-credit account on each switch).

Get your user_key at [scanbim.app/settings/billing](https://scanbim.app/settings/billing).

### Example

```bash
curl -X POST https://mcp.scanbimlabs.io/unified/mcp \
  -H "content-type: application/json" \
  -H "x-scanbim-api-key: $SCANBIM_USER_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_models","arguments":{}}}'
```

### Response codes

- `200` — tool call proceeded; credits debited.
- `401` — missing or malformed auth header (middleware returns JSON-RPC error code `-32001`).
- `402` — insufficient credits; response body includes `checkout_urls` for all 5 credit packs and `top_up_url` for the billing page.
