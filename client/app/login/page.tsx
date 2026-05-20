"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import Image from "next/image";
import { mutate } from "swr";
import API, { initCSRF } from "../../lib/api";
import { resetLogoutState } from "../../lib/auth";
import { DASHBOARD_MAIN_BUNDLE_KEY, fetchDashboardMainBundleSWR } from "../../lib/swr-fetch";
import { clearRewardBannerLoginStorage } from "../../components/dashboard/RewardNotification";
import { showToast, getMessage } from "../../lib/vipToast";
import PrimaryButton from "../../components/PrimaryButton";

export default function Login() {
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  function loginErrorMessage(err: unknown): string {
    const e = err as { response?: { status?: number; data?: { msg?: string } }; message?: string; code?: string };
    const status = e?.response?.status;
    const msg = String(e?.response?.data?.msg || "").trim();
    const lower = msg.toLowerCase();
    if (!e?.response) {
      return "Cannot reach the server. Check your connection and that the API is running.";
    }
    if (status === 403 && lower.includes("csrf")) {
      return "Session security check failed. Refresh the page and try again.";
    }
    if (status === 400 && lower.includes("invalid credential")) {
      return "Invalid username or password";
    }
    if (status === 403 && lower.includes("blocked")) {
      return msg || "Action not allowed";
    }
    if (status === 429 || lower.includes("too many login")) {
      return msg || "Too many attempts. Try again later.";
    }
    return getMessage(err, "Invalid username or password");
  }

  const handleLogin = async () => {
    if (loading) return;

    const cleanUsername = username.trim();
    const cleanPassword = password.trim();

    if (!cleanUsername || !cleanPassword) {
      return showToast("error", "Enter username and password");
    }

    if (cleanUsername.length < 3) {
      return showToast("error", "Username must be at least 3 characters");
    }

    if (cleanPassword.length < 8) {
      return showToast("error", "Password must be at least 8 characters");
    }

    try {
      setLoading(true);
      resetLogoutState();

      const csrfToken = await initCSRF();
      await API.post("/auth/login", {
        username: cleanUsername,
        password: cleanPassword,
      }, {
        headers: {
          "X-CSRF-Token": csrfToken,
        },
      });

      clearRewardBannerLoginStorage();
      try {
        await mutate(DASHBOARD_MAIN_BUNDLE_KEY, fetchDashboardMainBundleSWR());
      } catch {
        void mutate(DASHBOARD_MAIN_BUNDLE_KEY);
      }

      showToast("success", "Login successful");
      router.replace("/dashboard");

    } catch (err: any) {
      showToast("error", loginErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 relative overflow-hidden bg-[#040406] text-white">
      {/* 🌌 BACKGROUND */}
      <div className="absolute w-[500px] h-[500px] bg-purple-600 opacity-20 blur-[150px] top-[-150px] left-[-150px]" />
      <div className="absolute w-[500px] h-[500px] bg-indigo-600 opacity-20 blur-[150px] bottom-[-150px] right-[-150px]" />

      {/* 🔥 HEADER */}
      <div className="absolute top-6 left-1/2 -translate-x-1/2 flex items-center gap-2">
        <Image
          src="/logo.png"
          alt="HybridEarn"
          width={36}
          height={36}
          className="rounded-full shadow-[0_0_20px_rgba(168,85,247,0.8)]"
        />
        <h1 className="font-bold text-lg bg-gradient-to-r from-purple-400 to-indigo-400 bg-clip-text text-transparent">
          HybridEarn
        </h1>
      </div>

      {/* 🧊 CARD */}
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm mt-16 p-[1px] rounded-3xl bg-gradient-to-r from-purple-500 to-indigo-500"
      >
        <div className="bg-[#0b0b0f]/90 backdrop-blur-xl p-6 rounded-3xl">

          {/* TITLE */}
          <h2 className="text-2xl font-bold text-center mb-2 text-glow">
            Welcome to HybridEarn
          </h2>
          <p className="mb-6 text-center text-xs text-gray-400">
            Login to your account
          </p>

          {/* USERNAME */}
          <Input
            label="Username"
            value={username}
            setValue={setUsername}
          />

          {/* PASSWORD */}
          <Input
            label="Password"
            value={password}
            setValue={setPassword}
            type="password"
          />

          {/* BUTTON */}
          <PrimaryButton
            type="button"
            onClick={handleLogin}
            loading={loading}
            className="mt-4 font-semibold hover:shadow-xl"
          >
            Login 🔐
          </PrimaryButton>

          {/* SIGNUP */}
          <p className="text-xs text-gray-400 text-center mt-5">
            Don’t have an account?{" "}
            <span
              onClick={() => router.push("/signup")}
              className="text-purple-400 cursor-pointer hover:underline"
            >
              Signup
            </span>
          </p>

        </div>
      </motion.div>
    </div>
  );
}

/* 🔹 INPUT COMPONENT */
function Input({ label, value, setValue, type = "text" }: any) {
  return (
    <div className="mb-3">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <input
        type={type}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full bg-white/5 border border-white/10 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none p-3 rounded-xl text-sm transition"
        placeholder={label}
      />
    </div>
  );
}