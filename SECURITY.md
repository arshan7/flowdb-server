# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue.** Email **arshanreddy7@gmail.com** with
a description, impact, reproduction steps, and a suggested fix if you have
one. You'll get an acknowledgment within a few days, and credit in the
release notes once a fix ships (unless you'd rather stay anonymous).

## Threat model

flowdb-server is a backend that (a) stores Tablespace application data in
its own Postgres database and (b) connects to external Postgres databases
that its users point it at — for one-off introspection, and, for a
"Connected" source, for ongoing read-only queries.

Relevant report classes:

- **SQL injection** — any path where a table/column name or value from a
  request reaches SQL without being validated against the modelled schema
  and quoted/parameterised.
- **Auth bypass** — reaching an `/api/*` route without a valid `x-api-key`,
  or a timing side-channel on that check.
- **Reading another tenant's data** — today the whole instance is gated by
  one shared key with no per-user scoping (see "Known limitations"); a
  report of cross-*source* data leakage that isn't just "the shared key
  grants everything" is in scope.
- **Credential exposure** — a connection string appearing in a log, an
  error response, or the introspection output; a weakness in the
  AES-256-GCM at-rest encryption of stored connection strings
  (`src/lib/crypto.js`).
- **SSRF via the connection string** — using `/api/introspect` to reach
  hosts the operator didn't intend (cloud metadata endpoints, internal
  services).
- **Denial of service** — an unbounded query result, an unswept cache, a
  regex with catastrophic backtracking on request-controlled input, a
  crash from an unhandled rejection.
- Dependency vulnerabilities with a real exploit path in this app's usage.

## Known limitations (by design, pre-auth)

- **The `x-api-key` scheme is a shared secret, not real authentication.**
  It is inlined into the frontend bundle at build time, so anyone with
  browser devtools can read it. It stops casual internet abuse; it does not
  isolate users. Per-user / per-org auth is on the roadmap. Until it lands,
  run the deployed instance as a shared-trust environment and don't connect
  sources you wouldn't let every other user of that instance query.
- The 30-second result cache (`src/lib/queryCache.js`) is process-wide and
  not tenant-scoped — safe only under the shared-key model above, and
  called out in that file to be fixed when auth lands.
- `ALLOWED_ORIGIN` defaults to `*` when unset (local-dev convenience). Set
  it in production.

## Not in scope

- Attacks that require already holding a valid `API_KEY` and only affect
  data that key legitimately grants access to (that's the shared-trust
  model above, not a vulnerability).
- The `flowdb-migrations` repo — report those there.
