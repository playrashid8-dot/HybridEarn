import mongoose from "mongoose";
import logger from "../utils/logger.js";
import {
  isLikelyMongoUri,
  normalizeMongoUri,
} from "./envNormalize.js";

let connectionPromise;
let mongoDisconnectedHookRegistered = false;

const MONGO_CONNECTED_STATES = new Set([
  mongoose.ConnectionStates.connected,
]);

/**
 * Singleton Mongoose bootstrap — caches in-flight connects (Railway replicas + clustered workers share one PID each).
 */
const connectDB = async () => {
  const uri = normalizeMongoUri(process.env.MONGO_URI);
  if (uri) {
    process.env.MONGO_URI = uri;
  }
  if (!uri) {
    logger.error("MONGO_URI missing — exiting");
    process.exit(1);
  }
  if (!isLikelyMongoUri(uri)) {
    logger.error(
      "MONGO_URI must be a mongodb:// or mongodb+srv:// connection string — check Railway variables for stray quotes or whitespace",
      {},
    );
    process.exit(1);
  }

  const ready = mongoose.connection.readyState;
  if (MONGO_CONNECTED_STATES.has(ready)) {
    return mongoose.connection;
  }

  mongoose.set("strictQuery", true);

  const enableAutoIndex =
    String(process.env.MONGODB_AUTO_INDEX || "").toLowerCase() === "true" ||
    (!logger.isMinimalProd && process.env.NODE_ENV !== "production");

  if (!connectionPromise) {
    const selectionMs = Number(process.env.MONGO_SELECTION_TIMEOUT_MS || 8000);
    connectionPromise = mongoose
      .connect(uri, {
        autoIndex: enableAutoIndex,
        serverSelectionTimeoutMS: Number.isFinite(selectionMs)
          ? Math.max(2000, selectionMs)
          : 8000,
      })
      .catch((error) => {
        connectionPromise = null;
        throw error;
      });
  }

  try {
    const conn = await connectionPromise;

    if (!mongoDisconnectedHookRegistered) {
      mongoDisconnectedHookRegistered = true;
      mongoose.connection.on("disconnected", () => {
        connectionPromise = null;
        logger.warn("MongoDB disconnected unexpectedly");
      });
    }

    logger.info(`Mongo connected`, {
      host: conn.connection?.host ?? "mongodb",
      name: conn.connection?.name ?? undefined,
      readyState: conn.connection.readyState,
    });

    return conn;
  } catch (error) {
    logger.error("MongoDB connection failed — exiting", {
      error: error?.message || String(error),
    });
    process.exit(1);
  }
};

export async function pingMongoDeadline(timeoutMs = 7500) {
  if (
    mongoose.connection.readyState !== mongoose.ConnectionStates.connected
  ) {
    return false;
  }
  if (!mongoose.connection.db) {
    return false;
  }

  try {
    const budget = Number.isFinite(timeoutMs) ? Math.max(250, timeoutMs) : 7500;

    /** @returns {Promise<unknown>} */
    const ping = mongoose.connection.db?.command?.({ ping: 1 });
    await Promise.race([
      ping,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("mongo ping deadline")), budget),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function gracefulDisconnectMongo(reason = "") {
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected) {
    return;
  }
  try {
    await mongoose.disconnect();
    connectionPromise = null;
    logger.info("Mongo gracefully disconnected", { reason });
  } catch (err) {
    logger.warn("Mongo disconnect raised", {
      reason,
      error: err?.message || String(err),
    });
  }
}

export default connectDB;
