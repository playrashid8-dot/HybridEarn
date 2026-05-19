/**
 * TEMPORARY production crash tracer.
 * Logs outbound request/socket targets with a stack so misconfigured endpoints
 * are visible before a low-level TCP error reaches uncaughtException.
 */
import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import logger, { sanitizeForLog } from "../utils/logger.js";

const enabled = String(process.env.OUTBOUND_DEBUG || "").toLowerCase() === "true";
const installedKey = Symbol.for("novacentral.outboundDebug.installed");

function clean(value) {
  return sanitizeForLog(String(value ?? ""), 1200);
}

function stackTrace() {
  return clean(new Error("Outbound call stack").stack);
}

function callerFromStack(stack) {
  const lines = String(stack || "").split("\n").map((line) => line.trim());
  return clean(lines.find((line) => !line.includes("outboundDebug.js") && line.startsWith("at ")) || "");
}

function normalizeRequestTarget(args) {
  const [first, second] = args;

  try {
    if (first instanceof URL) return first.toString();
  } catch {
    /* ignore */
  }

  if (typeof first === "string") {
    try {
      return new URL(first).toString();
    } catch {
      return first;
    }
  }

  const options = typeof first === "object" && first !== null ? first : second;
  if (typeof options === "object" && options !== null) {
    const protocol = options.protocol || "https:";
    const host = options.hostname || options.host || "unknown-host";
    const port = options.port ? `:${options.port}` : "";
    const path = options.path || "/";
    return `${protocol}//${host}${port}${path}`;
  }

  return "unknown-request-target";
}

function normalizeConnectTarget(args) {
  const [first, second] = args;

  if (typeof first === "object" && first !== null) {
    return {
      host: clean(first.host || first.hostname || "localhost"),
      port: clean(first.port || ""),
      path: clean(first.path || ""),
    };
  }

  if (typeof first === "number") {
    return {
      host: clean(typeof second === "string" ? second : "localhost"),
      port: clean(first),
      path: "",
    };
  }

  if (typeof first === "string") {
    return {
      host: "",
      port: "",
      path: clean(first),
    };
  }

  return { host: "unknown-host", port: "", path: "" };
}

function logOutbound(kind, target) {
  const stack = stackTrace();
  logger.warn("TEMP outbound network trace", {
    kind,
    target,
    caller: callerFromStack(stack),
    stack,
  });
}

function wrapRequest(moduleName, moduleRef, methodName) {
  const original = moduleRef[methodName];
  if (typeof original !== "function") return;

  moduleRef[methodName] = function tracedRequest(...args) {
    logOutbound(`${moduleName}.${methodName}`, clean(normalizeRequestTarget(args)));
    return original.apply(this, args);
  };
}

function wrapConnect(moduleName, moduleRef, methodName) {
  const original = moduleRef[methodName];
  if (typeof original !== "function") return;

  moduleRef[methodName] = function tracedConnect(...args) {
    logOutbound(`${moduleName}.${methodName}`, normalizeConnectTarget(args));
    return original.apply(this, args);
  };
}

function install() {
  if (!enabled || globalThis[installedKey]) {
    return;
  }
  globalThis[installedKey] = true;

  wrapRequest("http", http, "request");
  wrapRequest("http", http, "get");
  wrapRequest("https", https, "request");
  wrapRequest("https", https, "get");
  wrapConnect("net", net, "connect");
  wrapConnect("net", net, "createConnection");
  wrapConnect("tls", tls, "connect");

  const originalSocketConnect = net.Socket.prototype.connect;
  if (typeof originalSocketConnect === "function") {
    net.Socket.prototype.connect = function tracedSocketConnect(...args) {
      logOutbound("net.Socket.connect", normalizeConnectTarget(args));
      return originalSocketConnect.apply(this, args);
    };
  }

  logger.warn("TEMP outbound network tracer enabled", {});
}

install();
