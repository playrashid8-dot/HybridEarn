import mongoose from "mongoose";
import logger from "../utils/logger.js";

const TXN_OPTIONS = {
  readPreference: "primary",
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
};

const TXN_CAPABLE_TOPOLOGIES = new Set([
  "ReplicaSetWithPrimary",
  "ReplicaSetNoPrimary",
  "Sharded",
  "LoadBalanced",
]);

const DIRECT_EXECUTION_PATH = Object.freeze({
  TRANSACTION: "transaction",
  DEGRADED_DIRECT: "degraded-direct",
  UNKNOWN: "unknown",
});

const maskHost = (value) => String(value || "").replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:***@");
const allowNonReplicaMongo = () => String(process.env.ALLOW_NON_REPLICA_MONGO || "").toLowerCase() === "true";
const isTransactionCapableTopology = (topology) => TXN_CAPABLE_TOPOLOGIES.has(topology?.topologyType);
const isStandaloneTopology = (topology) => topology?.topologyType === "Single";

function getDirectExecutionPath(transactionsSupported, degradedStandaloneMode) {
  if (transactionsSupported) return DIRECT_EXECUTION_PATH.TRANSACTION;
  if (degradedStandaloneMode) return DIRECT_EXECUTION_PATH.DEGRADED_DIRECT;
  return DIRECT_EXECUTION_PATH.UNKNOWN;
}

export function getMongoTopologyDiagnostics() {
  const client = mongoose.connection.getClient?.();
  const description = client?.topology?.description;
  const servers = description?.servers
    ? [...description.servers.values()].map((server) => ({
        address: server.address,
        type: server.type,
        setName: server.setName,
      }))
    : [];

  return {
    readyState: mongoose.connection.readyState,
    topologyType: description?.type || "unknown",
    setName: description?.setName || servers.find((server) => server.setName)?.setName || null,
    servers,
  };
}

function getSessionId(session) {
  const id = session?.id?.id;
  if (!id) return "unknown";
  if (Buffer.isBuffer(id)) return id.toString("hex");
  if (id?.buffer && Buffer.isBuffer(id.buffer)) return id.buffer.toString("hex");
  return String(id);
}

function getErrorLabels(error) {
  const labels = error?.errorLabels;
  if (labels instanceof Set) return [...labels];
  if (Array.isArray(labels)) return labels;
  return [];
}

function getCallerContext() {
  const stackLines = new Error().stack?.split("\n").slice(2) || [];
  const callerLine = stackLines.find((line) => !line.includes("mongoTransactions.js"));
  const match = callerLine?.match(/\s*at\s+(?:(.*?)\s+\()?(.+?):\d+:\d+\)?$/);

  return {
    functionName: match?.[1] || "unknown",
    file: match?.[2] || "unknown",
    stackTrace: stackLines.join("\n"),
  };
}

function parseMongoUriOptions(rawUri) {
  try {
    const url = new URL(String(rawUri || ""));
    const params = url.searchParams;
    return {
      isSrv: url.protocol === "mongodb+srv:",
      replicaSet: params.get("replicaSet"),
      retryWrites: params.get("retryWrites"),
      writeConcern: params.get("w") || params.get("writeConcern"),
      directConnection: params.get("directConnection"),
      maskedUri: maskHost(String(rawUri || "")),
    };
  } catch {
    return {
      isSrv: false,
      replicaSet: null,
      retryWrites: null,
      writeConcern: null,
      directConnection: null,
      maskedUri: "invalid",
    };
  }
}

export async function assertMongoTransactionSupport() {
  const topology = getMongoTopologyDiagnostics();
  const uriOptions = parseMongoUriOptions(process.env.MONGO_URI);
  let hello = null;

  try {
    hello = await mongoose.connection.db.command({ hello: 1 });
  } catch (error) {
    logger.error("CRITICAL Mongo topology validation failed during hello probe", {
      error: error?.message || String(error),
      topology,
    });
    throw error;
  }

  const helloTxnCapable = Boolean(hello?.setName || hello?.msg === "isdbgrid" || hello?.serviceId);
  const topologyTxnCapable = TXN_CAPABLE_TOPOLOGIES.has(topology.topologyType);
  const retryWritesOk = String(uriOptions.retryWrites || "").toLowerCase() === "true";
  const writeConcernOk = String(uriOptions.writeConcern || "").toLowerCase() === "majority";
  const directConnectionBad = String(uriOptions.directConnection || "").toLowerCase() === "true";
  const replicaSetParamOk = uriOptions.isSrv || Boolean(uriOptions.replicaSet);

  const failures = [];
  if (!helloTxnCapable || !topologyTxnCapable) {
    failures.push("Mongo is not replica-set/sharded/load-balanced transaction capable");
  }
  if (!retryWritesOk) failures.push("MONGO_URI must include retryWrites=true");
  if (!writeConcernOk) failures.push("MONGO_URI must include w=majority");
  if (!replicaSetParamOk) failures.push("non-SRV MONGO_URI must include replicaSet=<name>");
  if (directConnectionBad) failures.push("MONGO_URI directConnection=true disables replica-set discovery");

  if (failures.length > 0) {
    const validationDetails = {
      failures,
      topology,
      hello: {
        setName: hello?.setName || null,
        msg: hello?.msg || null,
        isWritablePrimary: hello?.isWritablePrimary ?? hello?.ismaster ?? null,
      },
      uri: {
        isSrv: uriOptions.isSrv,
        replicaSet: uriOptions.replicaSet || null,
        retryWrites: uriOptions.retryWrites || null,
        writeConcern: uriOptions.writeConcern || null,
        directConnection: uriOptions.directConnection || null,
        maskedUri: uriOptions.maskedUri,
      },
    };

    if (!allowNonReplicaMongo()) {
      logger.error("CRITICAL Mongo transaction topology invalid — refusing financial startup", validationDetails);
      throw new Error(`Mongo transaction topology invalid: ${failures.join("; ")}`);
    }

    logger.error("CRITICAL Mongo transaction topology invalid — ALLOW_NON_REPLICA_MONGO=true permits startup", validationDetails);
    logger.warn("Running in degraded Mongo standalone mode", {
      topology,
      transactionsSupported: false,
      financialSafety: "Mongo multi-document transactions are unsafe/unavailable on standalone topology",
    });
    logger.warn("Operator action required: migrate MongoDB to Atlas replica set and remove ALLOW_NON_REPLICA_MONGO", {
      requiredTopology: "ReplicaSetWithPrimary",
      currentTopology: topology.topologyType,
      temporaryRecoveryMode: true,
    });
    return;
  }

  logger.info("Mongo transaction topology validated", {
    topology,
    setName: hello?.setName || topology.setName || null,
    retryWrites: uriOptions.retryWrites,
    writeConcern: uriOptions.writeConcern,
  });
}

export async function runMongoTransaction(label, work, options = {}) {
  const txnLabel = String(label || "mongo_transaction");
  const topology = getMongoTopologyDiagnostics();
  const transactionsSupported = isTransactionCapableTopology(topology);
  const degradedStandaloneMode = !transactionsSupported && isStandaloneTopology(topology) && allowNonReplicaMongo();
  const directExecutionPath = getDirectExecutionPath(transactionsSupported, degradedStandaloneMode);
  const callerContext = getCallerContext();
  let session = null;
  let sessionId = degradedStandaloneMode ? "degraded-no-session" : "not-started";

  logger.debug?.("Mongo transaction runtime diagnostic before transaction API", {
    txnLabel,
    file: callerContext.file,
    function: callerContext.functionName,
    stackTrace: callerContext.stackTrace,
    topology,
    topologyType: topology.topologyType,
    setName: topology.setName,
    transactionApi: transactionsSupported ? "mongoose.startSession" : "none",
    directExecutionPath,
    degradedMode: degradedStandaloneMode,
  });

  if (transactionsSupported) {
    session = await mongoose.startSession();
    sessionId = getSessionId(session);
  }

  logger.debug?.("Mongo transaction begin", {
    txnLabel,
    sessionId,
    file: callerContext.file,
    function: callerContext.functionName,
    stackTrace: callerContext.stackTrace,
    topologyType: topology.topologyType,
    setName: topology.setName,
    wrapperPath: "runMongoTransaction",
    directExecutionPath,
    degradedMode: degradedStandaloneMode,
  });

  try {
    let result;

    if (transactionsSupported) {
      logger.debug?.("Mongo transaction wrapper path used", {
        txnLabel,
        file: callerContext.file,
        function: callerContext.functionName,
        stackTrace: callerContext.stackTrace,
        topologyType: topology.topologyType,
        degradedMode: false,
        wrapperPath: "session.withTransaction",
        directExecutionPath,
      });
      logger.debug?.("Mongo transaction runtime diagnostic before transaction API", {
        txnLabel,
        sessionId,
        file: callerContext.file,
        function: callerContext.functionName,
        stackTrace: callerContext.stackTrace,
        topology,
        topologyType: topology.topologyType,
        setName: topology.setName,
        transactionApi: "session.withTransaction",
        directExecutionPath,
        degradedMode: false,
      });
      await session.withTransaction(async () => {
        result = await work(session);
      }, { ...TXN_OPTIONS, ...options });
    } else if (degradedStandaloneMode) {
      logger.warn("Mongo degraded standalone execution active", {
        txnLabel,
        file: callerContext.file,
        function: callerContext.functionName,
        stackTrace: callerContext.stackTrace,
        topologyType: topology.topologyType,
        degradedMode: true,
        directExecutionPath,
      });
      logger.warn("Mongo transaction APIs skipped for degraded standalone execution", {
        txnLabel,
        file: callerContext.file,
        function: callerContext.functionName,
        stackTrace: callerContext.stackTrace,
        topologyType: topology.topologyType,
        degradedMode: true,
        directExecutionPath,
        skippedTransactionApis: [
          "mongoose.startSession",
          "session.startTransaction",
          "session.withTransaction",
          "session.commitTransaction",
          "session.abortTransaction",
        ],
      });
      logger.warn("Executing financial operation WITHOUT Mongo transaction", {
        txnLabel,
        file: callerContext.file,
        function: callerContext.functionName,
        stackTrace: callerContext.stackTrace,
        topologyType: topology.topologyType,
        degradedMode: true,
        wrapperPath: "runMongoTransaction",
        directExecutionPath,
      });
      result = await work(null);
    } else {
      logger.error("Mongo transaction topology unavailable at runtime", {
        txnLabel,
        sessionId,
        file: callerContext.file,
        function: callerContext.functionName,
        topologyType: topology.topologyType,
        allowNonReplicaMongo: allowNonReplicaMongo(),
        directExecutionPath,
      });
      throw new Error(`Mongo transaction topology unavailable at runtime: ${topology.topologyType}`);
    }

    logger.debug?.("Mongo transaction commit", {
      txnLabel,
      sessionId,
      file: callerContext.file,
      function: callerContext.functionName,
      stackTrace: callerContext.stackTrace,
      topologyType: topology.topologyType,
      degradedMode: degradedStandaloneMode,
      wrapperPath: degradedStandaloneMode ? "runMongoTransaction:work(null)" : "runMongoTransaction:session.withTransaction",
      directExecutionPath,
    });
    return result;
  } catch (error) {
    logger.error("Mongo transaction abort", {
      txnLabel,
      sessionId,
      file: callerContext.file,
      function: callerContext.functionName,
      stackTrace: callerContext.stackTrace,
      topologyType: topology.topologyType,
      degradedMode: degradedStandaloneMode,
      reason: error?.message || String(error),
      code: error?.code ?? null,
      labels: getErrorLabels(error),
      directExecutionPath,
    });
    if (degradedStandaloneMode) {
      logger.warn("Mongo abortTransaction skipped for degraded standalone execution", {
        txnLabel,
        file: callerContext.file,
        function: callerContext.functionName,
        stackTrace: callerContext.stackTrace,
        topologyType: topology.topologyType,
        degradedMode: true,
        skippedTransactionApi: "session.abortTransaction",
        directExecutionPath,
      });
    } else if (transactionsSupported && session) {
      logger.debug?.("Mongo transaction runtime diagnostic before transaction API", {
        txnLabel,
        sessionId,
        file: callerContext.file,
        function: callerContext.functionName,
        stackTrace: callerContext.stackTrace,
        topology,
        topologyType: topology.topologyType,
        setName: topology.setName,
        transactionApi: "session.inTransaction",
        directExecutionPath,
        degradedMode: false,
      });
      if (session.inTransaction?.()) {
        try {
          logger.debug?.("Mongo transaction runtime diagnostic before transaction API", {
            txnLabel,
            sessionId,
            file: callerContext.file,
            function: callerContext.functionName,
            stackTrace: callerContext.stackTrace,
            topology,
            topologyType: topology.topologyType,
            setName: topology.setName,
            transactionApi: "session.abortTransaction",
            directExecutionPath,
            degradedMode: false,
          });
          await session.abortTransaction();
        } catch (abortError) {
          logger.error("Mongo transaction abort cleanup failed", {
            txnLabel,
            sessionId,
            file: callerContext.file,
            function: callerContext.functionName,
            reason: abortError?.message || String(abortError),
            directExecutionPath,
          });
        }
      }
    }
    throw error;
  } finally {
    if (!session) {
      logger.debug?.("Mongo transaction session skipped", {
        txnLabel,
        sessionId,
        directExecutionPath,
        degradedMode: degradedStandaloneMode,
      });
    } else {
      try {
        await session.endSession();
        logger.debug?.("Mongo transaction session ended", { txnLabel, sessionId });
        logger.debug?.("Mongo transaction structured log field verification", {
          txnLabel,
          sessionId,
          directExecutionPath,
          directExecutionPathType: "string",
          allowedDirectExecutionPathValues: Object.values(DIRECT_EXECUTION_PATH),
          structuredLoggingTypeStable: true,
        });
      } catch (sessionEndError) {
        logger.error("Mongo transaction session cleanup failed", {
          txnLabel,
          sessionId,
          reason: sessionEndError?.message || String(sessionEndError),
          directExecutionPath,
        });
      }
    }
  }
}
