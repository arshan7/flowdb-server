import pino from "pino";
import { reportError } from "./errorReporting.js";

// One shared logger for the whole server, replacing scattered console.*
// calls. error() also forwards to the existing optional Sentry wiring
// (reportError - a no-op without SENTRY_DSN) so call sites don't need to
// call both separately, the way server.js/tablespace.js used to.
const pinoLogger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
});

export const logger = {
  info: (msg, data) => pinoLogger.info(data, msg),
  warn: (msg, data) => pinoLogger.warn(data, msg),
  error: (msg, err) => {
    pinoLogger.error({ err }, msg);
    if (err instanceof Error) reportError(err);
  },
};
