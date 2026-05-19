import mongoose from "mongoose";
import User from "../models/User.js";
import HybridDeposit from "../hybrid/models/HybridDeposit.js";
import HybridWithdrawal from "../hybrid/models/HybridWithdrawal.js";
import AdminAuditLog from "../models/AdminAuditLog.js";

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

function toOid(id) {
  if (!id) return null;
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
}

export async function buildAdminOverview() {
  const [
    totalUsers,
    activeUsers,
    depositAgg,
    withdrawPaidAgg,
    pendingWithdrawalsCount,
    salaryPaidAgg,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ depositBalance: { $gte: 50 } }),
    HybridDeposit.aggregate([
      { $match: { status: { $in: ["credited", "swept"] } } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    HybridWithdrawal.aggregate([
      { $match: { status: "paid" } },
      { $group: { _id: null, total: { $sum: "$netAmount" }, count: { $sum: 1 } } },
    ]),
    HybridWithdrawal.countDocuments({
      status: { $in: ["review", "pending", "claimable", "approved"] },
    }),
    User.aggregate([
      { $unwind: { path: "$salaryHistory", preserveNullAndEmptyArrays: false } },
      { $group: { _id: null, total: { $sum: "$salaryHistory.amount" } } },
    ]),
  ]);

  const totalDepositsUsd = depositAgg[0]?.total ?? 0;
  const totalWithdrawalsPaidUsd = withdrawPaidAgg[0]?.total ?? 0;
  const totalSalaryPaidUsd = salaryPaidAgg[0]?.total ?? 0;
  const totalEarningsPaidUsd = totalWithdrawalsPaidUsd + totalSalaryPaidUsd;

  /** Last 10 mixed activities */
  const [recentDeposits, recentWithdrawals, recentAudits] = await Promise.all([
    HybridDeposit.find()
      .sort({ createdAt: -1 })
      .limit(6)
      .populate("userId", "username email")
      .lean(),
    HybridWithdrawal.find()
      .sort({ createdAt: -1 })
      .limit(6)
      .populate("userId", "username email")
      .lean(),
    AdminAuditLog.find()
      .sort({ createdAt: -1 })
      .limit(8)
      .populate("targetUserId", "username email")
      .populate("adminId", "username email")
      .lean(),
  ]);

  const activities = [];

  for (const d of recentDeposits) {
    activities.push({
      id: `dep:${d._id}`,
      kind: "deposit",
      at: d.createdAt,
      action: `Deposit ${d.status}`,
      amount: d.amount,
      username: d.userId?.username || d.userId?.email || "—",
      txHash: d.txHash,
    });
  }
  for (const w of recentWithdrawals) {
    activities.push({
      id: `wdr:${w._id}`,
      kind: "withdraw",
      at: w.createdAt,
      action: `Withdraw ${w.status}`,
      amount: w.netAmount,
      username: w.userId?.username || w.userId?.email || "—",
      txHash: w.txHash || "",
    });
  }
  for (const a of recentAudits) {
    activities.push({
      id: `aud:${a._id}`,
      kind: "admin",
      at: a.createdAt,
      action: a.action,
      username: a.targetUserId?.username || a.adminId?.username || "—",
      meta: a.meta,
    });
  }

  activities.sort((x, y) => new Date(y.at) - new Date(x.at));
  const lastActivities = activities.slice(0, 10);

  return {
    totalUsers,
    activeUsersDeposit50plus: activeUsers,
    totalDepositsUsd,
    totalDepositsCount: depositAgg[0]?.count ?? 0,
    totalWithdrawalsPaidUsd,
    totalWithdrawalsPaidCount: withdrawPaidAgg[0]?.count ?? 0,
    pendingWithdrawalsCount,
    totalSalaryPaidUsd,
    totalEarningsPaidUsd,
    lastActivities,
  };
}

export async function buildFraudSignals() {
  const hourAgo = new Date(Date.now() - MS_HOUR);
  const weekAgo = new Date(Date.now() - 7 * MS_DAY);

  const rapidWithdrawAgg = await HybridWithdrawal.aggregate([
    {
      $match: {
        createdAt: { $gte: hourAgo },
        status: { $nin: ["rejected"] },
      },
    },
    { $group: { _id: "$userId", count: { $sum: 1 } } },
    { $match: { count: { $gt: 3 } } },
  ]);
  const rapidUserIds = new Set(rapidWithdrawAgg.map((r) => String(r._id)));

  const users = await User.find()
    .select(
      "username email createdAt depositBalance totalInvested totalWithdraw isBlocked adminFraudFlag adminFraudReason"
    )
    .lean();

  const signals = [];

  for (const u of users) {
    const reasons = [];
    let risk = "low";
    const uid = String(u._id);

    if (rapidUserIds.has(uid)) {
      reasons.push("More than 3 withdrawal requests in the last hour");
      risk = "high";
    }

    const depositBase = Math.max(Number(u.depositBalance || 0), Number(u.totalInvested || 0), 1);
    const tw = Number(u.totalWithdraw || 0);
    if (tw > depositBase * 2) {
      reasons.push("Total withdraw is more than 2× active deposit / invested baseline");
      if (risk === "low") risk = "medium";
      if (tw > depositBase * 4) risk = "high";
    }

    const acctAgeMs = u.createdAt ? Date.now() - new Date(u.createdAt).getTime() : MS_DAY * 30;
    if (acctAgeMs < MS_DAY * 7 && tw >= 200) {
      reasons.push("New account (under 7 days) with withdraw total ≥ 200 USDT");
      risk = risk === "low" ? "medium" : "high";
    }

    if (u.adminFraudFlag) {
      reasons.push(`Manually flagged: ${u.adminFraudReason || "no note"}`);
      risk = "high";
    }

    if (reasons.length === 0) continue;

    signals.push({
      userId: u._id,
      username: u.username,
      email: u.email,
      riskLevel: risk,
      reasons,
      isBlocked: !!u.isBlocked,
      adminFraudFlag: !!u.adminFraudFlag,
    });
  }

  signals.sort((a, b) => {
    const rank = { high: 3, medium: 2, low: 1 };
    return (rank[b.riskLevel] || 0) - (rank[a.riskLevel] || 0);
  });

  return signals;
}

export async function salaryPayoutsPage({ page = 1, limit = 25, search = "" }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 50);
  const safePage = Math.max(Number(page) || 1, 1);
  const skip = (safePage - 1) * safeLimit;

  const matchUser =
    String(search || "").trim() === ""
      ? {}
      : {
          $or: [
            { username: new RegExp(String(search).trim(), "i") },
            { email: new RegExp(String(search).trim(), "i") },
          ],
        };

  const [totalInfo, stageDistribution, rows] = await Promise.all([
    User.aggregate([
      { $match: { ...matchUser, salaryHistory: { $exists: true, $ne: [] } } },
      { $unwind: "$salaryHistory" },
      { $count: "total" },
    ]),
    User.aggregate([
      { $match: { salaryHistory: { $exists: true, $ne: [] } } },
      { $unwind: "$salaryHistory" },
      {
        $group: {
          _id: "$salaryHistory.stage",
          count: { $sum: 1 },
          amount: { $sum: "$salaryHistory.amount" },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    User.aggregate([
      { $match: { ...matchUser, salaryHistory: { $exists: true, $ne: [] } } },
      { $unwind: "$salaryHistory" },
      { $sort: { "salaryHistory.claimedAt": -1 } },
      { $skip: skip },
      { $limit: safeLimit },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          username: 1,
          email: 1,
          stage: "$salaryHistory.stage",
          amount: "$salaryHistory.amount",
          claimedAt: "$salaryHistory.claimedAt",
        },
      },
    ]),
  ]);

  const totalRows = totalInfo[0]?.total ?? 0;

  const totalPaid = await User.aggregate([
    { $unwind: { path: "$salaryHistory", preserveNullAndEmptyArrays: false } },
    { $group: { _id: null, sum: { $sum: "$salaryHistory.amount" } } },
  ]);

  return {
    rows,
    totalSalaryPaid: totalPaid[0]?.sum ?? 0,
    stageDistribution: stageDistribution.map((s) => ({
      stage: s._id,
      count: s.count,
      amount: s.amount,
    })),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total: totalRows,
      totalPages: Math.max(1, Math.ceil(totalRows / safeLimit)),
    },
  };
}

export async function logFeed({
  type,
  page = 1,
  limit = 25,
  search = "",
  adminId: filterAdminId = "",
  userId: filterUserId = "",
  actionType: filterActionType = "",
}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 50);
  const safePage = Math.max(Number(page) || 1, 1);
  const skip = (safePage - 1) * safeLimit;
  const q = String(search || "").trim().toLowerCase();

  if (type === "admin") {
    const clauses = [];

    const adminOid = toOid(filterAdminId);
    if (adminOid) clauses.push({ adminId: adminOid });

    const userOid = toOid(filterUserId);
    if (userOid) clauses.push({ targetUserId: userOid });

    const cat = String(filterActionType || "").trim().toLowerCase();
    const allowedCats = ["admin", "withdraw", "deposit", "salary", "user", "fraud"];
    if (cat && allowedCats.includes(cat)) clauses.push({ category: cat });

    if (q) {
      clauses.push({
        $or: [{ action: new RegExp(q, "i") }, { category: new RegExp(q, "i") }],
      });
    }

    const filter =
      clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : { $and: clauses };

    const [items, total] = await Promise.all([
      AdminAuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .populate("targetUserId", "username email")
        .populate("adminId", "username email")
        .lean(),
      AdminAuditLog.countDocuments(filter),
    ]);
    return {
      items: items.map((a) => ({
        id: String(a._id),
        createdAt: a.createdAt,
        at: a.createdAt,
        action: a.action,
        category: a.category,
        adminId: a.adminId?._id ?? a.adminId ?? null,
        userId: a.targetUserId?._id ?? a.targetUserId ?? null,
        userLabel:
          a.targetUserId?.username ||
          a.targetUserId?.email ||
          a.adminId?.username ||
          "—",
        adminLabel: a.adminId?.username || a.adminId?.email || "—",
        meta: a.meta ?? null,
      })),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  if (type === "deposit") {
    const usersColl = User.collection.name;
    const pipeline = [];
    const userOidDeposit = toOid(filterUserId);
    if (userOidDeposit) pipeline.push({ $match: { userId: userOidDeposit } });
    pipeline.push(
      {
        $lookup: {
          from: usersColl,
          localField: "userId",
          foreignField: "_id",
          as: "userId",
        },
      },
      { $unwind: { path: "$userId", preserveNullAndEmptyArrays: true } }
    );
    if (q) {
      pipeline.push({
        $match: {
          $or: [
            { txHash: new RegExp(q, "i") },
            { "userId.username": new RegExp(q, "i") },
            { "userId.email": new RegExp(q, "i") },
          ],
        },
      });
    }
    pipeline.push({ $sort: { createdAt: -1 } });
    const countPipeline = [...pipeline, { $count: "total" }];
    pipeline.push({ $skip: skip }, { $limit: safeLimit });

    const [rows, countArr] = await Promise.all([
      HybridDeposit.aggregate(pipeline),
      HybridDeposit.aggregate(countPipeline),
    ]);
    const total = countArr[0]?.total ?? 0;
    return {
      items: rows.map((d) => ({
        id: String(d._id),
        createdAt: d.createdAt,
        at: d.createdAt,
        action: `Deposit ${d.status}`,
        userId: d.userId?._id ?? d.userId,
        userLabel: d.userId?.username || d.userId?.email || "—",
        amount: d.amount,
        txHash: d.txHash,
        status: d.status,
        meta: { txHash: d.txHash, status: d.status, amount: d.amount },
      })),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  if (type === "withdraw") {
    const usersColl = User.collection.name;
    const pipeline = [];
    const userOidW = toOid(filterUserId);
    if (userOidW) pipeline.push({ $match: { userId: userOidW } });

    pipeline.push(
      {
        $lookup: {
          from: usersColl,
          localField: "userId",
          foreignField: "_id",
          as: "userId",
        },
      },
      { $unwind: { path: "$userId", preserveNullAndEmptyArrays: true } }
    );

    const stFilter = String(filterActionType || "").trim().toLowerCase();
    const allowedW = ["review", "pending", "claimable", "claimed", "approved", "paid", "rejected"];

    const postMatches = [];

    if (q) {
      postMatches.push({
        $or: [
          { txHash: new RegExp(q, "i") },
          { walletAddress: new RegExp(q, "i") },
          { "userId.username": new RegExp(q, "i") },
          { "userId.email": new RegExp(q, "i") },
        ],
      });
    }

    if (stFilter && allowedW.includes(stFilter)) postMatches.push({ status: stFilter });

    if (postMatches.length === 1) pipeline.push({ $match: postMatches[0] });
    else if (postMatches.length > 1) pipeline.push({ $match: { $and: postMatches } });

    pipeline.push({ $sort: { createdAt: -1 } });
    const countPipeline = [...pipeline, { $count: "total" }];
    pipeline.push({ $skip: skip }, { $limit: safeLimit });

    const [rows, countArr] = await Promise.all([
      HybridWithdrawal.aggregate(pipeline),
      HybridWithdrawal.aggregate(countPipeline),
    ]);
    const total = countArr[0]?.total ?? 0;
    return {
      items: rows.map((w) => ({
        id: String(w._id),
        createdAt: w.createdAt,
        at: w.createdAt,
        action: `Withdraw ${w.status}`,
        userId: w.userId?._id ?? w.userId,
        userLabel: w.userId?.username || w.userId?.email || "—",
        amount: w.netAmount,
        status: w.status,
        txHash: w.txHash,
        meta: { status: w.status, netAmount: w.netAmount, txHash: w.txHash },
      })),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  if (type === "salary") {
    const userQuery =
      String(search || "").trim() === ""
        ? {}
        : {
            $or: [
              { username: new RegExp(String(search).trim(), "i") },
              { email: new RegExp(String(search).trim(), "i") },
            ],
          };

    const salaryUserOid = toOid(filterUserId);
    const baseMatch = { ...userQuery, salaryHistory: { $exists: true, $ne: [] } };
    if (salaryUserOid) baseMatch._id = salaryUserOid;

    const pipeline = [
      { $match: baseMatch },
      { $unwind: "$salaryHistory" },
      { $sort: { "salaryHistory.claimedAt": -1 } },
    ];
    const countPipeline = [...pipeline, { $count: "total" }];
    pipeline.push(
      { $skip: skip },
      { $limit: safeLimit },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          at: "$salaryHistory.claimedAt",
          stage: "$salaryHistory.stage",
          amount: "$salaryHistory.amount",
          username: 1,
          email: 1,
        },
      }
    );

    const [rows, countArr] = await Promise.all([
      User.aggregate(pipeline),
      User.aggregate(countPipeline),
    ]);
    const total = countArr[0]?.total ?? 0;
    return {
      items: rows.map((r) => ({
        id: `${r.userId}:${r.at}:${r.stage}`,
        createdAt: r.at,
        at: r.at,
        action: `Salary stage ${r.stage}`,
        userId: r.userId,
        userLabel: r.username || r.email || "—",
        amount: r.amount,
        stage: r.stage,
        meta: { stage: r.stage, amount: r.amount },
      })),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  return { items: [], total: 0, page: safePage, limit: safeLimit };
}

export async function getUserAdminDetail(userId) {
  const id = toOid(userId);
  if (!id) return null;
  const user = await User.findById(id)
    .select("-password -privateKey")
    .lean();
  if (!user) return null;
  const directTeam = await User.find({ referredBy: id })
    .select("username email depositBalance totalInvested totalWithdraw createdAt isBlocked")
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const [depAgg, wdAgg] = await Promise.all([
    HybridDeposit.aggregate([
      { $match: { userId: id, status: { $in: ["credited", "swept"] } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    HybridWithdrawal.aggregate([
      { $match: { userId: id, status: "paid" } },
      { $group: { _id: null, total: { $sum: "$netAmount" } } },
    ]),
  ]);

  const salaryEarned = Array.isArray(user.salaryHistory)
    ? user.salaryHistory.reduce((acc, h) => acc + Number(h?.amount || 0), 0)
    : 0;

  const stats = {
    totalDeposits: Number(depAgg[0]?.total ?? 0),
    totalWithdrawPaid: Number(wdAgg[0]?.total ?? 0),
    salaryEarned,
    referralEarnings: Number(user.referralEarnings || 0),
    fraudFlag: !!user.adminFraudFlag,
    fraudReason: String(user.adminFraudReason || "").trim(),
  };

  return { user, directTeam, directCount: directTeam.length, stats };
}
