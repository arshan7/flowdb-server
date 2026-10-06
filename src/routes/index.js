import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { logger } from "../lib/logger.js";
import { wrap, uid } from "./http.js";
import { accountRouter } from "./account.js";
import { projectsRouter } from "./projects.js";
import { sourcesRouter } from "./sources.js";
import { queryRouter } from "./query.js";
import { dataRouter } from "./data.js";
import { tablesRouter } from "./tables.js";
import { modelsRouter } from "./models.js";
import { reportsRouter } from "./reports.js";
import { dashboardsRouter } from "./dashboards.js";
import { collectionsRouter } from "./collections.js";
import { branchesRouter } from "./branches.js";
import { checkpointsRouter } from "./checkpoints.js";
import { viewsRouter } from "./views.js";
import { exprRouter } from "./expr.js";
import { alertsRouter } from "./alerts.js";
import { subscriptionsRouter } from "./subscriptions.js";

// One router per resource (see docs/PROJECT_STRUCTURE.md in the client repo for the
// mirrored layout). Order matters: account routes register before the ownership
// guards so "/projects/unclaimed" isn't swallowed by "/projects/:id".

// --- Ownership boundary. Every route under /projects/:id (its sources,
// branches, models, reports, dashboards, checkpoints, collections) and
// every route under /sources/:sourceId funnels through one of these
// first. A missing row, someone else's row, or an unclaimed legacy row
// all return 404 - never 403, which would confirm the project exists to
// someone who has no business knowing.
async function assertProjectOwner(req, res, next) {
  const owner = await store.getProjectOwnerId(req.params.id);
  if (!owner || owner.ownerUserId == null || owner.ownerUserId !== uid(req)) {
    res.status(404).json({ error: "Project not found." });
    return;
  }
  next();
}

async function assertSourceOwner(req, res, next) {
  const owner = await store.getSourceOwnerId(req.params.sourceId);
  if (!owner || owner.ownerUserId == null || owner.ownerUserId !== uid(req)) {
    res.status(404).json({ error: "Source not found." });
    return;
  }
  next();
}

export const apiRouter = Router();

apiRouter.use(accountRouter);

apiRouter.use("/projects/:id", wrap(assertProjectOwner));
apiRouter.use("/sources/:sourceId", wrap(assertSourceOwner));

apiRouter.use(projectsRouter);
apiRouter.use(sourcesRouter);
apiRouter.use(queryRouter);
apiRouter.use(dataRouter);
apiRouter.use(tablesRouter);
apiRouter.use(modelsRouter);
apiRouter.use(reportsRouter);
apiRouter.use(dashboardsRouter);
apiRouter.use(collectionsRouter);
apiRouter.use(branchesRouter);
apiRouter.use(checkpointsRouter);
apiRouter.use(viewsRouter);
apiRouter.use(exprRouter);
apiRouter.use(alertsRouter);
apiRouter.use(subscriptionsRouter);

// eslint-disable-next-line no-unused-vars
apiRouter.use((err, req, res, next) => {
  logger.error("[tablespace] request failed", err);
  res.status(500).json({ error: "Internal server error." });
});
