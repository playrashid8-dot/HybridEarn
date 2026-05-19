import AdminAuditLog from "../models/AdminAuditLog.js";

/**
 * @param {object} opts
 * @param {import("mongoose").Types.ObjectId|string|null} [opts.adminId]
 * @param {string} opts.category
 * @param {string} opts.action
 * @param {import("mongoose").Types.ObjectId|string|null} [opts.targetUserId]
 * @param {object|null} [opts.meta]
 */
export async function writeAdminAudit(opts) {
  try {
    await AdminAuditLog.create({
      adminId: opts.adminId || null,
      category: opts.category,
      action: opts.action,
      targetUserId: opts.targetUserId || null,
      meta: opts.meta ?? null,
    });
  } catch (e) {
    console.error("admin audit log failed:", e?.message || e);
  }
}
