export const updateVIP = async (userId) => {
  try {
    console.log("Legacy VIP bonuses disabled; HybridEarn level bonuses are active");
    return { disabled: true, userId };
  } catch (err) {
    console.error("VIP ERROR:", err.message);
    return { disabled: true, error: err.message };
  }
};