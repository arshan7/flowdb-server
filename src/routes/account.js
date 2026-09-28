import { Router } from "express";
import { clerkClient } from "@clerk/express";
import * as store from "../lib/tablespaceStore.js";
import { wrap, uid } from "./http.js";

export const accountRouter = Router();

// --- Legacy-project claim. Registered BEFORE the "/projects/:id"
// ownership guard below so ":id" can't swallow "unclaimed" /
// "claim-legacy". Projects that predate authentication have owner_user_id
// NULL and are invisible to every scoped query; the first signed-in user
// to claim adopts all of them (a one-time "import your existing projects"
// action in the Dashboard).
accountRouter.get(
  "/projects/unclaimed",
  wrap(async (req, res) => {
    res.json({ count: await store.countUnclaimedProjects() });
  }),
);

accountRouter.post(
  "/projects/claim-legacy",
  wrap(async (req, res) => {
    await store.ensureUser({ clerkUserId: uid(req) });
    const claimed = await store.claimLegacyProjects(uid(req));
    res.json({ claimed });
  }),
);

// --- Account data rights (export / delete). Scoped to the caller's own
// data only (uid(req)), never another project/source id - no ownership
// guard needed since there's no :id param to check here.
accountRouter.get(
  "/account/export",
  wrap(async (req, res) => {
    res.json(await store.exportAccountData(uid(req)));
  }),
);

accountRouter.delete(
  "/account",
  wrap(async (req, res) => {
    const clerkUserId = uid(req);
    // App data first (cascades everything below each project), then the
    // local user mirror, then the actual Clerk identity - in that order,
    // so a failure partway through never leaves someone able to sign back
    // into an account whose data is already gone. Clerk's own user.deleted
    // webhook fires after this and just no-ops (the row's already gone).
    await store.deleteAccountData(clerkUserId);
    await clerkClient.users.deleteUser(clerkUserId);
    res.json({ success: true });
  }),
);
