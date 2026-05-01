<p align="center">
  <img src="https://raw.githubusercontent.com/ValentinKolb/cloud/main/packages/cloud/public/logo.svg" alt="Cloud" width="96" height="96">
</p>

<h1 align="center">cloud-template</h1>

<p align="center">
  <em>Self-hosted cloud platform + your own app, in one <code>docker compose up</code>.</em>
</p>

---

## Quickstart

```bash
git clone https://github.com/ValentinKolb/cloud-template my-cloud
cd my-cloud
cp .env.example .env
docker compose up -d
```

Open <http://localhost:3000/auth/login?method=admin> and enter `dev-admin` as the token. You'll land in `/app/dashboard`. The example app sits at `/app/expeditions` and `/admin/expeditions`.

To stop: `docker compose down`. To wipe data: `docker compose down -v`.

### Editing your app

```bash
bun install                                 # local deps for IDE / typecheck
bun run dev                                 # standalone, no platform on :3000
docker compose up -d --build app-expeditions   # with the platform stack
```

---

## What's in the box

```
.
├── package.json            # name + deps
├── tsconfig.json           # @/* path alias for src/, jsx: solid-js
├── Dockerfile              # 3-stage build: deps → build → alpine runtime
├── compose.yml             # platform stack + your app
├── .env.example            # cloud-template namespaced credentials
└── src/
    ├── config.ts           # defineApp({ id, routes, nav, widgets, settings })
    ├── index.ts            # app.start({ fetch, openapi, lifecycle, capabilities })
    ├── migrate.ts          # CREATE … IF NOT EXISTS
    ├── contracts.ts        # Zod schemas → inferred TS types
    ├── styles/app.css      # @import "tailwindcss";
    ├── service/            # business logic
    ├── api/                # Hono routes + typed RPC client
    └── frontend/           # SSR pages + *.island.tsx
```

---

## How the platform works

```
                              HTTPS
                                ▼
                        ┌───────────────┐
                        │    Gateway    │   reads Redis registry, prefix-routes
                        │   (port 3000) │
                        └───┬───┬───┬───┘
                            ▼   ▼   ▼
                    ┌─────────┐ ┌─────────┐ ┌─────────────┐
                    │  core   │ │   …     │ │ expeditions │   one container = one app
                    │  (auth) │ │         │ │  (your app) │
                    └────┬────┘ └────┬────┘ └──────┬──────┘
                         └───────────┴─────────────┘
                                     │
                              ┌──────┴──────┐
                              ▼             ▼
                         ┌────────┐    ┌──────────┐
                         │ Valkey │    │ Postgres │
                         │(Redis) │    │          │
                         └────────┘    └──────────┘
```

Each app is its own Bun process; it registers in Redis at boot and the gateway picks it up within ~5 s. Routing is by URL prefix (`/app/<id>`, `/api/<id>`, `/admin/<id>`, `/public/<id>`) declared in `defineApp({ routes: […] })`.

Apps share the session, the UI kit, services (logging, notifications, settings, search), and Postgres (each app owns its own schema).

The bundled `expeditions` app exercises every primitive — tenancy, child items, permissions, admin page, dashboard widget, transactional email, structured logging.

---

## Anatomy of an app

### `config.ts` — app identity

```ts
import { defineApp } from "@valentinkolb/cloud";

export const app = defineApp({
  id: "expeditions",                          // URL slug + Redis registry key
  name: "Expeditions",
  icon: "ti ti-map-2",                        // Tabler icon class
  description: "Plan a journey, …",
  basePath: "/app/expeditions",
  baseUrl: "http://app-expeditions:3000",     // matches the compose service name
  adminHref: "/admin/expeditions",
  nav: { href: "/app/expeditions", section: "primary", requiresAuth: true, requiresRoles: ["user"] },
  widgets: [{ id: "active", path: "/api/expeditions/widget/active" }],
  routes: ["/api/expeditions", "/app/expeditions", "/admin/expeditions", "/public/expeditions"],
});

export const { ssr, plugin } = app;
```

Standard apps follow a four-prefix `routes` convention:

| Prefix | What lives there |
|---|---|
| `/api/<id>` | every HTTP API endpoint — widget, admin api, websocket, CRUD |
| `/app/<id>` | user-facing SSR pages |
| `/admin/<id>` | admin SSR pages, gated by `auth.requireRole("admin")` |
| `/public/<id>` | per-app built CSS bundle |

Apps with non-standard URLs (OAuth, legal pages) just list whatever top-level prefixes they own.

### `index.ts` — bootstrap

```ts
import { Hono } from "hono";
import { middleware, type AuthContext } from "@valentinkolb/cloud/server";
import { app } from "./config";
import apiRoutes from "./api";
import pageRoutes, { adminPages } from "./frontend";
import { migrate } from "./migrate";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())   // c.get("runtime"), required by Layout/Sidebar
  .use("*", middleware.settings())  // c.get("settings"), required for typed settings
  .route("/api/expeditions",   apiRoutes)
  .route("/app/expeditions",   pageRoutes)
  .route("/admin/expeditions", adminPages);

export default await app.start({
  fetch: router.fetch,
  // Pair with defineApp's `openapi: "/api/expeditions/openapi.json"`. The
  // framework generates the spec from this router and serves it publicly;
  // the platform's api-docs app aggregates every advertised spec into one
  // Scalar UI. Drop both fields if your app has no API surface.
  openapi: apiRoutes,
  lifecycle: {
    setup: async () => { await migrate(); },  // runs once per container boot, idempotent
  },
});
```

### `migrate.ts` — schema setup

`CREATE SCHEMA / TABLE IF NOT EXISTS`. The schema is namespaced (`expeditions.*`).

### `contracts.ts` — Zod schemas

Same schemas validate at the API boundary, type the service signatures, and feed `describeRoute` for the OpenAPI doc.

### `service/` — stateless namespaced functions

Shape: `expeditionsService.expedition.create({ … })`. Both API routes and SSR pages call services directly. Permission checks live in the service.

### `api/` — thin handlers

```ts
new Hono<AuthContext>()
  .use(auth.requireRole("user"))
  .post("/", v("json", CreateExpedition), describeRoute({ ... }), async (c) => {
    const result = await expeditionsService.expedition.create({
      input: c.req.valid("json"),
      userId: c.get("user").id,
    });
    return respond(c, result);
  });
```

`v` validates input via Zod; `respond` maps `Result<T>` to 200 / 4xx / 5xx.

### `api/client.ts` — typed RPC

```ts
import { api } from "@valentinkolb/cloud/browser";
import type { ApiType } from ".";

export const apiClient = api.create<ApiType>({ baseUrl: "/api/expeditions" });
```

Renames in handlers surface as compile errors in islands.

### `frontend/` — SSR pages + islands

Pages return `() => JSX` and render inside `<Layout>` or `<AdminLayout>`. Files ending in `*.island.tsx` hydrate on the client.

---

## The mutation + prompts pattern

```tsx
import { mutation as mutations } from "@valentinkolb/stdlib/solid";
import { prompts, refreshCurrentPath } from "@valentinkolb/cloud/ui";
import { apiClient } from "@/api/client";

const createWaypoint = mutations.create<void, { title: string }>({
  mutation: async (data) => {
    const res = await apiClient[":id"].waypoints.$post({
      param: { id: expeditionId },
      json: data,
    });
    if (!res.ok) {
      const body = await res.json();
      throw new Error("message" in body ? body.message : "Failed");
    }
  },
  onSuccess: () => refreshCurrentPath(),
  onError: (e) => prompts.error(e.message),
});

const handleClick = async () => {
  const result = await prompts.form({
    title: "Add waypoint",
    icon: "ti ti-map-pin-plus",
    fields: { title: { type: "text", label: "Title", required: true } },
  });
  if (result) createWaypoint.mutate(result);
};
```

| Prompt | Use for |
|---|---|
| `prompts.confirm(message, opts)` | destructive yes/no, returns boolean |
| `prompts.form({ fields })` | typed input dialog with built-in validation |
| `prompts.dialog((close) => <JSX/>, opts)` | custom dialog body |
| `prompts.alert(message, opts)` | informational, single OK button |
| `prompts.error(message)` | toast-style error |
| `prompts.search(resolver, opts?)` | async-loaded picker |

---

## View transitions

Every same-origin navigation uses the browser's native View Transitions API — no client-side router. Add `view-transition-name` for shared-element morphs:

```jsx
<a href={`/app/expeditions/${e.id}`}
   style={`view-transition-name: expedition-card-${e.id}`}>
  {e.title}
</a>

<h1 style={`view-transition-name: expedition-card-${expedition.id}`}>
  {expedition.title}
</h1>
```

Convention: `{app}-{element}-{id?}`.

---

## Platform primitives

### Authentication

```ts
import { auth, type AuthContext } from "@valentinkolb/cloud/server";

new Hono<AuthContext>()
  .use(auth.requireRole("user"))                  // signed-in non-guest
  .use(auth.requireRole("admin"))                 // sysadmin only
  .use(auth.requireRole("authenticated"))         // any signed-in user incl. guests
  .use(auth.requireRole("*"))                     // load user if present, never block
  .use(auth.requireRole("anonymous"))             // logged-out users only
```

`c.get("user")` returns the full user. On SSR pages, pass `auth.redirectToLogin` as the second argument to redirect anonymous visitors.

### Logging

```ts
import { logger } from "@valentinkolb/cloud/services/logging";

const log = logger("expeditions");
log.info("waypoint.created", { expeditionId, waypointId });
log.error("expedition.completion-mail.failed", { message: e.message });
```

Async, non-blocking. Admin viewer at `/admin/logging`. Sensitive keys (`password`, `token`, `secret`, `cookie`, `authorization`, `api_key`, `session`) are auto-redacted.

### Transactional email

```ts
import { notifications } from "@valentinkolb/cloud/services";

await notifications.send({
  type: "email",
  recipient: "user@example.com",
  subject: "🏁 Expedition completed: Apollo 11",
  content: "Hi Alice,\n\nYou just completed the expedition…",
  // rawHtml: "<h1>…</h1>",   // alternative to plain `content`
  // autoSend: false,          // queue for manual review
  // sentBy: user.id,          // attribute in the audit log
});
```

Persists to `notifications.messages`, attempts SMTP, surfaces in `/admin/notifications`. Wrap in `.catch((e) => log.error(...))` to keep failures out of the request path.

### Settings

Runtime-configurable, encrypted at rest, cached in memory. Resolution: DB value → env fallback → code default.

```ts
defineApp({
  id: "expeditions",
  // …
  settings: {
    "expeditions.notify_on_completion": {
      kind: "boolean",
      label: "Notify on completion",
      default: true,
      description: "Email the creator when an expedition completes.",
    },
  },
})
```

In handlers: `c.get("settings")["expeditions.notify_on_completion"]` (sync, frozen, type-checked — populated by `middleware.settings()`). Outside handlers: `await settings.get<T>(key)` from `@valentinkolb/cloud/services` (async, hits the cache).

Registered settings appear in `/admin/settings`.

### Dashboard widgets

```ts
const app = new Hono<AuthContext>()
  .use(auth.requireRole("*"))
  .get("/active", async (c) => {
    const user = c.get("user");
    if (!user) return c.body(null, 403);   // 403 = "locked at your access level"

    return c.json<WidgetResponse>({
      title: "Expeditions",
      icon: "ti ti-map-2",
      href: "/app/expeditions",
      blocks: [{ kind: "list", grow: true, items: /* … */ }],
    });
  });
```

Block kinds: `stat`, `list`, `status`, `pills`, `hero`.

### Universal search

```ts
app.start({
  fetch: router.fetch,
  capabilities: {
    search: {
      tags: ["expeditions"],
      help: "Search expeditions by title",
      run: async ({ query, limit, ctx }) => {
        const rows = await sql`
          SELECT id, title FROM expeditions.expeditions
          WHERE LOWER(title) LIKE ${"%" + query.toLowerCase() + "%"}
          LIMIT ${limit}
        `;
        return rows.map((r) => ({ id: r.id, title: r.title, href: `/app/expeditions/${r.id}`, icon: "ti ti-map-2" }));
      },
    },
  },
});
```

Results appear under `Cmd+K`.

### WebSockets

```ts
import { websocket } from "hono/bun";
const result = await app.start({ fetch: router.fetch, lifecycle });
export default { ...result, websocket };
```

`upgradeWebSocket` from `hono/bun` works inside your router because the
framework threads Bun's server context (`c.env`) through to the user fetch.

---

## Layout patterns

| Pattern | Use for |
|---|---|
| **Card grid** — `max-w-4xl mx-auto` + `grid grid-cols-1 sm:grid-cols-2 gap-2` of `<a class="paper">` | List of "things you own" |
| **Sidebar + content** — `<Layout fullWidth>` with `app-cols` grid | Tree navigation + main view + side detail |
| **Admin table** — `<AdminLayout stretch>` with `StatCell` + `SearchBar` + `<table>` | List + search + pagination |
| **Detail with action header** — single-column `paper` with header + `paper`-rowed items | One thing in depth |

### CSS classes

| Class | Purpose |
|---|---|
| `paper`, `paper-highlighted` | rounded card |
| `btn-primary`, `btn-secondary`, `btn-danger`, `btn-success`, `btn-simple`, `btn-input` | button variants |
| `btn-sm`, `btn-md` | button sizes |
| `text-primary`, `text-secondary`, `text-dimmed`, `text-label` | foreground tones |
| `app-cols` | responsive sidebar + content grid |
| `info-block-info`, `info-block-warning`, `info-block-danger` | inline banners |
| `section-label` | small uppercase header |
| `thumbnail` | rounded square icon container |

Tailwind oxide auto-scans `src/**`. Framework UI styles come from `core`'s pre-built `/public/global.css` — no `@source` for `node_modules` needed.

Tabler icons: `<i class="ti ti-map-2 text-dimmed" />`. Browse at [tabler.io/icons](https://tabler.io/icons).

---

## URL state

Pagination, filters, and selection live in the URL:

```ts
const url = new URL(c.req.raw.url);
const search = url.searchParams.get("search") ?? "";
const page = Number(url.searchParams.get("page") ?? 1);
```

`SearchBar` syncs an input field to a URL param:

```tsx
<SearchBar action="/admin/expeditions" param="search" placeholder="Search…" />
```

```ts
import { navigateTo, refreshCurrentPath } from "@valentinkolb/cloud/ui";

navigateTo("/app/expeditions");           // hard navigation
refreshCurrentPath();                     // re-run SSR for the current URL
```

---

## Renaming the app

The template ships as `expeditions`. To make it yours:

1. Rename `id`, `name`, `description`, `basePath`, `baseUrl`, `adminHref`, `nav.*`, `widgets[].path`, every entry in `routes` in `src/config.ts`.
2. Find-and-replace `expeditions` → `<your-id>` across `src/`.
3. Rename the Postgres schema in `src/migrate.ts`.
4. Update the service name + `APP_ID` env in `compose.yml` and `Dockerfile`.

Or start fresh: keep `defineApp(…) + app.start({ fetch: router.fetch })`, delete the rest.

---

## Configuring the platform

The compose file ships with **7 platform apps active** (gateway, core, dashboard, settings, logging, notifications, accounts). To enable more, uncomment the relevant block at the bottom of `compose.yml`:

| Service | Image | Purpose |
|---|---|---|
| `app-notebooks` | `cloud-app-notebooks:latest` | Collaborative notes (Yjs) |
| `app-files` | `cloud-app-files:latest` | Shared file storage (needs `filegate`) |
| `app-spaces` | `cloud-app-spaces:latest` | Kanban / list / calendar with iCal |
| `app-contacts` | `cloud-app-contacts:latest` | Directory views |
| `app-faq` | `cloud-app-faq:latest` | FAQ pages |
| `app-quotes` | `cloud-app-quotes:latest` | Random quotes widget |
| `app-tools` | `cloud-app-tools:latest` | UUID, password, hash generators |
| `app-weather` | `cloud-app-weather:latest` | Weather widget |
| `app-oauth` | `cloud-app-oauth:latest` | OAuth2 issuer |
| `app-proxy-auth` | `cloud-app-proxy-auth:latest` | Traefik forward-auth |
| `app-ipa-hosts` | `cloud-app-ipa-hosts:latest` | FreeIPA host management |

App-specific settings (FreeIPA URL, SMTP credentials, file paths) go through `/admin/settings`.

---

## Production deployment

The included `Dockerfile` produces a ~160 MB Alpine image. For real deployments, point a reverse proxy (Traefik, Caddy, nginx) at `gateway:3000` and strip `ports: ["3000:3000"]` from `compose.yml`.

For a complete production template (Traefik labels, internal networks, healthchecks), see [`compose.prod.yml`](https://github.com/ValentinKolb/cloud/blob/main/compose.prod.yml) in the platform repo.

---

## Reference

- **[github.com/ValentinKolb/cloud](https://github.com/ValentinKolb/cloud)** — platform monorepo
- **[npmjs.com/package/@valentinkolb/cloud](https://www.npmjs.com/package/@valentinkolb/cloud)** — the framework npm package
- **[ghcr.io/valentinkolb](https://github.com/ValentinKolb?tab=packages&repo_name=cloud)** — published Docker images

## License

MIT © Valentin Kolb
