# flowdb-server

Introspection API for [Tablespace/FlowDB](https://github.com/arshan7/FlowDB). Connects to a live Postgres database (Neon or any standard Postgres) and returns its schema in the exact `{ nodes, edges, enums }` shape the frontend's existing SQL/DBML importers already produce, so it plugs into the same import pipeline rather than needing a new one.

This is a pure introspection service - it reads `information_schema`/`pg_catalog`, never writes to the target database, and never stores connection credentials. Each request opens a fresh connection, runs the introspection queries, and closes it immediately.

## API

### `POST /api/introspect`

Headers:
- `x-api-key: <API_KEY>` (required)
- `Content-Type: application/json`

Body:
```json
{
  "connectionString": "postgres://user:pass@host/db?sslmode=require",
  "schema": "public"
}
```
`schema` is optional, defaults to `"public"`.

Response `200`:
```json
{ "nodes": [...], "edges": [...], "enums": [...] }
```
Same shape as `astToSchema()`/`dbmlToSchema()` in the frontend repo - table nodes have placeholder `position: {x: 0, y: 0}`, so the frontend should run its existing `gridLayout()` on the result before dropping it into the canvas, same as it already does for a pasted-SQL import.

Errors come back as `{ "error": "..." }` with a 400/401/404/502 status. The connection string is never echoed back or logged, even on failure.

### `GET /health`

Unauthenticated, for Render's health check / uptime monitoring. Returns `{ "status": "ok" }`.

## Local development

```bash
npm install
cp .env.example .env   # fill in API_KEY at minimum
npm run dev
```

Test it against a real database:
```bash
curl -X POST http://localhost:4000/api/introspect \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your API_KEY>" \
  -d '{"connectionString": "postgres://user:pass@host/db?sslmode=require"}'
```

## Deploying to Render

1. Push this repo to GitHub.
2. In Render: **New > Blueprint**, point it at this repo - `render.yaml` configures the service automatically.
   - Alternatively: **New > Web Service**, connect the repo, Render auto-detects Node (`npm install` / `npm start`).
3. In the service's **Environment** tab, set:
   - `API_KEY` - a random secret (matches what the frontend sends)
   - `ALLOWED_ORIGIN` - the deployed frontend's exact origin, e.g. `https://your-app.vercel.app`
4. Once deployed, the frontend calls `https://<your-service>.onrender.com/api/introspect`.

## Security notes

- **API_KEY is required in production.** The server fails closed (500, not "allow everything") if it isn't set - see `src/middleware/apiKey.js`.
- **Connections are ephemeral**, not pooled - a request's credentials only exist in memory for the duration of that one request.
- **CORS is locked to `ALLOWED_ORIGIN`** once set; only unset (defaults to `*`) for local dev convenience.
- This service can still be pointed at *any* reachable Postgres instance by anyone holding the API key - the API key protects against random internet abuse, not against a leaked key. Treat it like a password.
