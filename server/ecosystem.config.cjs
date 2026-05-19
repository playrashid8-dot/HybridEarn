/**
 * PM2: API cluster (single PORT), dedicated hybrid (WS + engine), BullMQ workers.
 * From repo: cd server; pm2 start ecosystem.config.cjs (PowerShell/bash: use `;` not `&&`)
 * PowerShell: cd server; pm2 start ecosystem.config.cjs
 *
 * API uses cluster mode (3 workers, one listen port). Nginx upstream targets :5000.
 * Alternative: fork 3 processes on 5000–5002 and restore multi-server block in deploy/nginx.
 */
const path = require("path");

const cwd = __dirname;

const interpreterArgs = "--expose-gc --max-old-space-size=1024";
const workerInterpreterArgs = "--expose-gc --max-old-space-size=1024";

const commonEnv = {
  NODE_ENV: process.env.NODE_ENV || "production",
};

module.exports = {
  apps: [
    {
      name: "nova-api",
      cwd,
      script: "./src/server.js",
      instances: 3,
      exec_mode: "cluster",
      interpreter_args: interpreterArgs,
      merge_logs: true,
      env: {
        ...commonEnv,
        NOVA_SERVICE: "api",
        PORT: 5000,
      },
    },
    {
      name: "nova-hybrid",
      cwd,
      script: "./src/hybridService.js",
      instances: 1,
      exec_mode: "fork",
      interpreter_args: interpreterArgs,
      env: {
        ...commonEnv,
        PORT: 5050,
      },
    },
    {
      name: "nova-worker-deposit",
      cwd,
      script: "./src/worker.js",
      instances: 2,
      exec_mode: "fork",
      interpreter_args: workerInterpreterArgs,
      env: commonEnv,
    },
  ],
};
