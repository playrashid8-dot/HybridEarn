import User from "../../models/User.js";

/**
 * Legacy cleanup: zero trial flags after trialExpiresAt.
 * New signups no longer receive trial credit; historical Mongo fields may remain until expiry.
 */
export async function expireTrialIfNeeded(userId, session = null) {
  const now = new Date();
  const filter = {
    _id: userId,
    isTrialActive: true,
    trialExpiresAt: { $lte: now },
  };
  const update = { $set: { trialBalance: 0, isTrialActive: false } };
  const q = User.updateOne(filter, update);
  if (session) q.session(session);
  await q;
}

/** Omit legacy trial columns from JSON returned to clients (DB fields may still exist). */
export function stripTrialFieldsFromClientUser(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  delete out.trialBalance;
  delete out.trialStartAt;
  delete out.trialExpiresAt;
  delete out.isTrialActive;
  delete out.trialSourceIp;
  return out;
}
