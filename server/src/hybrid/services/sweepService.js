import { Contract, Wallet, formatEther, formatUnits, isAddress, parseEther } from "ethers";
import hybridConfig from "../../config/hybridConfig.js";
import User from "../../models/User.js";
import HybridDeposit from "../models/HybridDeposit.js";
import { decryptPrivateKey } from "../utils/crypto.js";
import { BSC_USDT_ABI, HYBRID_TOKEN } from "../utils/constants.js";
import { getProvider, getRpcUrls, withProviderRetry } from "../utils/provider.js";
import logger from "../../utils/logger.js";
import { getReadyRedis, isRedisReady } from "../../config/redis.js";
import crypto from "crypto";

const MAX_SWEEP_BATCH = 10;
const SWEEP_DELAY_MS = 1500;
/** Hard floor before token sweep — must align with ensureMinBnbForSweep top-up target */
const MIN_SAFE_GAS = parseEther("0.00001");
const GAS_TOPUP_BUFFER = parseEther("0.00001");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let gasFunderLocalBusy = false;

/** In-process cache for hot sweep loops (per user wallet). */
const sweepBalCache = new Map();
const SWEEP_BAL_TTL_MS = Math.min(
  120_000,
  Math.max(1500, Number(process.env.HYBRID_SWEEP_BALANCE_CACHE_MS || 12_000)),
);

async function withUserSweepLock(userWalletLower, fn) {
  const w = String(userWalletLower || "")
    .trim()
    .toLowerCase();
  if (!w.startsWith("0x")) {
    return fn();
  }
  const redis = getReadyRedis();
  const key = `hybrid:sweep_user_lock:${w}`;
  const token = crypto.randomBytes(12).toString("hex");
  if (redis && isRedisReady(redis)) {
    let locked = false;
    try {
      locked = (await redis.set(key, token, "PX", 180_000, "NX")) === "OK";
    } catch {
      locked = false;
    }
    if (!locked) {
      logger.throttledWarn(
        "sweep_user_busy",
        "Sweep skipped — wallet serialization lock busy",
        { walletPreview: `${w.slice(0, 10)}…` },
        60_000,
      );
      return { skipped: true, reason: "sweep_wallet_busy" };
    }
    try {
      return await fn();
    } finally {
      const script =
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
      await redis.eval(script, 1, key, token).catch(() => {});
    }
  }
  return fn();
}

async function withGasFunderLock(fn) {
  const redis = getReadyRedis();
  const key = "hybrid:sweep_gas_funder_lock";
  const token = crypto.randomBytes(12).toString("hex");

  if (redis && isRedisReady(redis)) {
    const locked = (await redis.set(key, token, "PX", 180_000, "NX").catch(() => null)) === "OK";
    if (!locked) {
      logger.throttledWarn(
        "sweep_gas_funder_busy",
        "Sweep gas top-up skipped — gas funder serialization lock busy",
        {},
        30_000,
      );
      throw new Error("Gas funder lock busy");
    }
    try {
      return await fn();
    } finally {
      const script =
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
      await redis.eval(script, 1, key, token).catch(() => {});
    }
  }

  if (gasFunderLocalBusy) {
    throw new Error("Gas funder local lock busy");
  }
  gasFunderLocalBusy = true;
  try {
    return await fn();
  } finally {
    gasFunderLocalBusy = false;
  }
}

async function readCachedBalances(provider, tokenContract, walletAddr) {
  const key = String(walletAddr || "")
    .trim()
    .toLowerCase();
  const now = Date.now();
  const hit = sweepBalCache.get(key);
  if (hit && now - hit.atMs < SWEEP_BAL_TTL_MS) {
    return { nativeWei: hit.nativeWei, tokenWei: hit.tokenWei };
  }
  const nativeWei = await withProviderRetry((p) => p.getBalance(walletAddr), null, {
    purpose: "hybrid_sweep_wallet_native_balance",
  });
  const tokenWei = await withProviderRetry(async (p) => {
    const erc =
      typeof tokenContract.connect === "function" ? tokenContract.connect(p) : tokenContract;
    return BigInt((await erc.balanceOf(walletAddr)).toString());
  }, null, {
    purpose: "hybrid_sweep_wallet_token_balance",
  });
  sweepBalCache.set(key, { atMs: now, nativeWei, tokenWei });
  return { nativeWei, tokenWei };
}

const assertSweepConfig = () => {
  if (!hybridConfig.gasKey) {
    throw new Error("HYBRID_GAS_FUNDER_PRIVATE_KEY missing");
  }

  if (!hybridConfig.usdtContract) {
    throw new Error("HYBRID_USDT_CONTRACT missing");
  }
};

export const canSweepHybridFunds = () =>
  hybridConfig.earnEnabled &&
  hybridConfig.sweepEnabled &&
  !!hybridConfig.adminWallet &&
  !!hybridConfig.usdtContract &&
  !!hybridConfig.gasKey &&
  getRpcUrls().length > 0;

const clampBatchSize = (n) => {
  const raw = Number(n);
  if (!Number.isFinite(raw)) return 5;
  return Math.min(MAX_SWEEP_BATCH, Math.max(1, Math.floor(raw)));
};

export const getSweepBatchSize = () =>
  clampBatchSize(process.env.HYBRID_SWEEP_BATCH_SIZE ?? 5);

/**
 * Legacy helper — sends a fixed dust amount (used only if you call it explicitly).
 */
export const sendGas = async (address) => {
  try {
    assertSweepConfig();

    if (!isAddress(address)) {
      throw new Error("Valid recipient address is required");
    }

    const gasFunder = new Wallet(hybridConfig.gasKey, getProvider());
    const gasAmount = process.env.HYBRID_SWEEP_GAS_AMOUNT || "0.00001";
    const gasTx = await gasFunder.sendTransaction({
      to: address,
      value: parseEther(gasAmount),
    });

    const receipt = await gasTx.wait();

    return {
      txHash: String(receipt?.hash || gasTx.hash || "").toLowerCase(),
    };
  } catch (error) {
    logger.error("Hybrid sweep legacy gas sender failed", { error: error?.message || String(error) });
    throw new Error(`Failed to send sweep gas: ${error.message}`);
  }
};

export const ensureMinBnbForSweep = async (address) => {
  assertSweepConfig();

  if (!isAddress(address)) {
    throw new Error("Valid recipient address is required");
  }

  const checksumAddr = address;
  const balance = await withProviderRetry((p) => p.getBalance(checksumAddr), null, {
    purpose: "hybrid_sweep_prefund_recipient_balance",
  });

  logger.debug?.("Sweep user wallet native balance check", {
    walletPreview: `${String(checksumAddr).slice(0, 10)}…`,
    balanceBnb: formatEther(balance),
    minBnbRequired: formatEther(MIN_SAFE_GAS),
  });

  if (balance >= MIN_SAFE_GAS) {
    return { toppedUp: false };
  }

  const gasFunder = new Wallet(hybridConfig.gasKey, getProvider());
  const shortfall = MIN_SAFE_GAS - balance + GAS_TOPUP_BUFFER;
  const funderBal = await withProviderRetry((p) => p.getBalance(gasFunder.address), null, {
    purpose: "hybrid_sweep_prefund_funder_balance",
  });
  logger.debug?.("Sweep gas funder native balance snapshot", {
    balanceBnb: formatEther(funderBal),
    shortfallBnb: formatEther(shortfall),
  });
  if (funderBal < shortfall) {
    logger.throttledWarn(
      `hybrid_sweep_funder_${String(gasFunder.address || "").slice(2, 10)}`,
      "Hybrid sweep gas funder insufficient for deterministic top-up slice",
      {
        neededApproxBnb: formatEther(shortfall),
        availableBnb: formatEther(funderBal),
      },
      240_000,
    );
  }
  const receipt = await withGasFunderLock(async () => {
    const freshBalance = await withProviderRetry((p) => p.getBalance(checksumAddr), null, {
      purpose: "hybrid_sweep_prefund_recipient_fresh_balance",
    });
    if (freshBalance >= MIN_SAFE_GAS) {
      return { skippedAfterLock: true, hash: "" };
    }
    const freshShortfall = MIN_SAFE_GAS - freshBalance + GAS_TOPUP_BUFFER;
    const tx = await gasFunder.sendTransaction({ to: checksumAddr, value: freshShortfall });
    return tx.wait();
  });

  if (receipt?.skippedAfterLock === true) {
    return { toppedUp: false, reason: "already_funded" };
  }

  if (!receipt || receipt.status !== 1) {
    logger.error("Hybrid sweep gas top-up transaction failed post-wait receipt", {});
    throw new Error("Gas top-up transaction failed");
  }

  const after = await withProviderRetry((p) => p.getBalance(checksumAddr), null, {
    purpose: "hybrid_sweep_prefund_recipient_after_balance",
  });
  logger.debug?.("Sweep recipient native post gas top-up", { balanceBnb: formatEther(after) });
  if (after < MIN_SAFE_GAS) {
    logger.error("Hybrid sweep gas top-up insufficient after receipt", {
      balanceBnb: formatEther(after),
      minRequired: formatEther(MIN_SAFE_GAS),
    });
    throw new Error("BNB still below minimum after top-up");
  }

  return { toppedUp: true, txHash: String(receipt.hash || "").toLowerCase() };
};

async function executeSweepForDeposit(depositStub) {
  const dep = await HybridDeposit.findById(depositStub._id);

  if (!dep || dep.status !== "credited" || dep.sweeped === true) {
    return { skipped: true, reason: "Not eligible for sweep" };
  }

  const user = await User.findById(dep.userId).select("+privateKey walletAddress");

  if (!user?.privateKey || !user?.walletAddress) {
    await HybridDeposit.findByIdAndUpdate(dep._id, {
      $set: { errorMessage: "User wallet credentials missing" },
    });
    throw new Error("User wallet credentials missing");
  }

  const userWalletLower = String(user.walletAddress).trim().toLowerCase();
  const depositWalletLower = String(dep.walletAddress).trim().toLowerCase();

  if (userWalletLower !== depositWalletLower) {
    await HybridDeposit.findByIdAndUpdate(dep._id, {
      $set: { errorMessage: "Wallet mismatch" },
    });
    throw new Error("User wallet does not match deposit wallet");
  }

  return withUserSweepLock(userWalletLower, async () => {
    const depFresh = await HybridDeposit.findById(dep._id);
    if (!depFresh || depFresh.status !== "credited" || depFresh.sweeped === true) {
      return { skipped: true, reason: "Not eligible for sweep" };
    }

    const provider = getProvider();
    const decrypted = decryptPrivateKey(user.privateKey);
    const signer = new Wallet(decrypted, provider);

    if (String(signer.address).toLowerCase() !== userWalletLower) {
      throw new Error("Derived wallet does not match stored address");
    }

    const tokenContract = new Contract(hybridConfig.usdtContract, BSC_USDT_ABI, signer);

    try {
      await ensureMinBnbForSweep(user.walletAddress);
    } catch (err) {
      logger.warn("Hybrid sweep unable to prefund swap gas window", {
        depositId: String(dep._id),
        reason: err?.message || String(err),
      });
      throw err;
    }

    const { nativeWei, tokenWei } = await readCachedBalances(
      provider,
      tokenContract,
      user.walletAddress,
    );

    if (nativeWei < MIN_SAFE_GAS) {
      logger.error("Hybrid sweep blocked — signer native below deterministic floor post top-up probe", {
        depositId: String(dep._id),
      });
      throw new Error("Critical: BNB too low for safe transaction");
    }

    const currentBalance = tokenWei;

    if (currentBalance <= 0n) {
      return { skipped: true, reason: "No USDT balance to sweep" };
    }

    logger.info("Hybrid sweep token transfer initiating", {
      depositId: String(dep._id),
      amountApprox: `${formatUnits(currentBalance, HYBRID_TOKEN.decimals)} ${HYBRID_TOKEN.symbol}`,
    });
    const sweepTx = await tokenContract.transfer(hybridConfig.adminWallet, currentBalance);
    const receipt = await sweepTx.wait();

    if (!receipt || receipt.status !== 1) {
      logger.error("Hybrid sweep token transfer mined with revert or missing receipt", {
        depositId: String(dep._id),
      });
      throw new Error("Sweep transaction reverted or missing receipt");
    }

    const sweepTxHash = String(receipt.hash || sweepTx.hash || "").toLowerCase();
    logger.info("Hybrid sweep token transfer confirmed", {
      depositId: String(dep._id),
      sweepTxHash,
    });

    const updated = await HybridDeposit.findOneAndUpdate(
      {
        _id: dep._id,
        status: "credited",
        sweeped: { $ne: true },
      },
      {
        $set: {
          status: "swept",
          sweeped: true,
          sweepTxHash,
          errorMessage: "",
        },
      },
      { new: true },
    );

    if (!updated) {
      const current = await HybridDeposit.findById(dep._id).lean();
      if (
        current?.status === "swept" &&
        (current.sweepTxHash === sweepTxHash || !current.sweepTxHash)
      ) {
        return { skipped: false, sweepTxHash, deduped: true };
      }
      throw new Error("Could not record sweep (state changed)");
    }

    return { skipped: false, sweepTxHash };
  });
}

/**
 * Safe batch sweep: small batches, delay between txs, no batch size above 10.
 */
export const runHybridSweepBatch = async () => {
  if (!canSweepHybridFunds()) {
    return { ran: false, reason: "Sweep disabled or misconfigured", results: [] };
  }

  try {
    const gf = new Wallet(hybridConfig.gasKey, getProvider());
    const fb = await withProviderRetry((p) => p.getBalance(gf.address), null, {
      purpose: "hybrid_sweep_batch_funder_balance",
    });
    logger.debug?.("Hybrid sweep batch gas funder telemetry", {
      funder: gf.address,
      balanceBnb: formatEther(fb),
    });
    if (fb < parseEther("0.001")) {
      logger.error("Hybrid sweep gas funder BNB materially below recommended buffer", {
        balanceBnb: formatEther(fb),
      });
    }
  } catch (e) {
    logger.error("Hybrid sweep gas funder probe failed", {
      error: e?.message || String(e),
    });
  }

  await HybridDeposit.updateMany(
    { status: "swept", sweeped: { $ne: true } },
    { $set: { sweeped: true } }
  ).catch(() => {});

  const limit = getSweepBatchSize();
  const deposits = await HybridDeposit.find({
    status: "credited",
    sweeped: { $ne: true },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  const results = [];
  let failStreak = 0;

  for (let i = 0; i < deposits.length; i += 1) {
    const d = deposits[i];
    if (d.sweeped) continue;

    try {
      const r = await executeSweepForDeposit(d);
      results.push({ depositId: String(d._id), ...r });
      if (r?.sweepTxHash && !r?.error) {
        failStreak = 0;
      } else if (r?.skipped === true) {
        /* benign skip — no backoff escalation */
      } else {
        failStreak += 1;
      }
    } catch (err) {
      failStreak += 1;
      logger.warn("Hybrid sweep deposit iteration failed", {
        depositId: String(d._id),
        error: err?.message || String(err),
      });
      await HybridDeposit.findByIdAndUpdate(d._id, {
        $set: { errorMessage: String(err.message || "Sweep failed").slice(0, 300) },
      }).catch(() => {});
      results.push({ depositId: String(d._id), error: err.message });
    }

    if (i < deposits.length - 1) {
      const backoffFactor = Math.min(6, failStreak);
      await sleep(SWEEP_DELAY_MS * (1 + backoffFactor));
    }
  }

  const succeeded = results.filter((r) => r.sweepTxHash && !r.error).length;

  return { ran: true, attempted: deposits.length, succeeded, results };
};

/** Single deposit (manual / tests) — same safety checks as batch. */
export const sweepHybridDeposit = async (depositId) => {
  if (!canSweepHybridFunds()) {
    return { skipped: true, reason: "Hybrid sweep disabled" };
  }
  return executeSweepForDeposit({ _id: depositId });
};
