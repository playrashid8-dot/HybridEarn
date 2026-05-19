/**
 * Canonical string form for wallet + contract compares and Map keys.
 */
export function normalizeEvmAddress(addr) {
  return String(addr ?? "").trim().toLowerCase();
}

/**
 * `Transfer(address,address,uint256)` — indexed `topics[2]` (`to`): 32-byte topic, address in low 20 bytes.
 */
export function normalizeRecipientFromTransferTopic(topic) {
  const raw = String(topic ?? "").trim();
  if (!raw) return "";
  const hexBody = raw.startsWith("0x") ? raw.slice(2) : raw;
  const addrSuffix = hexBody.slice(-40);
  if (!/^[0-9a-fA-F]{40}$/i.test(addrSuffix)) return "";
  return `0x${addrSuffix.toLowerCase()}`;
}
