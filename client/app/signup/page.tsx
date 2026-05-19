"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import Image from "next/image";
import { mutate } from "swr";
import API, {
  initCSRF,
} from "../../lib/api";
import { DASHBOARD_MAIN_BUNDLE_KEY, fetchDashboardMainBundleSWR } from "../../lib/swr-fetch";
import { clearRewardBannerLoginStorage } from "../../components/dashboard/RewardNotification";

import PrimaryButton from "../../components/PrimaryButton";
import { showToast, getMessage } from "../../lib/vipToast";

/* ==============================
   🔥 WRAPPER (FIX BUILD ERROR)
============================== */
export default function Page() {
  return (
    <Suspense fallback={<Loader />}>
      <SignupInner />
    </Suspense>
  );
}

/* ==============================
   🚀 SIGNUP COMPONENT
============================== */
function SignupInner() {
  const router = useRouter();
  const params = useSearchParams();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [number, setNumber] = useState("");
  const [password, setPassword] = useState("");
  const [referral, setReferral] = useState("");

  const [loading, setLoading] = useState(false);

  const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  const normalizePhone = (value: string) => value.replace(/[^\d+]/g, "");

  /* 🔗 AUTO REF */
  useEffect(() => {
    const ref = params.get("ref");
    if (ref) setReferral(ref);
  }, [params]);

  /* 🚀 SIGNUP */
  const handleSignup = async () => {
    if (loading) return;

    const cleanUsername = username.trim();
    const cleanEmail = email.trim().toLowerCase();
    const cleanPhone = normalizePhone(number.trim());
    const cleanPassword = password.trim();

    if (!cleanUsername || !cleanEmail || !cleanPassword || !cleanPhone) {
      return showToast("error", "All fields are required");
    }

    if (cleanUsername.length < 3) {
      return showToast("error", "Username must be at least 3 characters");
    }

    if (!isValidEmail(cleanEmail)) {
      return showToast("error", "Enter a valid email address");
    }

    if (!/^\+?\d{10,15}$/.test(cleanPhone)) {
      return showToast("error", "Enter a valid phone number");
    }

    if (cleanPassword.length < 8) {
      return showToast("error", "Password must be at least 8 characters");
    }

    try {
      setLoading(true);

      await initCSRF();
      await API.post("/auth/register", {
        username: cleanUsername,
        email: cleanEmail,
        password: cleanPassword,
        number: cleanPhone,
        referralCode: referral.trim(),
      });

      clearRewardBannerLoginStorage();
      try {
        await mutate(DASHBOARD_MAIN_BUNDLE_KEY, fetchDashboardMainBundleSWR());
      } catch {
        void mutate(DASHBOARD_MAIN_BUNDLE_KEY);
      }

      showToast("success", "Account created");

      setTimeout(() => {
        router.push("/dashboard");
      }, 800);

    } catch (err: any) {
      showToast("error", getMessage(err, "Signup failed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 relative overflow-hidden bg-[#040406] text-white">

      {/* 🌌 BACKGROUND */}
      <Glow />

      {/* 🔥 HEADER */}
      <Header />

      {/* 🧊 CARD */}
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm mt-16 p-[1px] rounded-3xl bg-gradient-to-r from-purple-500 via-indigo-500 to-cyan-500 shadow-[0_0_40px_rgba(139,92,246,0.4)]"
      >
        <div className="bg-[#0b0b0f]/90 backdrop-blur-xl p-6 rounded-3xl">

          <h2 className="text-2xl font-bold text-center mb-6 bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">
            Welcome to HybridEarn
          </h2>

          <Input label="Username" value={username} setValue={setUsername} />
          <Input label="Email" value={email} setValue={setEmail} type="email" />
          <Input label="Phone Number" value={number} setValue={setNumber} />
          <Input label="Password" value={password} setValue={setPassword} type="password" />
          <Input label="Referral Code (optional)" value={referral} setValue={setReferral} />

          <PrimaryButton
            type="button"
            onClick={handleSignup}
            loading={loading}
            className="mt-4 font-semibold hover:shadow-xl"
          >
            Signup 🚀
          </PrimaryButton>

          <p className="text-xs text-gray-400 text-center mt-5">
            Already have account?{" "}
            <span
              onClick={() => router.push("/login")}
              className="text-purple-400 cursor-pointer hover:underline"
            >
              Login
            </span>
          </p>

        </div>
      </motion.div>
    </div>
  );
}

/* ==============================
   🔹 COMPONENTS
============================== */

function Header() {
  return (
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
  );
}

function Glow() {
  return (
    <>
      <div className="absolute w-[500px] h-[500px] bg-purple-600 opacity-20 blur-[150px] top-[-150px] left-[-150px]" />
      <div className="absolute w-[500px] h-[500px] bg-indigo-600 opacity-20 blur-[150px] bottom-[-150px] right-[-150px]" />
    </>
  );
}

function Input({ label, value, setValue, type = "text" }: any) {
  return (
    <div className="mb-3">
      <p className="text-xs text-gray-400 mb-1">{label}</p>

      <input
        type={type}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={label}
        className="w-full bg-white/5 border border-white/10 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none p-3 rounded-xl text-sm transition placeholder:text-gray-500"
      />
    </div>
  );
}

function Spinner() {
  return (
    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
  );
}

function Loader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#040406]">
      <Spinner />
    </div>
  );
}
