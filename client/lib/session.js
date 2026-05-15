"use client";

import API, { normalize } from "./api";

export const fetchCurrentUser = async () => {
  const res = await API.get("/user/me");
  const raw = res.data || {};
  const response = normalize(raw);
  const fromData =
    response.data && typeof response.data === "object" && "_id" in response.data
      ? response.data
      : null;
  const fromLegacy = raw.user && typeof raw.user === "object" && "_id" in raw.user ? raw.user : null;
  return fromData ?? fromLegacy;
};

export const updateUserPassword = async (currentPassword, newPassword) => {
  const res = await API.post("/user/password", { currentPassword, newPassword });
  return normalize(res.data);
};
