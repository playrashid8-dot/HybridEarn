"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import Image from "next/image";
import axios from "axios";
import GlassCard from "../components/GlassCard";
import StatCard from "../components/StatCard";
import { BASE_URL } from "../lib/api";

const TELEGRAM_URL = "https://t.me/Hybrid_earn";
const PDF_PAGE_URL = "https://hybridearn.com/pdf";

type PlatformStats = {
  users?: number;
  deposits?: number;
  withdrawn?: number;
};

const fadeUp = {
  hidden: { opacity: 0, y: 18 },
  show: (i?: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: (i ?? 0) * 0.06, duration: 0.45, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

export default function Home() {
  const router = useRouter();
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(false);

  useEffect(() => {
    const fetchStats = async () => {
      setStatsLoading(true);
      setStatsError(false);
      try {
        const res = await axios.get(`${BASE_URL}/public/platform-stats`, {
          withCredentials: false,
          validateStatus: (s) => s === 200,
        });

        const root = res.data?.data ?? res.data;
        const block = root?.stats ?? root;
        const totalUsers = block?.totalUsers;
        const totalDeposits = block?.totalDeposits;
        const totalWithdrawals = block?.totalWithdrawals;

        const allNumbers =
          Number.isFinite(totalUsers) &&
          Number.isFinite(totalDeposits) &&
          Number.isFinite(totalWithdrawals);

        if (!allNumbers) {
          setStats(null);
          setStatsError(true);
          return;
        }

        setStats({
          users: totalUsers,
          deposits: totalDeposits,
          withdrawn: totalWithdrawals,
        });
      } catch (err) {
        console.error("Stats error", err);
        setStats(null);
        setStatsError(true);
      } finally {
        setStatsLoading(false);
      }
    };

    fetchStats();
  }, []);

  const statDisplay = (value: unknown) => {
    if (statsLoading) return "…";
    if (statsError || value === undefined || value === null) return "—";
    return Number(value).toLocaleString();
  };

  return (
    <div className="relative min-h-screen overflow-x-hidden text-white">
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute left-1/2 top-0 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/3 rounded-full bg-violet-600/20 blur-[128px]" />
        <div className="absolute bottom-0 right-[-10%] h-[360px] w-[360px] rounded-full bg-blue-600/15 blur-[100px]" />
        <div className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.04)_1px,transparent_1px)] [background-size:28px_28px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-6xl px-4 pb-20 pt-6 sm:px-6 sm:pt-10">
        {/* Brand bar — no login/signup */}
        <motion.header
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-10 flex items-center justify-center sm:justify-start"
        >
          <button
            type="button"
            onClick={() => router.push("/")}
            className="flex items-center gap-3 text-left transition hover:opacity-90"
          >
            <Image
              src="/logo.png"
              alt="HybridEarn"
              width={44}
              height={44}
              className="rounded-full shadow-[0_0_24px_rgba(139,92,246,0.45)]"
            />
            <span className="text-xl font-black tracking-tight bg-gradient-to-r from-violet-200 via-fuchsia-200 to-cyan-200 bg-clip-text text-transparent">
              HybridEarn
            </span>
          </button>
        </motion.header>

        {/* Hero */}
        <motion.section
          initial="hidden"
          animate="show"
          variants={stagger}
          className="mb-12 text-center sm:text-left"
        >
          <GlassCard glow="purple" className="mb-8">
            <motion.div custom={0} variants={fadeUp} initial="hidden" animate="show">
              <p className="mb-2 inline-flex rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-violet-200/90">
                BEP20 · On-chain
              </p>
              <h1 className="mt-3 text-3xl font-black leading-tight tracking-tight text-white sm:text-4xl lg:text-5xl">
                HybridEarn —{" "}
                <span className="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
                  Smart On-Chain Earnings
                </span>
              </h1>
              <p className="mx-auto mt-4 max-w-2xl text-sm text-gray-400 sm:mx-0 sm:text-base">
                Earn daily ROI, build your team, and grow with secure BEP20 infrastructure.
              </p>
              <div className="mx-auto mt-6 w-full max-w-md sm:mx-0 sm:max-w-lg">
                <div className="grid grid-cols-2 gap-3 sm:gap-4">
                  <motion.button
                    type="button"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => router.push("/signup")}
                    className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 via-fuchsia-600 to-indigo-600 px-3 py-2.5 text-center text-xs font-bold leading-tight text-white shadow-[0_0_28px_rgba(139,92,246,0.35)] ring-1 ring-white/20 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 sm:min-h-[52px] sm:px-4 sm:text-sm"
                  >
                    <IconUserPlus className="h-4 w-4 shrink-0 sm:h-[18px] sm:w-[18px]" />
                    <span className="text-center">Signup</span>
                  </motion.button>
                  <motion.button
                    type="button"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => router.push("/login")}
                    className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl border border-white/18 bg-white/[0.06] px-3 py-2.5 text-center text-xs font-semibold leading-tight text-violet-100 shadow-[0_0_20px_rgba(139,92,246,0.12)] backdrop-blur-xl transition hover:border-violet-400/45 hover:bg-violet-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 sm:min-h-[52px] sm:px-4 sm:text-sm"
                  >
                    <IconLogIn className="h-4 w-4 shrink-0 sm:h-[18px] sm:w-[18px]" />
                    <span className="text-center">Login</span>
                  </motion.button>
                  <motion.a
                    href={TELEGRAM_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl border border-white/12 bg-black/35 px-3 py-2.5 text-center text-xs font-semibold leading-tight text-sky-100/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl transition hover:border-sky-400/35 hover:bg-black/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 sm:min-h-[52px] sm:px-4 sm:text-sm"
                  >
                    <IconTelegram className="h-4 w-4 shrink-0 text-sky-300 sm:h-[18px] sm:w-[18px]" />
                    <span className="text-center">Join Telegram</span>
                  </motion.a>
                  <motion.a
                    href={PDF_PAGE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 via-yellow-400 to-orange-500 px-3 py-2.5 text-center text-xs font-bold leading-tight text-black shadow-[0_0_24px_rgba(251,191,36,0.35)] ring-1 ring-amber-200/40 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/90 sm:min-h-[52px] sm:px-4 sm:text-sm"
                  >
                    <IconDocument className="h-4 w-4 shrink-0 sm:h-[18px] sm:w-[18px]" />
                    <span className="text-center">View Full PDF</span>
                  </motion.a>
                </div>
              </div>
            </motion.div>
          </GlassCard>

          {/* Stats */}
          <motion.div custom={1} variants={fadeUp} initial="hidden" animate="show" className="grid gap-3 sm:grid-cols-3">
            <StatCard title="Total Users" value={statDisplay(stats?.users)} tone="purple" className="rounded-xl p-5 text-center" />
            <StatCard title="Total Deposits" value={statDisplay(stats?.deposits)} tone="cyan" className="rounded-xl p-5 text-center" />
            <StatCard title="Total Withdrawn" value={statDisplay(stats?.withdrawn)} tone="green" className="rounded-xl p-5 text-center" />
          </motion.div>
        </motion.section>

        {/* Features */}
        <SectionTitle kicker="Why HybridEarn" title="Built to scale your stack" />
        <motion.ul
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-60px" }}
          variants={stagger}
          className="mb-14 grid gap-3 sm:grid-cols-2"
        >
          <FeatureCard
            emoji="📈"
            title="Daily ROI"
            line="Earn up to 5% daily"
            icon={<IconChart />}
            i={0}
          />
          <FeatureCard
            emoji="👥"
            title="Referral System"
            line="3-Level team income (10% / 6% / 5%)"
            icon={<IconUsers />}
            i={1}
          />
          <FeatureCard
            emoji="💼"
            title="Staking"
            line="Flexible 7–60 day plans"
            icon={<IconLayers />}
            i={2}
          />
          <FeatureCard
            emoji="👑"
            title="VIP Rewards"
            line="Higher ROI with growth"
            icon={<IconCrown />}
            i={3}
          />
        </motion.ul>

        {/* How it works */}
        <SectionTitle kicker="Flow" title="How it works" />
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-40px" }}
          variants={stagger}
          className="mb-14 grid gap-3 md:grid-cols-3"
        >
          <StepCard n={1} title="Signup & Deposit" line="Fund via BEP20 wallet" />
          <StepCard n={2} title="Earn Daily" line="ROI + staking profits" />
          <StepCard n={3} title="Withdraw" line="Secure payout system" />
        </motion.div>

        {/* VIP */}
        <SectionTitle kicker="Levels" title="VIP tiers" />
        <p className="-mt-6 mb-4 text-center text-xs text-gray-500 md:text-left">Higher team = higher earnings</p>
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true }}
          variants={stagger}
          className="mb-14 grid gap-3 sm:grid-cols-3"
        >
          <VipCard level="VIP 1" rate="4%" />
          <VipCard level="VIP 2" rate="4.5%" accent="cyan" />
          <VipCard level="VIP 3" rate="5%" accent="gold" />
        </motion.div>

        {/* Rewards */}
        <SectionTitle kicker="Extras" title="Reward system" />
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true }}
          variants={stagger}
          className="mb-14 grid gap-3 sm:grid-cols-3"
        >
          <MiniGlass emoji="🎁" title="Level Bonus" line="Earn up to 50 USDT" />
          <MiniGlass emoji="💰" title="Salary Rewards" line="Up to 500 USDT milestones" />
          <MiniGlass emoji="📊" title="Team Growth" line="Unlock rewards by referrals" />
        </motion.div>

        {/* Withdraw + Trust row */}
        <div className="mb-14 grid gap-4 lg:grid-cols-2">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45 }}
            className="rounded-xl border border-white/10 bg-white/[0.04] p-6 shadow-[0_20px_50px_rgba(0,0,0,0.35)] backdrop-blur-2xl"
          >
            <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-emerald-200/80">Withdraw</p>
            <ul className="mt-4 space-y-3 text-sm text-gray-300">
              <CheckRow>Secure withdrawals</CheckRow>
              <CheckRow>5% fee</CheckRow>
              <CheckRow>Auto + Admin protected system</CheckRow>
            </ul>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45, delay: 0.06 }}
            className="rounded-xl border border-white/10 bg-white/[0.04] p-6 shadow-[0_20px_50px_rgba(0,0,0,0.35)] backdrop-blur-2xl"
          >
            <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-violet-200/80">Trust</p>
            <ul className="mt-4 space-y-3 text-sm text-gray-300">
              <CheckRow>Secure Cookie Auth</CheckRow>
              <CheckRow>Blockchain Transparency</CheckRow>
              <CheckRow>Real-time System</CheckRow>
            </ul>
          </motion.div>
        </div>

        {/* Final CTA */}
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <GlassCard glow="gold" className="text-center">
            <p className="text-2xl font-black sm:text-3xl">
              <span aria-hidden>🔥 </span>
              Start Your Earning Journey Today
            </p>
            <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
              <motion.button
                type="button"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => router.push("/signup")}
                className="rounded-xl bg-gradient-to-r from-violet-600 via-fuchsia-600 to-indigo-600 px-8 py-3.5 text-sm font-bold text-white shadow-[0_0_36px_rgba(234,179,8,0.2)] ring-1 ring-white/15"
              >
                Create Account
              </motion.button>
              <motion.a
                href={TELEGRAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className="rounded-xl border border-white/15 bg-white/[0.06] px-8 py-3.5 text-sm font-semibold text-amber-100/95 backdrop-blur-xl transition hover:border-amber-400/35"
              >
                Join Telegram
              </motion.a>
            </div>
          </GlassCard>
        </motion.div>
      </div>
    </div>
  );
}

function SectionTitle({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="mb-5">
      <p className="text-[10px] font-bold uppercase tracking-[0.26em] text-cyan-200/70">{kicker}</p>
      <h2 className="mt-1 text-xl font-black text-white sm:text-2xl">{title}</h2>
    </div>
  );
}

function FeatureCard({
  emoji,
  title,
  line,
  icon,
  i,
}: {
  emoji: string;
  title: string;
  line: string;
  icon: ReactNode;
  i: number;
}) {
  return (
    <motion.li
      custom={i}
      variants={fadeUp}
      whileHover={{ y: -3 }}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
      className="flex gap-4 rounded-xl border border-white/10 bg-white/[0.05] p-4 shadow-lg shadow-black/20 backdrop-blur-xl"
    >
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-violet-500/20 text-violet-200">{icon}</span>
      <div className="min-w-0 text-left">
        <p className="text-sm font-bold text-white">
          <span className="mr-1.5" aria-hidden>
            {emoji}
          </span>
          {title}
        </p>
        <p className="mt-0.5 truncate text-xs text-gray-400 sm:whitespace-normal">{line}</p>
      </div>
    </motion.li>
  );
}

function StepCard({ n, title, line }: { n: number; title: string; line: string }) {
  return (
    <motion.div
      variants={fadeUp}
      custom={n}
      className="rounded-xl border border-white/10 bg-gradient-to-br from-white/[0.07] to-violet-500/[0.06] p-5 shadow-[0_16px_40px_rgba(0,0,0,0.28)] backdrop-blur-xl"
    >
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-violet-500/25 text-sm font-black text-violet-100">
        {n}
      </span>
      <p className="mt-3 text-sm font-bold text-white">{title}</p>
      <p className="mt-1 text-xs text-gray-400">{line}</p>
    </motion.div>
  );
}

function VipCard({ level, rate, accent = "purple" }: { level: string; rate: string; accent?: "purple" | "cyan" | "gold" }) {
  const ring =
    accent === "cyan"
      ? "shadow-[0_0_28px_rgba(34,211,238,0.15)] border-cyan-400/25"
      : accent === "gold"
        ? "shadow-[0_0_28px_rgba(234,179,8,0.12)] border-amber-400/25"
        : "border-white/10";
  return (
    <motion.div
      variants={fadeUp}
      whileHover={{ y: -4 }}
      className={`rounded-xl border bg-white/[0.05] p-5 text-center backdrop-blur-xl ${ring}`}
    >
      <p className="text-xs font-bold uppercase tracking-wider text-gray-500">{level}</p>
      <p className="mt-3 text-3xl font-black bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">{rate}</p>
      <p className="mt-1 text-[10px] text-gray-500">daily ROI tier</p>
    </motion.div>
  );
}

function MiniGlass({ emoji, title, line }: { emoji: string; title: string; line: string }) {
  return (
    <motion.div
      variants={fadeUp}
      className="rounded-xl border border-white/10 bg-white/[0.04] p-5 text-center shadow-lg backdrop-blur-xl transition hover:border-violet-400/30"
    >
      <p className="text-2xl" aria-hidden>
        {emoji}
      </p>
      <p className="mt-2 text-sm font-bold text-white">{title}</p>
      <p className="mt-1 text-xs text-gray-400">{line}</p>
    </motion.div>
  );
}

function CheckRow({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className="text-emerald-400" aria-hidden>
        ✔️
      </span>
      <span>{children}</span>
    </li>
  );
}

function IconUserPlus({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6M22 11h-6" />
    </svg>
  );
}

function IconLogIn({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
    </svg>
  );
}

function IconTelegram({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.147-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

function IconDocument({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8M8 17h8M8 9h2" />
    </svg>
  );
}

function IconChart() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 3 3 5-7" />
    </svg>
  );
}

function IconUsers() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconLayers() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5M2 12l10 5 10-5" />
    </svg>
  );
}

function IconCrown() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M2 17l4-10 4 5 4-9 4 9 4-5 4 10H2z" />
      <path d="M4 17h16v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2z" />
    </svg>
  );
}
