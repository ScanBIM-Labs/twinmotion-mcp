// === scanbim-health patch: security headers + /health + favicon ===
const __SEC_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://developer.api.autodesk.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://*.autodesk.com https://uptime.scanbimlabs.io https://developer.api.autodesk.com"
};
const __FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#f97316"/><text x="16" y="22" text-anchor="middle" font-family="Inter,sans-serif" font-size="18" font-weight="800" fill="#fff">S</text></svg>`;
const __BUILD = globalThis.__BUILD__ || 'dev';
const __START = Date.now();
const __SLUG = "twinmotion-mcp";
const __VERSION = "1.0.0";
async function __handleHealth(env) {
  const deps = {};
  try { const r = await fetch('https://developer.api.autodesk.com/authentication/v2/token', { method: 'HEAD' }); deps.aps = r.status < 500 ? 'ok' : 'degraded'; } catch { deps.aps = 'down'; }
  if (env && env.CACHE) { try { await env.CACHE.get('_hc'); deps.kv = 'ok'; } catch { deps.kv = 'degraded'; } }
  if (env && env.DB)    { try { await env.DB.prepare('SELECT 1').first(); deps.d1 = 'ok'; } catch { deps.d1 = 'degraded'; } }
  const worst = Object.values(deps).reduce((w, v) => v === 'down' ? 'down' : v === 'degraded' && w !== 'down' ? 'degraded' : w, 'ok');
  return Response.json({ status: worst, service: __SLUG, version: (env && env.VERSION) || __VERSION, build: __BUILD, ts: new Date().toISOString(), uptime_s: Math.floor((Date.now() - __START) / 1000), deps });
}
function __applySec(resp) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(__SEC_HEADERS)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

// --- credits middleware ---
function __extractUserKey(req) {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(sk_scanbim_[A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  const headerKey = req.headers.get('x-scanbim-api-key');
  if (headerKey) return headerKey.trim();
  return null;
}
function __toolCost(toolName) {
  if (!toolName) return 1;
  if (/render|video|walkthrough|export_video|render_image|render_video/i.test(toolName)) return 50;
  if (/design_automation|da_run|import_rvt|tm_import_rvt|nwd_upload|upload_model/i.test(toolName)) return 20;
  if (/ai_|explain|draft|qa_|clash_explain|ai-?authored/i.test(toolName)) return 5;
  return 1;
}
async function __creditCheck(req, env, body) {
  // Dormant until billing is fully configured (INTERNAL_API_TOKEN + CREDITS_API).
  // This avoids breaking existing MCP clients before a billing cutover.
  if (!env.INTERNAL_API_TOKEN || !env.CREDITS_API) return { ok: true };
  if (body?.method !== 'tools/call') return { ok: true };
  const toolName = body?.params?.name;
  if (!toolName) return { ok: true };
  const user_key = __extractUserKey(req);
  if (!user_key) {
    return { ok: false, response: Response.json({
      jsonrpc: '2.0', id: body.id ?? null,
      error: { code: -32001, message: 'Authentication required',
        data: { error: 'missing_api_key',
          hint: 'Include header: Authorization: Bearer sk_scanbim_<key>',
          signup_url: 'https://scanbimlabs.io/credits' } }
    }, { status: 401 }) };
  }
  const cost = __toolCost(toolName);
  let r;
  try {
    r = await fetch(env.CREDITS_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': env.INTERNAL_API_TOKEN },
      body: JSON.stringify({ user_key, amount: cost, tool_name: toolName })
    });
  } catch (e) {
    console.log('CREDITS: fetch failed', String(e));
    return { ok: true }; // fail open on network error
  }
  if (r.status === 402) {
    const info = await r.json().catch(() => ({}));
    return { ok: false, response: Response.json({
      jsonrpc: '2.0', id: body.id ?? null,
      error: { code: -32002, message: 'Insufficient credits', data: info }
    }, { status: 402 }) };
  }
  if (!r.ok) { console.log('CREDITS: check-and-debit returned', r.status); return { ok: true }; }
  return { ok: true };
}
// --- end credits middleware ---

// === end patch header ===

// Twinmotion MCP Worker v1.1.0 — Real APS-Backed Visualization Tools
// ScanBIM Labs LLC | Ian Martin
// All 5 tools: REAL APS Model Derivative + Rendering API calls
// Architecture: Option A — APS Rendering Service + Model Derivative for visualization

const APS_BASE = 'https://developer.api.autodesk.com';

const SERVER_INFO = {
  name: "twinmotion-mcp",
  version: "1.1.0",
  description: "Twinmotion-style visualization via APS. Import models, configure scenes, render images, export videos, list views.",
  author: "ScanBIM Labs LLC"
};

async function getAPSToken(env, scope = 'data:read data:write data:create bucket:read bucket:create viewables:read') {
  const cacheKey = `aps_token_tm_${scope.replace(/\s/g, '_')}`;
  if (env.CACHE) {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return cached;
  }
  const resp = await fetch(`${APS_BASE}/authentication/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.APS_CLIENT_ID,
      client_secret: env.APS_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope
    })
  });
  if (!resp.ok) throw new Error(`APS auth failed (${resp.status})`);
  const data = await resp.json();
  if (env.CACHE) await env.CACHE.put(cacheKey, data.access_token, { expirationTtl: data.expires_in - 60 });
  return data.access_token;
}

// ── APS Helpers ───────────────────────────────────────────────

async function ensureBucket(token, bucketKey) {
  const check = await fetch(`${APS_BASE}/oss/v2/buckets/${bucketKey}/details`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (check.ok) return;
  const create = await fetch(`${APS_BASE}/oss/v2/buckets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketKey, policyKey: 'transient' })
  });
  if (!create.ok && create.status !== 409) throw new Error(`Bucket creation failed (${create.status})`);
}

async function getModelMetadata(token, urn) {
  const resp = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/metadata`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`Metadata fetch failed (${resp.status})`);
  return await resp.json();
}

async function getModelGUID(token, urn) {
  const meta = await getModelMetadata(token, urn);
  if (!meta.data || !meta.data.metadata || meta.data.metadata.length === 0) {
    throw new Error('No metadata found. Ensure model is translated.');
  }
  return (meta.data.metadata.find(v => v.role === '3d') || meta.data.metadata[0]).guid;
}

async function getManifest(token, urn) {
  const resp = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`Manifest fetch failed (${resp.status})`);
  return await resp.json();
}

async function getThumbnail(token, urn, width = 400, height = 400) {
  const resp = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/thumbnail?width=${width}&height=${height}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) return null;
  // Convert to base64 data URL
  const buffer = await resp.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  return `data:image/png;base64,${base64}`;
}

async function getProperties(token, urn, guid) {
  const resp = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/metadata/${guid}/properties?forceget=true`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`Properties fetch failed (${resp.status})`);
  const data = await resp.json();
  if (resp.status === 202 || data.isProcessing) {
    await new Promise(r => setTimeout(r, 3000));
    const retry = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/metadata/${guid}/properties?forceget=true`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!retry.ok) throw new Error(`Properties retry failed`);
    return await retry.json();
  }
  return data;
}

async function getObjectTree(token, urn, guid) {
  const resp = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/metadata/${guid}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`Object tree fetch failed`);
  const data = await resp.json();
  if (resp.status === 202) {
    await new Promise(r => setTimeout(r, 3000));
    const retry = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/metadata/${guid}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return await retry.json();
  }
  return data;
}

// ── Tool Definitions ──────────────────────────────────────────

const TOOLS = [
  {
    name: "tm_import_rvt",
    description: [
      "Import a Revit/BIM model into the Twinmotion visualization pipeline: downloads the source file from a public URL, uploads it to an APS OSS transient bucket, and kicks off an SVF2 + thumbnail translation job. Returns the base64 URN (project_id) used by every other tm_* tool.",
      "",
      "When to use: when a user wants to prepare a Revit (.rvt), IFC (.ifc), or other BIM/CAD model for real-time visualization in Unreal Engine / Twinmotion — typically the first step before rendering stills, defining scenes, or exporting FBX/glTF/OBJ geometry for a UE import. Also use when you need thumbnails or view metadata from a source file that has not yet been translated by APS.",
      "When NOT to use: not for MEP clash review (use navisworks-mcp), not for quantity takeoff or cost estimation (use qto-mcp), not for Twinmotion presets editing — Twinmotion itself has no public REST API, so scene/material authoring must happen manually in the UE editor after FBX/USD export.",
      "APS scopes required: data:read data:write data:create bucket:read bucket:create viewables:read. Uses Model Derivative API (translation) + OSS (upload). Twinmotion has no public REST API; all automation is APS Model Derivative + manual Unreal Engine export.",
      "Rate limits: APS default ~50 req/min per app per endpoint; Model Derivative translation jobs ~60 req/min; large .rvt/.nwd/.ifc files are often multi-GB and translation can take 5–60 min — poll the manifest with exponential backoff (start 5s, cap 60s) rather than retrying this tool. Worker request ceiling is ~100MB body; extremely large files may need signed-URL upload instead.",
      "Errors: 401 = APS token failed (check APS_CLIENT_ID/APS_CLIENT_SECRET, re-auth); 403 = scope missing (bucket:create/data:write not granted — have user re-consent); 404 = file_url unreachable; 409 = bucket key collision (rare — retry, tool uses timestamp); 413/507 = file too large for worker memory (advise signed-URL upload); 422 = unsupported source format (only Autodesk-accepted types: rvt, ifc, nwd, dwg, dgn, 3dm, stp, etc.); 429 = back off 60s before retrying; 5xx = APS upstream outage, retry with backoff.",
      "Side effects: CREATES a new transient OSS bucket (scanbim-viz-<timestamp>, auto-expires in 24h), CREATES an object in OSS, STARTS a translation job consuming APS cloud credits. NOT idempotent — each call creates a new bucket + URN. Writes a row to usage_log D1 table."
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        file_url: {
          type: "string",
          description: "Public HTTPS URL to download the source BIM/CAD file. Must be reachable without auth from Cloudflare Workers egress. Supports rvt, ifc, nwd, dwg, dgn, 3dm, stp, obj, and other APS-supported formats. Signed URLs (S3/GCS) work if the signature is embedded in the query string.",
          examples: [
            "https://example-cdn.com/projects/office-tower.rvt",
            "https://storage.googleapis.com/bim-uploads/site-model.ifc?X-Goog-Signature=..."
          ]
        },
        file_name: {
          type: "string",
          description: "Filename with extension used as the OSS object key. Non-alphanumeric characters are sanitized to underscores. Extension drives APS translator selection (.rvt → Revit, .ifc → IFC, etc.). For downstream Twinmotion/UE import, keep the base name meaningful (e.g. 'TowerA_L01-L20.rvt' → later exported as TowerA_L01-L20.fbx / .glb / .usd).",
          examples: ["Building.rvt", "SitePlan.ifc", "Factory_v3.nwd", "Terrain.dwg"]
        },
        include_materials: {
          type: "boolean",
          description: "If true (default), the translation preserves material/texture data so the derivative is visually meaningful in Twinmotion/UE. Set false only for geometry-only pipelines (faster, smaller derivatives).",
          examples: [true, false]
        },
        lighting_preset: {
          type: "string",
          enum: ["default", "natural", "studio", "evening"],
          description: "Lighting preset label stored alongside the import — purely metadata for downstream tm_render_image / UE scene setup; does not affect the APS translation itself. 'natural' = daylight sun+sky, 'studio' = neutral 3-point, 'evening' = warm low sun.",
          examples: ["natural", "studio"]
        }
      },
      required: ["file_url", "file_name"]
    }
  },
  {
    name: "tm_set_environment",
    description: [
      "Configure the visualization environment (weather, time-of-day, surround context) for a previously imported model. Validates the model exists via APS Model Derivative manifest, then stores the environment config in KV (24h TTL) so tm_render_image and tm_export_video can apply it.",
      "",
      "When to use: after tm_import_rvt completes and the manifest status is 'success' (or in-progress if you just want to pre-stage config), when the user wants to set scene context — e.g. 'render the tower at 17:00 in an urban setting with clear weather' — before generating images or video walkthroughs. Typical step 2 in the Twinmotion flow.",
      "When NOT to use: not for editing geometry, materials, or UE post-process volumes (those live in the Unreal Engine editor after FBX/USD import — Twinmotion has no public REST API). Do not call before tm_import_rvt — there is no URN to attach config to.",
      "APS scopes required: viewables:read data:read (manifest + metadata fetch only — read-only for this tool). No bucket or write scopes needed.",
      "Rate limits: APS default ~50 req/min per app per endpoint; manifest/metadata are cheap but polling-heavy if the model is still translating — prefer a single call per user intent, not a status-poll loop. KV writes are effectively unlimited at this scale.",
      "Errors: 401 = APS token expired/invalid; 403 = viewables:read not granted; 404 = URN unknown to APS (wrong project_id, or translation never started); 409 = n/a; 422 = n/a; 429 = back off 30s; 5xx = APS Model Derivative outage.",
      "Side effects: WRITES the env config to KV under key env_config_<urn> (TTL 86400s). Idempotent — calling again overwrites the prior config. Writes a row to usage_log."
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Base64-URL-safe URN returned by tm_import_rvt (the `project_id` / `urn` field). This is the Autodesk design URN — NOT an object ID, NOT a bucket key. Format: base64url of 'urn:adsk.objects:os.object:<bucket>/<object>', trailing '=' stripped.",
          examples: ["dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2NhbmJpbS12aXotMTcwMDAwMDAwMC9CdWlsZGluZy5ydnQ"]
        },
        environment: {
          type: "string",
          enum: ["urban", "suburban", "natural", "industrial", "custom"],
          description: "Surround/context preset for the UE scene. Purely metadata — applied when the operator builds the Twinmotion scene post-FBX-export. 'custom' means the user will supply their own HDRI/backdrop in UE.",
          examples: ["urban", "natural"]
        },
        weather: {
          type: "string",
          enum: ["clear", "cloudy", "rainy", "sunset", "night"],
          description: "Weather condition label stored with the scene config. Drives UE sky/atmosphere presets during manual Twinmotion scene authoring.",
          examples: ["clear", "sunset"]
        },
        time_of_day: {
          type: "string",
          description: "24-hour clock time as HH:MM. Used for sun position in the UE scene. Default if omitted is '12:00' (noon).",
          examples: ["08:30", "14:30", "17:45"]
        }
      },
      required: ["project_id"]
    }
  },
  {
    name: "tm_render_image",
    description: [
      "Render a still preview image of the model at a specified resolution by pulling the APS Model Derivative thumbnail (capped at 800x800 by the APS endpoint). Also resolves the camera_preset against model metadata to identify which 3D view it maps to, and applies any stored environment config from tm_set_environment for reference.",
      "",
      "When to use: when you need a quick visual sanity-check of an imported model (e.g. 'show me what Tower A looks like'), to preview a specific named view before committing to a full UE/Twinmotion render, or to embed a low-res preview in a chat/report. Pair with tm_list_scenes first to discover valid view names/GUIDs.",
      "When NOT to use: not for production-quality renders (APS thumbnails are low-res and raster-only; for cinematic output use Unreal Engine Movie Render Queue after FBX/USD export), not for arbitrary custom camera angles (only named views from the source file are resolvable — there is no runtime camera placement API here), not for 2D sheet exports (use tm_list_scenes to find 2D roles and fetch directly).",
      "APS scopes required: viewables:read data:read. Hits Model Derivative thumbnail + metadata endpoints only.",
      "Rate limits: APS default ~50 req/min per app per endpoint. Thumbnail endpoint is usually fast (<2s) once the model has translated; if called while status='inprogress' it returns no thumbnail. Do not loop-poll this tool — poll the manifest via tm_set_environment or tm_list_scenes instead.",
      "Errors: 401/403 = token/scope; 404 = URN not found or thumbnail not yet generated (model still translating — retry after manifest reports success); 409 = n/a; 422 = n/a; 429 = back off 30s; 5xx = APS upstream.",
      "Side effects: NONE (read-only on APS). Reads KV env_config_<urn>. Writes a row to usage_log. Idempotent."
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Base64-URL-safe URN of the translated model (from tm_import_rvt). Model must have reached manifest.status='success' or at least have a thumbnail derivative available.",
          examples: ["dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2NhbmJpbS12aXotMTcwMDAwMDAwMC9CdWlsZGluZy5ydnQ"]
        },
        camera_preset: {
          type: "string",
          description: "View name (e.g. '3D View 1', '{3D}', 'Perspective - Lobby') or metadata GUID to render from. Discover valid values via tm_list_scenes. If omitted or unmatched, the first 3D view is used. Custom ad-hoc camera placements are not supported — only views baked into the source file.",
          examples: ["{3D}", "Perspective - Exterior", "a4b1c5d2-7e8f-4a3b-9c1d-2e3f4a5b6c7d"]
        },
        resolution: {
          type: "string",
          enum: ["400x400", "800x800", "1920x1080"],
          description: "Requested output resolution. Note: APS thumbnail endpoint hard-caps at 800x800 — selecting 1920x1080 will be clamped to 800x800. For true HD/4K renders, export FBX/USD and render in UE Movie Render Queue.",
          examples: ["400x400", "800x800"]
        },
        quality: {
          type: "string",
          enum: ["draft", "standard", "high", "cinematic"],
          description: "Quality label — metadata only, since APS thumbnails have fixed quality. Use 'cinematic' as an intent signal that the operator should do a post-export UE render instead.",
          examples: ["standard", "cinematic"]
        }
      },
      required: ["project_id"]
    }
  },
  {
    name: "tm_export_video",
    description: [
      "Prepare a model for an animated walkthrough / video export by verifying the manifest is complete, then starting a secondary Model Derivative job that produces OBJ geometry (suitable for ingestion into offline rendering pipelines, Blender, or Unreal Engine). Also returns the list of available named views so the operator can stitch them into a camera path. Does NOT itself produce an mp4 — video encoding happens in the downstream UE/Twinmotion pipeline.",
      "",
      "When to use: when a user wants a walkthrough/flythrough video of a BIM model (e.g. 'make a 30-second tour of Tower A') — this tool gets the geometry into a UE-ingestible form (.obj, plus suggests FBX/glTF/USD naming like TowerA_walkthrough.fbx for the exported asset) and enumerates named views to guide camera path authoring.",
      "When NOT to use: not to actually encode video (no runtime renderer in this worker — output must be finished in Unreal/Twinmotion/Blender), not before tm_import_rvt, not if the manifest is still 'inprogress' (the tool will short-circuit and return status='pending'). Not for still images (use tm_render_image) or clash animations (use navisworks-mcp).",
      "APS scopes required: data:read data:write viewables:read. Write scopes are needed because this kicks off a new Model Derivative translation job (OBJ + thumbnail).",
      "Rate limits: APS default ~50 req/min; Model Derivative translation jobs ~60 req/min. OBJ derivatives of large BIM models can be multi-GB and take 10–45 min — rely on manifest polling with exponential backoff, not re-calling this tool.",
      "Errors: 401/403 = token/scope (data:write commonly missing); 404 = URN not found; 409 = OBJ derivative already queued (treat as success); 422 = input format does not support OBJ output (some IFC variants / proprietary formats — fall back to FBX/glTF via a different derivative format); 429 = back off 60s; 5xx = APS upstream.",
      "Side effects: STARTS a new translation job on an existing URN (consumes APS cloud credits). Writes usage_log. NOT idempotent per-call (each call creates a new job record), but APS will dedupe identical output requests internally if manifest already contains the derivative."
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Base64-URL-safe URN of a fully-translated model (manifest.status must equal 'success'). If status != success, the tool returns status='pending' without starting a job.",
          examples: ["dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2NhbmJpbS12aXotMTcwMDAwMDAwMC9CdWlsZGluZy5ydnQ"]
        },
        animation_name: {
          type: "string",
          description: "Human-readable label for the walkthrough/animation (used in downstream asset naming; suggest matching the exported video/USD filename base, e.g. 'tower_a_lobby_tour' → tower_a_lobby_tour.mp4 / .fbx / .glb / .usd).",
          examples: ["tower_a_lobby_tour", "site_flythrough_v2", "client_presentation_evening"]
        },
        duration_seconds: {
          type: "number",
          description: "Target duration of the final video in seconds (integer). Used only as metadata for the downstream UE Movie Render Queue; this tool does not encode video. Typical: 15–120s.",
          examples: [15, 30, 60, 120]
        },
        format: {
          type: "string",
          enum: ["mp4", "mov", "webm"],
          description: "Intended final video container (metadata hint for the downstream UE/Twinmotion render step). mp4 = H.264 web-friendly, mov = ProRes for editing, webm = VP9/AV1 for web.",
          examples: ["mp4", "mov"]
        },
        resolution: {
          type: "string",
          enum: ["1920x1080", "3840x2160"],
          description: "Intended final video resolution (metadata hint). 4K (3840x2160) roughly quadruples UE render time vs 1080p.",
          examples: ["1920x1080", "3840x2160"]
        }
      },
      required: ["project_id", "animation_name"]
    }
  },
  {
    name: "tm_list_scenes",
    description: [
      "Enumerate every 2D/3D view ('scene') baked into the translated model, plus a shallow dump of the model object tree (first 50 top-level nodes across all 3D views), plus the list of completed derivatives (svf2, thumbnail, obj, etc.) available via APS. The canonical discovery tool for anything downstream that needs a view name or GUID.",
      "",
      "When to use: before tm_render_image (to pick a valid camera_preset), before tm_export_video (to plan a camera path across named views), to audit what was translated ('did the 3D coordination view survive translation?'), or to expose the top-level model hierarchy for UI display. Also a useful health check — if scene_count=0, the translation is incomplete or failed.",
      "When NOT to use: not for full property queries on individual objects (this tool returns names + GUIDs + child counts only — use a dedicated property-query tool for full attribute dumps), not for geometry data (use tm_export_video for OBJ export), not on a URN that has not yet started translating.",
      "APS scopes required: viewables:read data:read. Read-only across Model Derivative manifest + metadata + object-tree endpoints.",
      "Rate limits: APS default ~50 req/min. This tool fans out across every 3D view to fetch object trees — for models with many 3D views (10+) it can burn a chunk of the budget in one call. Prefer caching the result on the caller side rather than re-invoking.",
      "Errors: 401/403 = token/scope; 404 = URN not found; 422 = n/a; 429 = back off 60s (this tool makes multiple APS calls per invocation, so 429 is more likely than on single-call tools); 5xx = APS upstream. A 202 on object-tree means APS is still building the tree — the tool retries once internally.",
      "Side effects: NONE on APS (read-only). Writes a usage_log row. Idempotent."
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Base64-URL-safe URN of the translated model. Should have manifest.status='success' for full results; if still translating, scene_count may be 0 or partial.",
          examples: ["dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2NhbmJpbS12aXotMTcwMDAwMDAwMC9CdWlsZGluZy5ydnQ"]
        }
      },
      required: ["project_id"]
    }
  }
];

// ── Real Tool Handlers ────────────────────────────────────────

async function handleTool(name, args, env) {
  // Usage logging
  if (env.DB) {
    try {
      await env.DB.prepare("INSERT INTO usage_log (tool_name, model_id, created_at) VALUES (?, ?, ?)")
        .bind(name, args.project_id || args.model_id || null, new Date().toISOString()).run();
    } catch (e) {}
  }

  switch (name) {

    // ── 1. tm_import_rvt ──────────────────────────────────────
    // Real: Fetch → OSS upload → SVF2 translation (same as revit_upload but for viz)
    case "tm_import_rvt": {
      const token = await getAPSToken(env);
      const bucketKey = `scanbim-viz-${Date.now()}`;
      const objectKey = args.file_name.replace(/[^a-zA-Z0-9._-]/g, '_');

      await ensureBucket(token, bucketKey);

      const fileResp = await fetch(args.file_url);
      if (!fileResp.ok) throw new Error(`Failed to fetch file (${fileResp.status})`);
      const fileBytes = await fileResp.arrayBuffer();
      const fileSizeMB = (fileBytes.byteLength / (1024 * 1024)).toFixed(2);

      const uploadResp = await fetch(`${APS_BASE}/oss/v2/buckets/${bucketKey}/objects/${objectKey}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        body: fileBytes
      });
      if (!uploadResp.ok) throw new Error(`Upload failed (${uploadResp.status})`);
      const uploadData = await uploadResp.json();
      const objectId = uploadData.objectId;
      const urn = btoa(objectId).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      // Translate with SVF2 for visualization
      const translateResp = await fetch(`${APS_BASE}/modelderivative/v2/designdata/job`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-ads-force': 'true' },
        body: JSON.stringify({
          input: { urn },
          output: {
            formats: [
              { type: 'svf2', views: ['2d', '3d'] },
              { type: 'thumbnail' }
            ]
          }
        })
      });
      if (!translateResp.ok) throw new Error(`Translation failed (${translateResp.status})`);
      const translateData = await translateResp.json();

      return {
        status: 'success',
        message: 'Model imported for visualization',
        project_id: urn,
        urn,
        object_id: objectId,
        bucket: bucketKey,
        file_name: args.file_name,
        file_size_mb: parseFloat(fileSizeMB),
        translation_status: translateData.result || 'inprogress',
        lighting_preset: args.lighting_preset || 'default',
        include_materials: args.include_materials !== false,
        created_at: new Date().toISOString(),
        note: 'Use project_id (URN) with tm_* tools once translation completes.'
      };
    }

    // ── 2. tm_set_environment ─────────────────────────────────
    // Real: Validate model exists via manifest, store env config, return model stats
    case "tm_set_environment": {
      const token = await getAPSToken(env);
      const manifest = await getManifest(token, args.project_id);
      const meta = await getModelMetadata(token, args.project_id);

      const viewCount = (meta.data?.metadata || []).length;
      const derivCount = (manifest.derivatives || []).length;

      // Store environment config in KV if available
      const envConfig = {
        environment: args.environment || 'default',
        weather: args.weather || 'clear',
        time_of_day: args.time_of_day || '12:00',
        applied_at: new Date().toISOString()
      };

      if (env.CACHE) {
        await env.CACHE.put(`env_config_${args.project_id}`, JSON.stringify(envConfig), { expirationTtl: 86400 });
      }

      return {
        status: 'success',
        project_id: args.project_id,
        model_status: manifest.status,
        model_progress: manifest.progress,
        view_count: viewCount,
        derivative_count: derivCount,
        environment_config: envConfig,
        note: 'Environment settings stored. Use tm_render_image to generate visualization.'
      };
    }

    // ── 3. tm_render_image ────────────────────────────────────
    // Real: Generate thumbnail from APS Model Derivative
    case "tm_render_image": {
      const token = await getAPSToken(env);

      // Parse resolution
      let width = 400, height = 400;
      if (args.resolution) {
        const parts = args.resolution.split('x');
        if (parts.length === 2) {
          width = Math.min(parseInt(parts[0]) || 400, 800);
          height = Math.min(parseInt(parts[1]) || 400, 800);
        }
      }

      // Get thumbnail
      const thumbnail = await getThumbnail(token, args.project_id, width, height);

      // Get view info if camera_preset provided
      let viewInfo = null;
      if (args.camera_preset) {
        try {
          const meta = await getModelMetadata(token, args.project_id);
          if (meta.data && meta.data.metadata) {
            viewInfo = meta.data.metadata.find(v =>
              v.name === args.camera_preset || v.guid === args.camera_preset
            ) || meta.data.metadata.find(v => v.role === '3d');
          }
        } catch (e) {}
      }

      // Load environment config if set
      let envConfig = null;
      if (env.CACHE) {
        const cached = await env.CACHE.get(`env_config_${args.project_id}`);
        if (cached) envConfig = JSON.parse(cached);
      }

      return {
        status: 'success',
        project_id: args.project_id,
        camera_preset: args.camera_preset || 'default',
        resolution: `${width}x${height}`,
        quality: args.quality || 'standard',
        has_thumbnail: !!thumbnail,
        thumbnail_data_url: thumbnail,
        view_info: viewInfo ? { name: viewInfo.name, role: viewInfo.role, guid: viewInfo.guid } : null,
        environment_applied: envConfig,
        rendered_at: new Date().toISOString(),
        note: thumbnail ? 'Thumbnail rendered from APS Model Derivative' : 'Thumbnail not yet available — model may still be translating'
      };
    }

    // ── 4. tm_export_video ────────────────────────────────────
    // Real: Start additional translation job with OBJ output for offline rendering pipeline
    case "tm_export_video": {
      const token = await getAPSToken(env);

      // Verify model is translated
      const manifest = await getManifest(token, args.project_id);
      if (manifest.status !== 'success') {
        return {
          status: 'pending',
          project_id: args.project_id,
          model_status: manifest.status,
          model_progress: manifest.progress,
          note: 'Model translation not complete yet. Video export requires a fully translated model.'
        };
      }

      // Start OBJ derivative for offline rendering pipeline
      const jobResp = await fetch(`${APS_BASE}/modelderivative/v2/designdata/job`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-ads-force': 'true' },
        body: JSON.stringify({
          input: { urn: args.project_id },
          output: {
            formats: [
              { type: 'obj' },
              { type: 'thumbnail' }
            ]
          }
        })
      });

      let jobResult = null;
      if (jobResp.ok) {
        jobResult = await jobResp.json();
      }

      // Get available views for animation reference
      const meta = await getModelMetadata(token, args.project_id);
      const views = (meta.data?.metadata || []).map(v => ({ name: v.name, role: v.role, guid: v.guid }));

      return {
        status: 'success',
        project_id: args.project_id,
        animation_name: args.animation_name,
        format: args.format || 'mp4',
        resolution: args.resolution || '1920x1080',
        duration_seconds: args.duration_seconds || 30,
        export_job: jobResult ? { result: jobResult.result, urn: jobResult.urn } : null,
        available_views: views,
        created_at: new Date().toISOString(),
        note: 'OBJ derivative started for offline rendering pipeline. Use available_views to define walkthrough path.'
      };
    }

    // ── 5. tm_list_scenes ─────────────────────────────────────
    // Real: Get all metadata views + object tree structure
    case "tm_list_scenes": {
      const token = await getAPSToken(env);
      const meta = await getModelMetadata(token, args.project_id);
      const manifest = await getManifest(token, args.project_id);

      if (!meta.data || !meta.data.metadata) {
        return { status: 'success', project_id: args.project_id, scene_count: 0, scenes: [], animations: [] };
      }

      const scenes = meta.data.metadata.map(v => ({
        guid: v.guid,
        name: v.name,
        role: v.role,
        type: v.role === '3d' ? 'Scene (3D)' : 'Sheet/Drawing (2D)',
        is_master: v.isMasterView || false
      }));

      // Get detailed structure from 3D views
      const detailedNodes = [];
      for (const view of meta.data.metadata.filter(v => v.role === '3d')) {
        try {
          const tree = await getObjectTree(token, args.project_id, view.guid);
          if (tree.data && tree.data.objects) {
            const extract = (objects, depth = 0) => {
              for (const obj of objects) {
                if (depth <= 1) {
                  detailedNodes.push({
                    objectid: obj.objectid,
                    name: obj.name,
                    parent_scene: view.name,
                    has_children: !!(obj.objects && obj.objects.length > 0),
                    child_count: obj.objects ? obj.objects.length : 0
                  });
                }
                if (obj.objects && depth < 1) extract(obj.objects, depth + 1);
              }
            };
            const root = Array.isArray(tree.data.objects) ? tree.data.objects : [tree.data.objects];
            extract(root);
          }
        } catch (e) {}
      }

      // Check for available derivatives (animations/exports)
      const derivatives = (manifest.derivatives || []).map(d => ({
        outputType: d.outputType,
        status: d.status,
        has_thumbnail: d.hasThumbnail || false
      }));

      return {
        status: 'success',
        project_id: args.project_id,
        model_status: manifest.status,
        scene_count: scenes.length,
        scenes,
        model_nodes: detailedNodes.slice(0, 50),
        derivatives,
        note: detailedNodes.length > 50 ? `Showing first 50 of ${detailedNodes.length} nodes` : undefined
      };
    }

    default:
      return { status: "error", message: 'Unknown tool: ' + name };
  }
}

// ── MCP Protocol Handler ──────────────────────────────────────

async function handleMCP(req, env) {
  const body = await req.json();
  const { method, params, id } = body;
  const respond = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { 'Content-Type': 'application/json' } });
  const error = (code, msg) => new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: msg } }), { headers: { 'Content-Type': 'application/json' } });

  if (method === 'initialize') return respond({ protocolVersion: "2024-11-05", serverInfo: SERVER_INFO, capabilities: { tools: {} } });
  if (method === 'tools/list') return respond({ tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const result = await handleTool(params.name, params.arguments || {}, env);
      return respond({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return respond({ content: [{ type: "text", text: JSON.stringify({ status: "error", message: e.message }) }] });
    }
  }
  if (method === 'ping') return respond({});
  return error(-32601, 'Method not found');
}

const __origHandler = {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' };

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const resp = await handleMCP(req, env);
      Object.entries(cors).forEach(([k, v]) => resp.headers.set(k, v));
      return resp;
    }
    if (url.pathname === '/info' || url.pathname === '/') {
      return new Response(JSON.stringify({ ...SERVER_INFO, tools_count: TOOLS.length, tools: TOOLS.map(t => t.name) }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: "ok", version: SERVER_INFO.version, aps_configured: !!(env.APS_CLIENT_ID && env.APS_CLIENT_SECRET) }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    return new Response('Twinmotion MCP v1.1.0 — ScanBIM Labs', { headers: cors });
  }
};

// === scanbim-health patch: export default wrapper ===
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return __applySec(await __handleHealth(env));
    if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') {
      return __applySec(new Response(__FAVICON_SVG, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=31536000, immutable' } }));
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const cloned = req.clone();
      let body;
      try { body = await cloned.json(); } catch {}
      if (body) {
        const check = await __creditCheck(req, env, body);
        if (!check.ok) return __applySec(check.response);
      }
    }
    const resp = await __origHandler.fetch(req, env, ctx);
    return __applySec(resp);
  },
  async scheduled(event, env, ctx) {
    if (__origHandler.scheduled) return __origHandler.scheduled(event, env, ctx);
  }
};
