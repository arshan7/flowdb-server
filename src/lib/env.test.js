import test from "node:test";
import assert from "node:assert/strict";
import { assertRequiredEnv } from "./env.js";

const REQUIRED = [
  "DATABASE_URL",
  "API_KEY",
  "CONNECTION_ENCRYPTION_KEY",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_WEBHOOK_SECRET",
];

// Runs assertRequiredEnv() with a given set of vars present, capturing
// whether it exited and what it logged - process.exit/console.error are
// swapped out rather than actually killing the test runner.
function run(present) {
  const prevValues = Object.fromEntries(REQUIRED.map((name) => [name, process.env[name]]));
  for (const name of REQUIRED) {
    if (present.includes(name)) process.env[name] = "x";
    else delete process.env[name];
  }

  const prevExit = process.exit;
  // eslint-disable-next-line no-console
  const prevError = console.error;
  let exitCode = null;
  let logged = null;
  process.exit = (code) => {
    exitCode = code;
  };
  // eslint-disable-next-line no-console
  console.error = (msg) => {
    logged = msg;
  };

  try {
    assertRequiredEnv();
  } finally {
    process.exit = prevExit;
    // eslint-disable-next-line no-console
    console.error = prevError;
    for (const name of REQUIRED) {
      if (prevValues[name] === undefined) delete process.env[name];
      else process.env[name] = prevValues[name];
    }
  }

  return { exitCode, logged };
}

test("every required var present - no exit, nothing logged", () => {
  const { exitCode, logged } = run(REQUIRED);
  assert.equal(exitCode, null);
  assert.equal(logged, null);
});

test("one missing var - exits 1, names it", () => {
  const present = REQUIRED.filter((n) => n !== "CONNECTION_ENCRYPTION_KEY");
  const { exitCode, logged } = run(present);
  assert.equal(exitCode, 1);
  assert.match(logged, /CONNECTION_ENCRYPTION_KEY/);
});

test("multiple missing vars - names all of them", () => {
  const { exitCode, logged } = run(["DATABASE_URL", "API_KEY"]);
  assert.equal(exitCode, 1);
  assert.match(logged, /CONNECTION_ENCRYPTION_KEY/);
  assert.match(logged, /CLERK_SECRET_KEY/);
  assert.match(logged, /CLERK_PUBLISHABLE_KEY/);
  assert.match(logged, /CLERK_WEBHOOK_SECRET/);
});
