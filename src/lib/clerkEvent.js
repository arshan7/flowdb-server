// Maps a *verified* Clerk webhook event payload to the handful of fields
// we mirror into tablespace_users. Pure - no I/O, no svix, no db - so it's
// unit-tested directly against sample payloads (clerkEvent.test.js) while
// the signature check and the DB write stay in clerkWebhook.js.
//
// Clerk's `user.created` / `user.updated` payloads carry an array of
// email addresses plus `primary_email_address_id`; org membership only
// rides along when Clerk is configured to include it, so `orgId` is
// best-effort and usually null from a bare user.* event (an
// organizationMembership.* event is the reliable source, not subscribed
// here yet).
export function clerkEventToUser(evt) {
  const data = (evt && evt.data) || {};
  const emails = Array.isArray(data.email_addresses) ? data.email_addresses : [];
  const primary =
    emails.find((e) => e && e.id === data.primary_email_address_id) || emails[0] || null;
  const memberships = Array.isArray(data.organization_memberships) ? data.organization_memberships : [];

  return {
    clerkUserId: data.id || null,
    email: (primary && primary.email_address) || null,
    orgId: (memberships[0] && memberships[0].organization && memberships[0].organization.id) || null,
  };
}
