import HybridLedger from "../models/HybridLedger.js";

export const addHybridLedgerEntries = async (entries, session = null) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  try {
    return HybridLedger.insertMany(entries, {
      ordered: true,
      ...(session ? { session } : {}),
    });
  } catch (error) {
    // Preserve Mongo error shape (e.g. code 11000) so transaction sessions abort and retry logic can run.
    if (typeof error?.code === "number" || error?.name === "MongoServerError") {
      throw error;
    }
    throw new Error(error.message || "Failed to write ledger entries");
  }
};
