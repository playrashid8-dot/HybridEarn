"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { motion } from "framer-motion";
import API, { normalize } from "../../../lib/api";
import { fetchTeamPageBundleSWR, TEAM_PAGE_BUNDLE_KEY, hybridDashboardSWRConfig } from "../../../lib/swr-fetch";
import { showToast as vipToast } from "../../../lib/vipToast";
import ProtectedRoute from "../../../components/ProtectedRoute";
import PageWrapper from "../../../components/PageWrapper";
import LiveRefreshIndicator from "../../../components/LiveRefreshIndicator";

const CARD = "rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl";

function StatsSectionSkeleton({ card }: { card: string }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4 sm:gap-3" aria-busy aria-label="Loading team stats">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className={`${card} px-3 py-3 text-center sm:py-4`}>
          <div className="mx-auto h-2 w-20 animate-pulse rounded bg-white/10" />
          <div className="mx-auto mt-2 h-6 w-12 animate-pulse rounded bg-white/10" />
        </div>
      ))}
    </div>
  );
}

type ReferralStatsPayload = {
    directCount?: number;
    teamCount?: number;
    referralEarnings?: number;
    teamRoiIncome?: number;
    firstDepositBonusEarned?: number;
    referralCode?: string;
    teamVolume?: number;
};

type TeamMemberRow = {
    id?: string;
    username: string;
    level: "A" | "B" | "C";
    joinedAt: string;
    balance: number;
};

function normalizeTeamPayload(raw: unknown): { members: TeamMemberRow[]; hasMore: boolean } {
    if (Array.isArray(raw)) {
        return { members: raw as TeamMemberRow[], hasMore: false };
    }
    if (raw && typeof raw === "object" && raw !== null) {
        const o = raw as { members?: TeamMemberRow[]; hasMore?: unknown };
        const members = Array.isArray(o.members) ? o.members : [];
        const hasMore = Boolean(o.hasMore);
        return { members, hasMore };
    }
    return { members: [], hasMore: false };
}

function isAfterClaim(joinedIso: string | undefined, claimedIso: string | null | undefined): boolean {
  if (!claimedIso || !joinedIso) return false;
  const j = new Date(joinedIso).getTime();
  const c = new Date(claimedIso).getTime();
  if (Number.isNaN(j) || Number.isNaN(c)) return false;
  return j > c;
}

export default function TeamPage() {
  const pushToast = useCallback((type: "success" | "error", message: string) => {
    vipToast(type, message);
  }, []);
  const [members, setMembers] = useState<TeamMemberRow[]>([]);
  const [membersPage, setMembersPage] = useState(1);
  const [membersHasMore, setMembersHasMore] = useState(false);
  const [loadingMoreMembers, setLoadingMoreMembers] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [lastSalaryClaimAt, setLastSalaryClaimAt] = useState<string | null>(null);

  const {
    data: teamBundle,
    isLoading: loadingTeamBundle,
    isValidating: summaryValidating,
  } = useSWR(TEAM_PAGE_BUNDLE_KEY, fetchTeamPageBundleSWR, hybridDashboardSWRConfig);

  const user = teamBundle?.user;
  const summary = teamBundle?.summary;

  const referralCode = String(
    summary?.referralStats?.referralCode ?? user?.referralCode ?? ""
  ).trim();

  const loadingPage = loadingTeamBundle && !user;
  const loadingStats = loadingTeamBundle && !teamBundle;
  const loadingMembers = loadingTeamBundle && !teamBundle;

  const stats = summary?.referralStats ?? null;
  const referralStatsReady = Boolean(teamBundle);
  const membersReady = Boolean(teamBundle);

  useEffect(() => {
    if (!summary?.teamMembers) return;
    setMembers(summary.teamMembers.members);
    setMembersPage(summary.teamMembers.page ?? 1);
    setMembersHasMore(Boolean(summary.teamMembers.hasMore));
  }, [summary]);

  useEffect(() => {
    const at = summary?.salaryProgress?.lastClaimedAt;
    setLastSalaryClaimAt(at != null && String(at).trim() ? String(at) : null);
  }, [summary?.salaryProgress?.lastClaimedAt]);

  useEffect(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (!summary?.referralStats) return;
    setLastUpdatedAt(Date.now());
  }, [summary?.referralStats]);

  const loadMoreMembers = useCallback(async () => {
    if (!membersHasMore || loadingMoreMembers || loadingMembers) return;
    try {
      setLoadingMoreMembers(true);
      const nextPage = membersPage + 1;
      const teamRes = await API.get(`/user/team-members?page=${nextPage}`);
      if (!teamRes?.data || !normalize(teamRes.data).success) {
        throw new Error("Bad response");
      }
      const normalized = normalizeTeamPayload(normalize(teamRes.data).data);
      setMembers((prev) => [...prev, ...normalized.members]);
      setMembersPage(nextPage);
      setMembersHasMore(normalized.hasMore);
    } catch {
      pushToast("error", "Could not load more members");
    } finally {
      setLoadingMoreMembers(false);
    }
  }, [loadingMembers, loadingMoreMembers, membersHasMore, membersPage, pushToast]);

  const directCount = Number(stats?.directCount ?? 0);
  const teamCount = Number(stats?.teamCount ?? 0);
  const teamRoiIncome = Number(stats?.teamRoiIncome ?? 0);
  const firstDepositBonusEarned = Number(stats?.firstDepositBonusEarned ?? 0);
  const referralIncomeTotal = Number(stats?.referralEarnings ?? 0);

  return (
    <ProtectedRoute>
      <PageWrapper loading={loadingPage && !user} data={user?._id} emptyText="No data available">
        <TeamContent
          loadingPage={loadingPage}
          loadingStats={loadingStats}
          summaryValidating={summaryValidating}
          directCount={directCount}
          teamCount={teamCount}
          teamRoiIncome={teamRoiIncome}
          firstDepositBonusEarned={firstDepositBonusEarned}
          referralIncomeTotal={referralIncomeTotal}
          referralCode={referralCode}
          referralStatsReady={referralStatsReady}
          members={members}
          membersReady={membersReady}
          loadingMembers={loadingMembers}
          lastUpdatedAt={lastUpdatedAt}
          lastSalaryClaimAt={lastSalaryClaimAt}
          membersHasMore={membersHasMore}
          loadingMoreMembers={loadingMoreMembers}
          notifyToast={pushToast}
          onLoadMoreMembers={() => void loadMoreMembers()}
        />
      </PageWrapper>
    </ProtectedRoute>
  );
}

function TeamContent({
  loadingPage,
  loadingStats,
  summaryValidating,
  directCount,
  teamCount,
  teamRoiIncome,
  firstDepositBonusEarned,
  referralIncomeTotal,
  referralCode,
  referralStatsReady,
  members,
  membersReady,
  loadingMembers,
  lastUpdatedAt,
  lastSalaryClaimAt,
  membersHasMore,
  loadingMoreMembers,
  notifyToast,
  onLoadMoreMembers,
}: {
  loadingPage: boolean;
  loadingStats: boolean;
  summaryValidating: boolean;
  directCount: number;
  teamCount: number;
  teamRoiIncome: number;
  firstDepositBonusEarned: number;
  referralIncomeTotal: number;
  referralCode: string;
  referralStatsReady: boolean;
  members: TeamMemberRow[];
  membersReady: boolean;
  loadingMembers: boolean;
  lastUpdatedAt: number | null;
  lastSalaryClaimAt: string | null;
  membersHasMore: boolean;
  loadingMoreMembers: boolean;
  notifyToast: (type: "success" | "error", message: string) => void;
  onLoadMoreMembers: () => void;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const filteredMembers = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    if (!q) return members;
    return members.filter((u) =>
      String(u.username ?? "")
        .toLowerCase()
        .includes(q)
    );
  }, [members, debouncedSearch]);

  const totalBalance = useMemo(
    () => members.reduce((sum, u) => sum + Number(u.balance ?? 0), 0),
    [members]
  );

  return (
    <div className="relative w-full max-w-full overflow-x-hidden px-1 pb-24 text-white sm:px-0">
      <motion.header
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative z-10 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
      >
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-500">HybridEarn</p>
          <h1 className="text-lg font-bold tracking-tight text-white sm:text-2xl">Team</h1>
          <p className="mt-0.5 text-[11px] text-gray-400 sm:text-xs">Referral network & balances</p>
          {loadingStats ? (
            <p className="mt-2 text-[11px] text-gray-500">Loading stats…</p>
          ) : summaryValidating ? (
            <p className="mt-2 text-[11px] text-gray-500">Updating…</p>
          ) : null}
        </div>
        <LiveRefreshIndicator lastUpdatedAt={lastUpdatedAt} className="shrink-0 sm:pt-1" />
      </motion.header>

      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="mt-5 sm:mt-6"
      >
        {loadingStats ? (
          <StatsSectionSkeleton card={CARD} />
        ) : (
          <div className="space-y-2.5 sm:space-y-3">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4 sm:gap-3">
              <StatPill
                cardClassName={CARD}
                label="Direct team (A)"
                value={referralStatsReady ? directCount : "—"}
                accent="text-emerald-200"
              />
              <StatPill
                cardClassName={CARD}
                label="Total team"
                value={referralStatsReady ? teamCount : "—"}
                accent="text-sky-200"
              />
              <StatPill
                cardClassName={CARD}
                label="Team ROI income"
                value={referralStatsReady ? `$${teamRoiIncome.toFixed(2)}` : "—"}
                accent="text-violet-200"
                isCurrency
              />
              <StatPill
                cardClassName={CARD}
                label="First deposit bonus"
                value={referralStatsReady ? `$${firstDepositBonusEarned.toFixed(2)}` : "—"}
                accent="text-lime-200"
                isCurrency
              />
            </div>
            <StatPill
              cardClassName={CARD}
              label="Total referral rewards"
              subtitle="Team ROI income + first deposit bonus + legacy referral ledger lines"
              value={referralStatsReady ? `$${referralIncomeTotal.toFixed(2)}` : "—"}
              accent="text-green-400"
              isCurrency
            />
          </div>
        )}
      </motion.section>

      {!loadingPage && (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: "easeOut" }} className="mt-4">
        <Link href="/team/salary" className="block w-full">
          <button
            type="button"
            className="w-full rounded-2xl border border-emerald-500/30 bg-emerald-600/90 py-3 text-sm font-semibold text-white transition duration-300 ease-out hover:scale-[1.01] hover:bg-emerald-500"
          >
            Team Salary
          </button>
        </Link>
      </motion.div>
      )}

      <motion.section
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22 }}
        className={`mt-5 p-3 transition duration-300 sm:mt-6 sm:p-4 ${CARD}`}
      >
        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-400">Members</p>
          {referralStatsReady ? (
            <span className="text-[10px] text-gray-500">{teamCount} in network</span>
          ) : (
            <span className="text-[10px] text-gray-500">—</span>
          )}
        </div>

        <MembersMessage
          teamCount={teamCount}
          referralStatsReady={referralStatsReady}
          members={members}
          membersReady={membersReady}
          loadingMembers={loadingMembers}
          filteredMembers={filteredMembers}
          totalBalance={totalBalance}
          search={search}
          setSearch={setSearch}
          lastSalaryClaimAt={lastSalaryClaimAt}
          referralCode={referralCode}
          notifyToast={notifyToast}
          membersHasMore={membersHasMore}
          loadingMoreMembers={loadingMoreMembers}
          onLoadMoreMembers={onLoadMoreMembers}
        />
      </motion.section>
    </div>
  );
}

function StatPill({
  label,
  subtitle,
  value,
  accent,
  isCurrency,
  cardClassName,
}: {
  label: string;
  subtitle?: string;
  value: number | string;
  accent: string;
  isCurrency?: boolean;
  cardClassName: string;
}) {
  return (
    <div
      className={`${cardClassName} px-3 py-3 text-center transition duration-300 hover:scale-[1.02]`}
    >
      <p className="text-[10px] text-gray-400 sm:text-xs">{label}</p>
      {subtitle ? (
        <p className="mt-0.5 text-[9px] leading-snug text-gray-500 sm:text-[10px]">{subtitle}</p>
      ) : null}
      <p
        className={`mt-1 font-bold tabular-nums sm:text-xl ${accent} ${isCurrency ? "text-base sm:text-lg" : "text-lg"}`}
      >
        {value}
      </p>
    </div>
  );
}

function MembersMessage({
  teamCount,
  referralStatsReady,
  members,
  membersReady,
  loadingMembers,
  filteredMembers,
  totalBalance,
  search,
  setSearch,
  lastSalaryClaimAt,
  referralCode,
  notifyToast,
  membersHasMore,
  loadingMoreMembers,
  onLoadMoreMembers,
}: {
  teamCount: number;
  referralStatsReady: boolean;
  members: TeamMemberRow[];
  membersReady: boolean;
  loadingMembers: boolean;
  filteredMembers: TeamMemberRow[];
  totalBalance: number;
  search: string;
  setSearch: (v: string) => void;
  lastSalaryClaimAt: string | null;
  referralCode: string;
  notifyToast: (type: "success" | "error", message: string) => void;
  membersHasMore: boolean;
  loadingMoreMembers: boolean;
  onLoadMoreMembers: () => void;
}) {
  const levelCounts = useMemo(() => {
    const counts = { A: 0, B: 0, C: 0 };
    members.forEach((m) => {
      counts[m.level]++;
    });
    return counts;
  }, [members]);

  if (loadingMembers) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-xl bg-white/5" />
        ))}
      </div>
    );
  }

  if (!referralStatsReady || !membersReady) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-black/25 px-3 py-8 text-center">
        <p className="text-sm text-gray-500">Loading team information…</p>
      </div>
    );
  }

  if (!loadingMembers && teamCount > 0 && members.length === 0) {
    return (
      <div className="text-center text-sm text-red-400">Failed to load team members</div>
    );
  }

  if (members.length > 0) {
    return (
      <div className="space-y-3">
        <div
          className={`rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5 text-[11px] font-semibold text-emerald-200/95 tabular-nums sm:text-sm`}
        >
          Total team balance (A–C): ${totalBalance.toFixed(2)}
        </div>

        <div className="flex flex-wrap gap-2">
          {(
            [
              { k: "A" as const, cls: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200" },
              { k: "B" as const, cls: "border-sky-400/40 bg-sky-500/10 text-sky-200" },
              { k: "C" as const, cls: "border-violet-400/40 bg-violet-500/10 text-violet-200" },
            ] as const
          ).map(({ k, cls }) => (
            <span
              key={k}
              className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold tabular-nums ${cls}`}
            >
              Level {k}: {levelCounts[k]}
            </span>
          ))}
        </div>

        <input
          type="search"
          placeholder="Search username…"
          className="mb-1 w-full rounded-2xl border border-white/10 bg-white/5 py-2.5 pl-3 pr-3 text-sm text-white shadow-none backdrop-blur-xl placeholder:text-gray-500 outline-none transition duration-300 focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/30"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
        />

        <div className="max-h-[min(420px,55vh)] space-y-2 overflow-y-auto overflow-x-hidden pr-1 sm:space-y-2.5">
          {filteredMembers.length === 0 ? (
            <p className="py-4 text-center text-sm text-gray-500">No usernames match your search.</p>
          ) : (
            filteredMembers.map((userRow) => (
              <div
                key={userRow.id ?? `${userRow.username}-${userRow.level}`}
                className="flex items-center justify-between gap-2 rounded-2xl border border-white/10 bg-white/5 p-3 backdrop-blur-xl transition duration-300 hover:scale-[1.02]"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-white">
                    <span className="truncate">{userRow.username}</span>
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-bold ${
                        userRow.level === "A"
                          ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-200"
                          : userRow.level === "B"
                            ? "border-sky-400/50 bg-sky-500/15 text-sky-200"
                            : "border-violet-400/50 bg-violet-500/15 text-violet-200"
                      }`}
                    >
                      {userRow.level}
                    </span>
                    {isAfterClaim(userRow.joinedAt, lastSalaryClaimAt) ? (
                      <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-green-400">
                        New
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-[11px] text-gray-400">
                    Joined {userRow.joinedAt ? new Date(userRow.joinedAt).toLocaleDateString() : "—"}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-bold tabular-nums text-emerald-400 sm:text-base">
                    ${Number(userRow.balance).toFixed(2)}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
        {membersHasMore && (
          <div className="flex justify-center pt-1">
            <button
              type="button"
              onClick={onLoadMoreMembers}
              disabled={loadingMoreMembers || Boolean(search.trim())}
              className={`rounded-xl px-6 py-2.5 text-sm transition duration-300 ${
                loadingMoreMembers || search.trim()
                  ? "cursor-not-allowed text-gray-600"
                  : "text-gray-400 hover:text-gray-300 hover:scale-[1.02]"
              }`}
            >
              {loadingMoreMembers
                ? "Loading…"
                : search.trim()
                  ? "Clear search to load more"
                  : "Load more"}
            </button>
          </div>
        )}
      </div>
    );
  }

  if (teamCount === 0) {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const link = `${origin}/signup?ref=${encodeURIComponent(referralCode)}`;
    const copyReferral = async () => {
      if (!referralCode) {
        notifyToast("error", "Open Profile to copy your referral code");
        return;
      }
      try {
        await navigator.clipboard.writeText(link);
        notifyToast("success", "Referral link copied");
      } catch {
        notifyToast("error", "Could not copy link");
      }
    };
    return (
      <div className="rounded-xl border border-white/[0.06] bg-black/25 px-3 py-8 text-center">
        <p className="text-sm font-medium text-gray-300">No team members yet — share your referral link</p>
        <p className="mt-2 text-[11px] text-gray-500">Use My referral link on Profile to invite partners.</p>
        <button
          type="button"
          onClick={() => void copyReferral()}
          className="mt-5 w-full max-w-xs rounded-2xl border border-emerald-500/35 bg-emerald-500/15 py-3 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/25 active:scale-[0.99]"
        >
          Copy Referral Link
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/25 px-3 py-8 text-center">
      <p className="text-sm text-gray-400">Couldn&apos;t load member list</p>
      <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
        Stats above reflect your full network. This list covers levels A–C only and refreshes automatically.
      </p>
    </div>
  );
}
