/**
 * Delegates to server implementation (Node resolves deps from server/node_modules).
 * Run: node scripts/backfillWithdrawRisk.js
 */
const { spawnSync } = require("child_process");
const path = require("path");

const serverRoot = path.join(__dirname, "..", "server");
const scriptPath = path.join(serverRoot, "scripts", "backfillWithdrawRisk.js");

const r = spawnSync(process.execPath, [scriptPath], {
  cwd: serverRoot,
  stdio: "inherit",
});

process.exit(typeof r.status === "number" ? r.status : 1);
