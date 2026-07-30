import "dotenv/config";
import express from "express";
import cors from "cors";
import { introspectRouter } from "./routes/introspect.js";
import { requireApiKey } from "./middleware/apiKey.js";

const app = express();

app.use(express.json({ limit: "1mb" }));

// ALLOWED_ORIGIN should be the deployed frontend's exact origin in production
// (e.g. https://your-app.vercel.app) - defaulting to "*" only so local dev
// against a not-yet-configured server doesn't stall on a CORS error before
// there's even an origin to lock it to.
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*",
    methods: ["GET", "POST"],
  }),
);

// Unauthenticated on purpose - Render (and any uptime monitor) needs to reach
// this without a secret, and it reveals nothing about the service beyond
// "it's running".
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", requireApiKey, introspectRouter);

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`flowdb-server listening on port ${port}`);
});
