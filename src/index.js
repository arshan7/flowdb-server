import "dotenv/config";
import { assertRequiredEnv } from "./lib/env.js";

// Validated before server.js (or anything it imports, like db.js) ever
// loads - a dynamic import() defers evaluation to this exact point, so a
// missing var exits here with one clear message instead of surfacing as
// whichever module happens to touch it first.
assertRequiredEnv();

await import("./server.js");
