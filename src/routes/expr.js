import { Router } from "express";
import * as store from "../lib/tablespaceStore.js";
import { compileExpression, functionDocs } from "../lib/expr/compile.js";
import { ExprError } from "../lib/expr/parser.js";
import { modelColumnResolver } from "../lib/modelSql.js";
import { kindOfColumnType } from "../lib/modelEngine.js";
import { quoteIdent } from "../lib/queryEngine.js";
import { wrap } from "./http.js";

// Formulas: the function list the editor shows, and a check as the user types.
export const exprRouter = Router();
const KINDS = new Set(["number", "text", "date", "datetime", "bool"]);

const DOCS = functionDocs();
exprRouter.get("/expr/functions", (_req, res) => {
  res.set("Cache-Control", "private, max-age=3600");
  res.json(DOCS);
});

// Body: { text, mode: "row" | "agg", baseTableId?, joinTableIds?, columns? }
// Row formulas resolve against a model's tables (base + joined); measure formulas
// against a flat list of output columns ({ name, type }). Returns the result kind
// or the first error and where it is.
exprRouter.post(
  "/sources/:sourceId/expr/check",
  wrap(async (req, res) => {
    const { text, mode = "row", baseTableId = null, joinTableIds = [], joinModels = [], columns = null } = req.body || {};
    if (typeof text !== "string") {
      res.status(400).json({ error: "text is required." });
      return;
    }
    let column;
    if (Array.isArray(columns)) {
      const byName = new Map(columns.slice(0, 500).map((c) => [String(c.name), kindOfColumnType(c.type)]));
      column = (name) => (byName.has(name) ? { sql: quoteIdent(name), kind: byName.get(name) } : null);
    } else {
      const branch = await store.getMainBranch(req.params.sourceId);
      const nodes = (branch?.nodes || []).filter((n) => n.type === "tableNode");
      const base = nodes.find((n) => n.id === baseTableId);
      if (!base) {
        res.status(400).json({ error: "Pick a table first." });
        return;
      }
      const joined = (Array.isArray(joinTableIds) ? joinTableIds : []).map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
      // Joined Models: [{ name, columns: [{ name, kind }] }].
      const models = (Array.isArray(joinModels) ? joinModels : []).slice(0, 20).map((m, i) => ({
        label: String(m?.name ?? ""),
        alias: `model_${i}`,
        columns: (Array.isArray(m?.columns) ? m.columns : []).slice(0, 500).map((c) => String(c.name)),
        kinds: Object.fromEntries((Array.isArray(m?.columns) ? m.columns : []).slice(0, 500).map((c) => [String(c.name), KINDS.has(c.kind) ? c.kind : kindOfColumnType(c.type)])),
      }));
      column = modelColumnResolver(base, joined, models);
    }
    try {
      const out = compileExpression(text, { mode: mode === "agg" ? "agg" : "row", column, windowOrder: ["1"] });
      res.json({ ok: true, kind: out.kind });
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      res.json({ ok: false, error: e.message, at: e.at });
    }
  }),
);
