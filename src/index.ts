import { Hono } from "hono";
import { middleware, type AuthContext } from "@valentinkolb/cloud/server";
import { app } from "./config";
import apiRoutes from "./api";
import pageRoutes from "./frontend";
import { adminPages as adminPageRoutes } from "./frontend";
import { migrate } from "./migrate";
import { expeditionsService } from "./service";

/**
 * Container entrypoint for the expeditions app.
 *
 * Compose your own router with whatever middleware you need:
 *   - middleware.runtime()   c.get("runtime"), required by Layout/Sidebar
 *   - middleware.settings()  c.get("settings"), required for typed settings
 *   - middleware.logger()    HTTP request logger
 *   - middleware.ratelimit() sliding-window rate limit
 *
 * Then pass `router.fetch` to `app.start({ fetch })`. The framework owns
 * `/_ssr/*`, `/public/*`, and (when capabilities.search is set)
 * `/api/_internal/search` — these mount before your router.
 *
 * Standard four-prefix mount:
 *   /api/expeditions/*    — widget + CRUD endpoints
 *   /app/expeditions/*    — SSR pages
 *   /admin/expeditions/*  — admin SSR pages (admin-gated)
 *   /public/expeditions/* — built CSS, served automatically by the framework
 */
const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/expeditions", apiRoutes)
  .route("/app/expeditions", pageRoutes)
  .route("/admin/expeditions", adminPageRoutes);

export default await app.start({
  fetch: router.fetch,
  lifecycle: {
    // Runs once per container boot. Idempotent — safe to re-run on every
    // restart. Never destructive.
    setup: async () => {
      await migrate();
    },
  },
});

// Re-export the service for any sibling app that wants to read expeditions
// data (none currently do, but the convention matches notebooks/spaces).
export { expeditionsService as service };
export type { ApiType } from "./api";
