/**
 * Canonical storage form for User.walletAddress — matches hybrid matching (topic addresses are lowercase).
 */
export function normalizeStoredWalletAddress(walletAddress) {
  if (walletAddress == null) return "";
  return String(walletAddress).trim().toLowerCase();
}
