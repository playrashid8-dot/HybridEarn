import API, { normalize } from "./api";

export const fetchHybridSummary = async (options = {}) => {
  const res = await API.get("/hybrid/deposit/summary", {
    params: options.scope ? { scope: options.scope } : undefined,
    timeout: options.timeout,
  });
  const response = normalize(res.data);
  const data = response.data;
  return data && typeof data === "object" && Object.keys(data).length ? data : null;
};

/**
 * Hybrid ledger (protected). Path `/hybrid/ledger` on the API client (base URL must end with `/api`).
 * Uses API instance so interceptors handle 401 on session checks (e.g. `/user/me`) → logout and cookies are sent.
 */
export const fetchHybridLedger = async () => {
  const res = await API.get("/hybrid/ledger", { withCredentials: true });
  const response = normalize(res.data);
  if (response.success !== true) {
    const msg = response.msg || "Could not load ledger";
    throw new Error(msg);
  }
  const entries = response.data?.entries;
  if (!Array.isArray(entries)) {
    throw new Error(response.msg || "Invalid ledger response");
  }
  return entries;
};

/** Fresh direct/team counts for stage-based salary milestones (since last salary claim). */
export const fetchSalaryProgress = async () => {
  const res = await API.get("/user/salary-progress");
  const response = normalize(res.data);
  const data = response.data;
  return data && typeof data === "object" && Object.keys(data).length ? data : null;
};

export const claimHybridRoi = async () => {
  const res = await API.post("/roi/claim");
  const response = normalize(res.data);
  return response.data && Object.keys(response.data).length ? response.data : null;
};

export const fetchRoiClaimStatus = async (jobId) => {
  const res = await API.get("/roi/claim-status", {
    params: jobId ? { jobId } : undefined,
    timeout: 10000,
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  const response = normalize(res.data);
  return response.data && typeof response.data === "object" ? response.data : null;
};

export const claimHybridSalary = async () => {
  const res = await API.post("/salary/claim");
  const response = normalize(res.data);
  return response.data && Object.keys(response.data).length ? response.data : null;
};

export const fetchHybridWithdrawals = async (options = {}) => {
  const res = await API.get("/withdraw/my", {
    timeout: options.timeout,
  });
  const response = normalize(res.data);
  return response.data?.withdrawals || [];
};

export const fetchHybridStakes = async () => {
  const res = await API.get("/stake/my");
  const response = normalize(res.data);
  return response.data?.stakes || [];
};

export const createHybridStake = async (payload) => {
  const res = await API.post("/stake/create", payload);
  const response = normalize(res.data);
  return response.data && Object.keys(response.data).length ? response.data : null;
};

export const claimHybridStake = async (stakeId) => {
  const res = await API.post("/stake/claim", { stakeId });
  const response = normalize(res.data);
  return response.data && Object.keys(response.data).length ? response.data : null;
};

export const requestHybridWithdraw = async (payload, idempotencyKey, options = {}) => {
  const res = await API.post(
    "/user/withdraw",
    {
      amount: payload.amount,
      walletAddress: payload.walletAddress,
      password: payload.password,
    },
    {
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
      timeout: options.timeout,
    }
  );

  const response = normalize(res.data);
  const data =
    response.data && Object.keys(response.data).length ? response.data : null;
  if (data && typeof data === "object") {
    Object.defineProperty(data, "__httpTrace", {
      value: {
        status: res.status,
        body: res.data,
      },
      enumerable: false,
    });
  }
  return data;
};

export const claimHybridWithdraw = async (withdrawalId) => {
  const res = await API.post("/withdraw/claim", { withdrawalId });
  const response = normalize(res.data);
  return response.data && Object.keys(response.data).length ? response.data : null;
};
