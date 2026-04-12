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
