import API, { resetRedirectState } from "./api";
import { showToast } from "./vipToast";
import { fetchCurrentUser } from "./session";

// 🚫 prevent multiple logout redirects
let isLoggingOut = false;

/** Sync check on a user object from /user/me (see `data` or legacy `user` on response). */
export const isAdmin = (user) => user?.isAdmin === true;

// 🔒 CHECK AUTH (server verifies httpOnly cookie)
export const isAuth = async () => {
  if (typeof window === "undefined") return false;

  try {
    await API.get("/user/me");
    return true;
  } catch {
    return false;
  }
};

// 🛡️ ADMIN CHECK (session)
export const checkAdminSession = async () => {
  try {
    const user = await fetchCurrentUser();
    return isAdmin(user);
  } catch {
    return false;
  }
};

/** @param {unknown} [reason] — 'session_expired' | 'silent' | 'user'; undefined = silent (no accidental success on bare logout()). Objects (e.g. React click events) ⇒ user ⇒ success toast. */
function logoutMode(reason) {
  if (reason === undefined || reason === null) return "silent";
  if (reason === "session_expired") return "session_expired";
  if (reason === "silent") return "silent";
  if (reason === "user") return "user";
  if (typeof reason === "object") return "user";
  return "silent";
}

// 🚪 LOGOUT
export const logout = (reason) => {
  if (typeof window === "undefined") return;

  if (isLoggingOut) return;
  isLoggingOut = true;

  API.post("/auth/logout").catch(() => {
    // No-op: local cleanup + redirect should still complete.
  });

  const mode = logoutMode(reason);

  if (mode === "session_expired") {
    showToast("error", "Session expired. Please sign in again.");
  } else if (mode === "user") {
    showToast("success", "Logout successful");
  }

  setTimeout(() => {
    window.location.href = "/login";
  }, 800);
};

export const resetLogoutState = () => {
  isLoggingOut = false;
  resetRedirectState();
};

// 🛡️ PROTECT ROUTE
export const protectRoute = (router) => {
  if (typeof window === "undefined") return Promise.resolve();

  return isAuth().then((ok) => {
    if (!ok) {
      router.replace("/login");
    }
  });
};
