import { HDNodeWallet } from "ethers";
import hybridConfig from "../../config/hybridConfig.js";
import WalletCounter from "../models/WalletCounter.js";
import { encryptPrivateKey } from "../utils/crypto.js";

export const getNextWalletIndex = async () => {
  try {
    const counter = await WalletCounter.findOneAndUpdate(
      { key: "wallet_index" },
      { $inc: { value: 1 } },
      {
        new: true,
        upsert: true
      }
    );

    if (!counter || typeof counter.value !== "number") {
      throw new Error("Wallet counter failed");
    }

    const walletIndex = Number(counter?.value || 0);

    if (!Number.isInteger(walletIndex) || walletIndex <= 0) {
      throw new Error("Wallet counter reservation failed");
    }

    return walletIndex;
  } catch (error) {
    throw new Error(error.message || "Failed to reserve wallet index");
  }
};

export const generateWallet = (index) => {
  const walletIndex = Number(index);

  if (!Number.isInteger(walletIndex) || walletIndex < 0) {
    throw new Error("Wallet index must be a non-negative integer");
  }

  const wallet = HDNodeWallet.fromPhrase(
    hybridConfig.mnemonic,
    "",
    `m/44'/60'/0'/0/${walletIndex}`
  );

  return {
    address: wallet.address.toLowerCase(),
    privateKey: wallet.privateKey,
  };
};

export const createUserWallet = async () => {
  const index = await getNextWalletIndex();
  const wallet = generateWallet(index);

  return {
    address: wallet.address,
    privateKey: encryptPrivateKey(wallet.privateKey),
  };
};
