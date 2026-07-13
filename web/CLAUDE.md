# HELM Bridge — Web Frontend

## Project Overview
React 19 + Vite 8 + Tailwind 4 dashboard for Hermes Agent, branded as "HELM Bridge"
(the ship's AI persona). Served by Python backend on port 9119 behind Tailscale
Serve HTTPS. The built output goes to `../hermes_cli/web_dist/`.

## Branding

The dashboard is branded "HELM Bridge" throughout (sidebar header, browser tab,
mobile header, System page version label). The i18n brand strings (`brand` and
`brandShort`) are set to "HELM Bridge" / "HELM" in all language files. The active
theme is "helm" (HELM Bridge theme) in config.yaml. Internal references to the
Hermes Agent *software* (update checks, version display, API method names like
`checkHermesUpdate`) remain "Hermes" — that's the underlying platform name.

## Build Commands
```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
cd /home/neuronine/.hermes/hermes-agent/web
bun install        # install deps (if needed)
bun run build      # build to ../hermes_cli/web_dist/
bun run typecheck   # type-check only
bun run lint        # eslint
```

After build, restart the service:
```bash
systemctl --user restart hermes-dashboard.service
```

## Architecture

### Source Locations
- **Frontend:** `~/.hermes/hermes-agent/web/`
- **Built output:** `~/.hermes/hermes-agent/hermes_cli/web_dist/`
- **Backend web server:** `~/.hermes/hermes-agent/hermes_cli/web_server.py` (~17,000 lines)
- **Backend auth:** `~/.hermes/hermes-agent/hermes_cli/dashboard_auth/`
- **Account/cost tracking:** `~/.hermes/hermes-agent/agent/account_usage.py`
- **Usage pricing:** `~/.hermes/hermes-agent/agent/usage_pricing.py`
- **Systemd unit:** `~/.config/systemd/user/hermes-dashboard.service`

### Key Frontend Files

- `src/App.tsx` (~1380 lines) — Main shell: sidebar nav, routing, layout.
  - `BUILTIN_ROUTES_CORE` (line ~137): Route-to-component map. Add new routes here.
  - `BUILTIN_NAV_REST` (line ~170): Array of nav items, each with a `section` field. Items are grouped and rendered by section.
  - `NAV_SECTIONS` (line ~1326): Section ordering and labels (Bridge, Activity, Insights, System, Configuration).
  - `SidebarNavLink` (line ~830): Renders each nav item. `end` prop for `/` and `/sessions`.
- `src/index.css` — Global CSS: theme tokens, shadcn-compat color variables.
  - `@theme inline` block (~line 154): opacity tokens using `color-mix()`. Dark themes need 15-20% midground minimum for cards, 30%+ for borders, 75%+ for text-secondary.
- `src/themes/presets.ts` — Built-in theme definitions (Hermes Teal, Midnight, Ember, Mono, Cyberpunk, Rosé, Nous Blue, HELM Bridge, Default-Large).
- `src/themes/types.ts` — TypeScript types for themes.
- `src/themes/context.tsx` — ThemeProvider: applies theme CSS vars to `:root`.
- `src/lib/api.ts` (~2500 lines) — API client. All fetch calls go through `fetchJSON()`.
- `src/pages/` — Page components (22 pages). Each loads its own data on mount.
- `src/components/` — Shared components (26+).

### Pages

22 pages: HomePage, ChatPage, SessionsPage, CronPage, SystemPage, ConfigPage,
SkillsPage, LogsPage, ModelsPage, FilesPage, ChannelsPage, ProfilesPage,
ProfileBuilderPage, AnalyticsPage, McpPage, PluginsPage, WebhooksPage,
PairingPage, ResearchPage, CostPage, BrainPage, EnvPage, DocsPage.

Pattern: each page imports `api` from `@/lib/api`, fetches data in `useEffect`,
uses `Card`/`CardContent` from `@nous-research/ui`, icons from `lucide-react`,
`cn()` from `@/lib/utils`.

### Adding a New Page

1. Create `src/pages/YourPage.tsx` — follow existing patterns (useEffect + useState,
   Card/CardContent, icons from `lucide-react`, `api` from `@/lib/api`)
2. Import in `App.tsx` and add to `BUILTIN_ROUTES_CORE`
3. Add nav item to `BUILTIN_NAV_REST` (include icon import from lucide-react)
4. For root `/` route: change `BUILTIN_ROUTES_CORE` entry and fix NavLink `end` prop

### Adding a Backend API Endpoint

Endpoints live in `hermes_cli/web_server.py`. Pattern:
```python
@app.get("/api/your/endpoint")
async def your_endpoint(param: int = 30, profile: Optional[str] = None):
    # Use _open_session_db_for_profile(profile) for DB access
    # Return dict — FastAPI serializes to JSON
    return {"data": result}
```
Then add the API client method in `src/lib/api.ts`:
```typescript
yourMethod: (param: number) =>
  fetchJSON<YourResponseType>(`/api/your/endpoint?param=${param}`),
```

## API Reference

### Frontend API Methods (src/lib/api.ts)

| Method | Endpoint | Returns |
|--------|----------|---------|
| `api.getStatus()` | `/api/status` | Gateway state, platforms, version, session count |
| `api.getSystemStats()` | `/api/system/stats` | OS, CPU, memory, disk, uptime |
| `api.getCronJobs(profile)` | `/api/cron/jobs` | All cron jobs |
| `api.getSessions({ limit, offset })` | `/api/sessions` | Paginated session list |
| `api.getMemory()` | `/api/memory` | Memory provider status |
| `api.getConfig(profile)` | `/api/config` | Full config |
| `api.getSkills(profile)` | `/api/skills` | Installed skills |
| `api.getThemes()` | `/api/dashboard/themes` | Available themes + active |
| `api.getAnalytics(days)` | `/api/analytics/usage` | Daily + per-model token/cost analytics |
| `api.getModelsAnalytics(days)` | `/api/analytics/models` | Per-model analytics with capabilities |
| `api.getProviderCosts()` | `/api/cost/providers` | Live Nous + OpenRouter balance/usage |
| `api.getBrainOverview()` | `/api/brain/overview` | Checkpoint/fact-store/flat-memory/poller/dreaming stats |
| `api.getBrainCheckpoints(limit)` | `/api/brain/checkpoints` | Recent checkpoints with parsed facts + session title |
| `api.getBrainFlatMemory()` | `/api/brain/flat-memory` | MEMORY.md + USER.md contents and capacity |
| `api.getLogs({ file, lines, level })` | `/api/logs` | Log lines |
| `api.checkHermesUpdate()` | `/api/update/check` | Version check |

### Analytics Response Shape
The `/api/analytics/usage` endpoint returns:
- `daily[]` — per-day: `{ day, input_tokens, output_tokens, estimated_cost, actual_cost, sessions, api_calls }`
- `by_model[]` — per-model token/cost breakdown
- `totals` — `{ total_input, total_output, total_estimated_cost, total_actual_cost, total_sessions, ... }`
- `skills` — skill usage summary

The `/api/analytics/models` endpoint returns:
- `models[]` — per-model: `{ model, provider, input_tokens, output_tokens, estimated_cost, actual_cost, sessions, api_calls, tool_calls, capabilities }`
- `totals` — aggregate totals

### Cost/Provider Endpoint (`/api/cost/providers`)
Returns live balance/usage for each configured provider:
```json
{
  "providers": [
    {
      "provider": "nous",
      "label": "Nous / umans",
      "logged_in": bool,
      "balance_lines": ["Subscription credits: $X", ...],
      "topup_url": "https://...",
      "depleted": false
    },
    {
      "provider": "openrouter",
      "label": "OpenRouter",
      "logged_in": true,
      "windows": [{ "label": "API key quota", "used_percent": 5.2, "detail": "$18.84 of $20.00 remaining" }],
      "details": ["Credits balance: $18.84", "API key usage: $1.16 total • $1.16 today"],
      "fetched_at": "2026-07-11T18:20:18Z"
    }
  ]
}
```

Backend calls `agent/account_usage.py`:
- `build_credits_view()` for Nous/umans portal balance
- `fetch_account_usage("openrouter")` for OpenRouter credits API

### umans Usage Monitor
The Research and Cost pages read umans request usage from a JSONL log at
`~/.hermes/scripts/.umans-monitor/usage-log.jsonl`. Each line:
```json
{"ts":"2026-07-11T11:00:24-07:00","requests":111,"cap":200,"concurrency":0,"reset":"3h 57m"}
```
A cron job (Usage Logger, ID `6dc2a34f082c`, 15-min interval) writes these entries.

## Key Pages

### CostPage (`/cost`)
Unified cost tracking. Four sections:
1. **Summary Stats** — Estimated cost, monthly projection, umans usage, fixed subscriptions
2. **Provider Balances** — Live Nous + OpenRouter balance cards from `/api/cost/providers`
3. **umans Request Usage Chart** — JSONL monitor data, last 48 entries
4. **Daily Cost Chart + Cost-by-Model Table** — From analytics endpoints, surfaces `estimated_cost`

Constants: `UMANS_PLAN_COST = $20/mo`, `CLAUDE_CODE_COST = $20/mo`, `UMANS_CAP = 200`.

### ResearchPage (`/research`)
Overnight research system dashboard. Reads umans usage JSONL, poller state files,
research briefings from `~/.hermes/research/`, and cron job status for known research job IDs.

### BrainPage (`/brain`)
HELM's memory-systems dashboard. Four sections:
1. **Overview cards** — checkpoint count/cost, fact store size/trust, L1 MEMORY.md + USER.md capacity bars
2. **Recent Checkpoints** — latest 5, expandable to show parsed `facts_json` (entities, decisions, preferences, file states, unresolved threads)
3. **Poller + Dreaming status** — last/next run, poller run stats (sessions seen, checkpointed, errors), cron job IDs `a8e522dcd30b` (poller) and `2b96e49478b0` (dreaming)
4. **Flat memory contents** — collapsible MEMORY.md/USER.md entries, split on lines containing a lone `§` separator

Backend reads `~/.hermes/checkpoints/index.db` (checkpoints/cursors tables), `~/.hermes/memory_store.db`
(facts table), `~/.hermes/memories/{MEMORY,USER}.md`, and `~/.hermes/logs/checkpoint-poller.jsonl` directly
via read-only sqlite3 connections — see `_brain_open_index_db()` / `_get_brain_overview_sync()` in `web_server.py`.

### AnalyticsPage (`/analytics`)
Token analytics gated on `dashboard.show_token_analytics` config flag. Shows daily token
usage bar chart, per-model breakdown, skill usage. Does NOT display cost fields (use CostPage).

### ModelsPage (`/models`)
Per-model cards with token counts, estimated cost, capabilities. Also gated on
`dashboard.show_token_analytics`.

## Theme System

Themes are defined in `presets.ts` as `DashboardTheme` objects. Each theme has:
- **palette**: background/midground/foreground (hex + alpha)
- **typography**: font families, base size, line height, optional `fontUrl`
- **layout**: radius, density (compact/comfortable/spacious)
- **colorOverrides**: optional shadcn token overrides
- **customCSS**: raw CSS injected as a `<style>` tag
- **componentStyles**: per-component CSS var overrides

### Adding a New Theme
1. Define in `presets.ts` (export const + add to `BUILTIN_THEMES`)
2. **Sync backend**: add to `_BUILTIN_DASHBOARD_THEMES` in `hermes_cli/web_server.py`
3. Rebuild and restart

### Opacity Token System (index.css)
The shadcn-compat layer maps utility classes (`bg-card`, `text-muted-foreground`, etc.)
to CSS variables using `color-mix()` with midground percentages.

Verified readable values for dark themes:
- `--color-card`: 16%
- `--color-secondary`: 12%
- `--color-muted`: 18%
- `--color-accent`: 22%
- `--color-border` / `--color-input`: 35%
- `--color-popover`: 16%
- `--color-text-secondary`: 78%

`bg-card/50` opacity modifier compounds the issue — if base token is 16%, `/50` makes
it 8%. Check for `/N` modifiers when debugging transparency.

## UI Component Library

Uses `@nous-research/ui` package. Import pattern:
```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Button } from "@nous-research/ui/ui/components/button";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Stats } from "@nous-research/ui/ui/components/stats";
```

## Conventions
- Use existing component patterns from other pages (Card/CardContent, api calls in useEffect)
- Import icons from `lucide-react`
- Use `cn()` from `@/lib/utils` for conditional class names
- Use `api` from `@/lib/api` for all API calls
- Pages fetch their own data on mount (useEffect + useState)
- Keep the same dark-theme aesthetic — all themes are dark except Nous Blue

## Service Management
```bash
systemctl --user restart hermes-dashboard.service   # restart after build
systemctl --user status hermes-dashboard.service    # check status
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9119/api/status  # health check (expect 401)
```

Auth: basic auth (commander/helm-dashboard) via `dashboard_auth` middleware.
Login endpoint: POST `/auth/password-login` with `{"username":"commander","password":"...","provider":"basic"}`.

## Change Log

### 2026-07-11: Cost/Usage Page + Pricing Fix
- **New page**: `CostPage.tsx` at `/cost` — unified cost tracking for umans + OpenRouter
- **New backend endpoint**: `/api/cost/providers` in `web_server.py` — live provider balances
- **New API types**: `ProviderCostResponse`, `ProviderCostEntry`, `ProviderCostWindow` in `api.ts`
- **New API method**: `api.getProviderCosts()` in `api.ts`
- **Pricing fix**: `agent/usage_pricing.py` `_pricing_entry_from_metadata()` — was multiplying
  per-million prices by 1M (treating them as per-token). Now detects via threshold: values
  > $0.01 are already per-million, values below are per-token. Fixes 1,000,000x cost inflation
  for umans models. Historical data in state.db still inflated — new sessions will be correct.
- Nav: Cost item with DollarSign icon, after Research
