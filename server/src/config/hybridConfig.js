import "./loadEnv.js";

const readEnv = (key, fallback = "") => String(process.env[key] ?? fallback).trim();

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return String(value).toLowerCase() === "true";
};

const criticalFields = {
  HYBRID_ADMIN_WALLET: readEnv("HYBRID_ADMIN_WALLET"),
  HYBRID_MNEMONIC: readEnv("HYBRID_MNEMONIC"),
  HYBRID_PRIVATE_KEY_ENCRYPTION_SECRET: readEnv("HYBRID_PRIVATE_KEY_ENCRYPTION_SECRET"),
};

const rpcUrlPrimary =
  readEnv("HYBRID_BSC_RPC_URL") || readEnv("BSC_RPC_URL");

const optionalFields = {
  HYBRID_GAS_FUNDER_PRIVATE_KEY: readEnv("HYBRID_GAS_FUNDER_PRIVATE_KEY"),
  HYBRID_BSC_RPC_URL: rpcUrlPrimary,
  HYBRID_USDT_CONTRACT: readEnv("HYBRID_USDT_CONTRACT"),
};

const missingCritical = Object.entries(criticalFields)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingCritical.length > 0) {
  throw new Error(`Missing critical HybridEarn environment variables: ${missingCritical.join(", ")}`);
}

const missingOptional = Object.entries(optionalFields)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingOptional.length > 0) {
  console.warn(`HybridEarn optional environment variables missing: ${missingOptional.join(", ")}`);
}

export const hybridConfig = {
  adminWallet: criticalFields.HYBRID_ADMIN_WALLET,
  gasKey: optionalFields.HYBRID_GAS_FUNDER_PRIVATE_KEY,
  mnemonic: criticalFields.HYBRID_MNEMONIC,
  rpcUrl: rpcUrlPrimary,
  usdtContract: optionalFields.HYBRID_USDT_CONTRACT,
  encryptionSecret: criticalFields.HYBRID_PRIVATE_KEY_ENCRYPTION_SECRET,
  earnEnabled: parseBoolean(process.env.HYBRID_EARN_ENABLED, true),
  sweepEnabled: parseBoolean(process.env.HYBRID_SWEEP_ENABLED, true),
};

export default hybridConfig;
