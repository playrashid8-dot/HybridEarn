import { STATUS } from "./constants";

// 💰 FORMAT USD
export const formatUSD = (num) => {
  const n = Number(num || 0);
  return `$${n.toFixed(2)}`;
};

// 💎 FORMAT USDT
export const formatUSDT = (num) => {
  const n = Number(num || 0);
  return `${n.toFixed(2)} USDT`;
};

// 🔢 SHORT NUMBER (25K+, 2.4M)
export const shortNumber = (num) => {
  const n = Number(num || 0);

  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M+";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K+";

  return n.toString();
};

// 📅 FORMAT DATE (SAFE)
export const formatDate = (date) => {
  if (!date) return "-";

  try {
    return new Date(date).toLocaleString();
  } catch {
    return "-";
  }
};

// 📆 SIMPLE DATE (DD MMM)
export const formatShortDate = (date) => {
  if (!date) return "-";

  try {
    return new Date(date).toLocaleDateString("en-US", {
      day: "2-digit",
      month: "short",
    });
  } catch {
    return "-";
  }
};

// ⏳ TIME AGO (IMPROVED)
export const timeAgo = (date) => {
  if (!date) return "-";

  const seconds = Math.floor((Date.now() - new Date(date)) / 1000);

  if (isNaN(seconds)) return "-";

  const intervals = {
    year: 31536000,
    month: 2592000,
    day: 86400,
    hour: 3600,
    minute: 60,
  };

  for (let key in intervals) {
    const value = Math.floor(seconds / intervals[key]);
    if (value > 0) {
      return `${value} ${key}${value > 1 ? "s" : ""} ago`;
    }
  }

  return "Just now";
};

// 🔐 MASK WALLET (SAFE)
export const maskAddress = (addr) => {
  if (!addr || addr.length < 10) return addr || "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
};

// 🔗 COPY TO CLIPBOARD (WITH FEEDBACK)
export const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

// 📊 CALCULATE ROI TOTAL
export const calculateROI = (amount, dailyROI, days) => {
  const a = Number(amount || 0);
  const r = Number(dailyROI || 0);
  const d = Number(days || 0);

  return (a * r * d) / 100;
};

// 💹 FINAL AMOUNT AFTER ROI
export const finalAmount = (amount, dailyROI, days) => {
  return Number(amount || 0) + calculateROI(amount, dailyROI, days);
};

// 🎯 VALIDATE NUMBER INPUT
export const isValidNumber = (value) => {
  const n = Number(value);
  return !isNaN(n) && n > 0;
};

// 🧠 SAFE PARSE FLOAT
export const toNumber = (val) => {
  const n = Number(val);
  return isNaN(n) ? 0 : n;
};

// 🎨 STATUS COLOR (IMPROVED)
export const getStatusColor = (status) => {
  const s = status?.toLowerCase();

  switch (s) {
    case "success":
    case "approved":
      return "text-green-400";

    case STATUS.PENDING:
      return "text-yellow-400";

    case STATUS.FAILED:
    case "rejected":
      return "text-red-400";

    default:
      return "text-gray-400";
  }
};

/** BEP20 / EVM address: 0x + 40 hex (42 chars total). */
export const isValidEvmAddress42 = (addr) => {
  const s = String(addr || "").trim();
  if (!s.startsWith("0x") || s.length !== 42) return false;
  return /^0x[a-fA-F0-9]{40}$/.test(s);
};

/** Withdrawal / generic tx status → Tailwind classes (visual clarity). */
export const withdrawalStatusClass = (status) => {
  const s = String(status || "").toLowerCase();
  switch (s) {
    case STATUS.PENDING:
    case "claimable":
      return "text-yellow-300";
    case "approved":
    case "paid":
    case "claimed":
    case STATUS.CONFIRMED:
      return "text-emerald-300";
    case STATUS.FAILED:
    case "rejected":
      return "text-red-400";
    default:
      return "text-gray-400";
  }
};

/** Deposit chain + credit status → Tailwind classes */
export const depositRowStatusClass = (deposit) => {
  const chain = String(deposit?.confirmationStatus || "").toLowerCase();
  if (chain === STATUS.CONFIRMED) return "text-emerald-300";
  if (chain === "confirming") return "text-yellow-300";
  const st = String(deposit?.status || "").toLowerCase();
  if (st === STATUS.FAILED) return "text-red-400";
  return "text-gray-400";
};