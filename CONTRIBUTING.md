# Contributing to flowdb-server

## Getting set up

```bash
npm install
cp .env.example .env    # every variable is documented in that file
npm run dev
npm test                # node --test — must pass
npm run lint            # eslint — must pass clean
```

You need a Postgres instance for `DATABASE_URL` with the
[`flowdb-migrations`](../flowdb-migrations) schema applied.

## Conventions

- **ES modules**, Node ≥ 18. No build step — the source runs as-is.
- **Every async route handler goes through `wrap(...)`** (`src/routes/tablespace.js`)
  so a rejected promise reaches the Express error handler instead of
  becoming an unhandled rejection.
- **Validate at the boundary.** A route validates types / ranges / enum
  membership on `req.body` and `req.params` before calling into `lib/`.
  Every column or table name that will reach SQL is re-checked against the
  modelled schema — never trust the client's claim.
- **Parameterised SQL only.** Identifiers are quoted via the helpers in
  `queryEngine.js`; values are always bound parameters. Nothing from a
  request is concatenated into a query string.
- **The two databases are separate.** `lib/db.js` is the app's own pooled
  connection; `lib/pgIntrospect.js` opens a throwaway per-request pool to a
  user's external database. Don't blur them.
- Keep secrets out of logs and error responses — connection strings in
  particular are never echoed back, even on failure.
- Match the surrounding style: the codebase favours short comments that
  explain *why*, guard clauses over deep nesting, and specific error codes
  (e.g. mapping Postgres `23505` to a 409).

## Tests

`*.test.js` next to the file under test, run by `node --test`. A bug fix
comes with a regression test. The engine modules (`queryEngine`,
`modelEngine`, `schemaMerge`, `reconcile`, `schemaDiff`, `toTablespaceSchema`)
have the most coverage and are the place to add cases.

## Before a PR

- `npm run lint` and `npm test` pass clean.
- One change per PR.
- If you touch SQL construction or the auth middleware, say what you tested
  in the PR description.

Security-sensitive reports: email arshanreddy7@gmail.com, don't open a
public issue.
