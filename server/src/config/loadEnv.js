/**
 * Central dotenv bootstrap for server/, worker, and hybrid entrypoints.
 * - Never overrides vars already set in the environment (Railway, Docker, CI).
 * - Loads .env.local over .env for local development when present.
 * - Skips .env.production on Railway to avoid shadowing platform-injected secrets.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normalizeProcessEnvConnectivity } from "./envNormalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..", "..");

let loadEnvRan = false;

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function loadEnv({ force = false } = {}) {
  if (loadEnvRan && !force) {
    normalizeProcessEnvConnectivity();
    return;
  }
  loadEnvRan = true;

  const onRailway = Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID,
  );

  const envPath = path.join(serverRoot, ".env");
  if (exists(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }

  const localPath = path.join(serverRoot, ".env.local");
  if (exists(localPath)) {
    dotenv.config({ path: localPath, override: true });
  }

  const nodeEnv = String(process.env.NODE_ENV || "development");
  if (!onRailway && nodeEnv === "production") {
    const prodPath = path.join(serverRoot, ".env.production");
    if (exists(prodPath)) {
      dotenv.config({ path: prodPath, override: false });
    }
  }

  normalizeProcessEnvConnectivity();
}

loadEnv();

export default loadEnv;
