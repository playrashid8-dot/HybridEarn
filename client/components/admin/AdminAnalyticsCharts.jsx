"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const axisStyle = { fontSize: 11, fill: "#9ca3af" };
const tooltipStyle = {
  backgroundColor: "#1a1a24",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 12,
};

export default function AdminAnalyticsCharts({ depositSeries, withdrawSeries, growthSeries }) {
  const hasDeposit = depositSeries?.length > 0;
  const hasWithdraw = withdrawSeries?.length > 0;
  const hasGrowth = growthSeries?.length > 0;

  return (
    <div className="grid gap-4 lg:grid-cols-1 xl:grid-cols-3">
      <ChartCard title="Deposits (amount/day)" hint="Sum of on-chain deposit amounts">
        <div className="h-[260px] w-full min-w-0">
          {hasDeposit ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={depositSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="fillDep" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#a78bfa" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={false} />
                <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={44} />
                <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "#e5e7eb" }} />
                <Area
                  type="monotone"
                  dataKey="amount"
                  name="Amount"
                  stroke="#c4b5fd"
                  fill="url(#fillDep)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart label="Not enough deposit data for this range" />
          )}
        </div>
      </ChartCard>

      <ChartCard title="Withdrawals (net/day)" hint="Paid and pending movement by day">
        <div className="h-[260px] w-full min-w-0">
          {hasWithdraw ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={withdrawSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={false} />
                <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={44} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="net"
                  name="Net USDT"
                  stroke="#34d399"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  name="Count"
                  stroke="#fbbf24"
                  strokeWidth={1.5}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart label="Not enough withdrawal data for this range" />
          )}
        </div>
      </ChartCard>

      <ChartCard title="User growth (cumulative)" hint="Total users over time">
        <div className="h-[260px] w-full min-w-0">
          {hasGrowth ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={growthSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="fillGrowth" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={false} />
                <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Area
                  type="stepAfter"
                  dataKey="cumulative"
                  name="Users"
                  stroke="#7dd3fc"
                  fill="url(#fillGrowth)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart label="Not enough sign-up data for this range" />
          )}
        </div>
      </ChartCard>
    </div>
  );
}

function ChartCard({ title, hint, children }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      {hint ? <p className="mt-1 text-xs text-gray-500">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </div>
  );
}

function EmptyChart({ label }) {
  return (
    <div className="flex h-[260px] items-center justify-center text-center text-sm text-gray-500">
      {label}
    </div>
  );
}
