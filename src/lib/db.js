import pg from "pg";
import { splitSsl } from "./pgIntrospect.js";

// A single, long-lived pool created once at process startup and reused
// across every request - contrast with pgIntrospect.js's withClient(),
// which deliberately creates/tears down a pool PER REQUEST because it
// targets an arbitrary, user-supplied external database with unknown
// lifetime/trust. This pool targets flowdb-server's OWN fixed database
// (the same Postgres instance flowdb-migrations manages) - one connection
// target for the life of the process, so pooling it once is the correct,
// standard pattern here.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set - flowdb-server needs its own Postgres connection string (see .env.example).",
  );
}

// splitSsl decides the ssl config from the URL's sslmode, then strips
// sslmode out so pg's own connection-string parser can't override that
// choice (it reads sslmode=require as full cert verification, which fails
// against a private project CA like Aiven's even though the link is
// TLS-encrypted). Same helper the introspection/query paths use.
const { connectionString, ssl } = splitSsl(process.env.DATABASE_URL);

export const pool = new pg.Pool({
  connectionString,
  ssl,
  max: 5,
  connectionTimeoutMillis: 10_000,
});

// Without this handler, an error on an idle pooled connection (e.g. the
// database dropping it) is an unhandled 'error' event on the pool and
// crashes the whole process - a real, documented pg.Pool gotcha, not a
// hypothetical one.
pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[db] unexpected pool error:", err.message);
});

export const query = (text, params) => pool.query(text, params);
