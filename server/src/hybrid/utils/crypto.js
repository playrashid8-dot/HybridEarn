import crypto from "crypto";
import hybridConfig from "../../config/hybridConfig.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

const getKey = () =>
  crypto
    .createHash("sha256")
    .update(hybridConfig.encryptionSecret)
    .digest();

export const encryptPrivateKey = (text = "") => {
  if (!text) {
    throw new Error("Private key is required for encryption");
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(text), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
};

export const decryptPrivateKey = (hash = "") => {
  if (!hash) {
    throw new Error("Encrypted private key is required");
  }

  const [ivHex, authTagHex, encryptedHex] = String(hash).split(":");

  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Invalid encrypted private key payload");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
};

export const encryptText = encryptPrivateKey;
export const decryptText = decryptPrivateKey;
