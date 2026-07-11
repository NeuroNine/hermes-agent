import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CreditCard,
  DollarSign,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
  AnalyticsResponse,
  ModelsAnalyticsResponse,
  ProviderCostResponse,
  ProviderCostEntry,
} from "@/lib/api";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { usePageHeader } from "@/contexts/usePageHeader";
import { cn } from "@/lib/utils";

// ── Constants ──────────────────────────────────────────────────────────────

const MONITOR_DIR = "/home/neuronine/.hermes/scripts/.umans-monitor";
const UMANS_CAP = 200;
const UMANS_PLAN_COST = 20; // $20/mo Pro
const CLAUDE_CODE_COST = 20; // $20/mo Claude Code Pro

const PERIODS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

const CHART_HEIGHT_PX = 160;

// ── Types ──────────────────────────────────────────────────────────────────

interface UsageLogEntry {
  ts: string;
  requests: number;
  cap: number;
  concurrency: number;
  reset?: string;
  event?: string;
}

interface OpenRouterLogEntry {
  ts: string;
  balance: number;
  total_credits: number;
  total_usage: number;
  key_usage: number;
  key_usage_daily: number;
  key_usage_weekly: number;
  key_usage_monthly: number;
  key_limit: number;
  key_remaining: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return "$0.00";
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDate(day: string): string {
  try {
    const d = new Date(day + "T00:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return day;
  }
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortModel(name: string): string {
  return name.replace(/^(openrouter|anthropic|nous)\//, "");
}

// ── Data fetching ──────────────────────────────────────────────────────────

async function fetchUsageLog(): Promise<UsageLogEntry[]> {
  try {
    const resp = await fetch(
      `/api/fs/read-text?path=${encodeURIComponent(MONITOR_DIR + "/usage-log.jsonl")}`,
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.text) return [];
    const lines = data.text.trim().split("\n").filter(Boolean);
    const entries: UsageLogEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
    return entries;
  } catch {
    return [];
  }
}

async function fetchOpenRouterLog(): Promise<OpenRouterLogEntry[]> {
  try {
    const resp = await fetch(
      `/api/fs/read-text?path=${encodeURIComponent(MONITOR_DIR + "/openrouter-log.jsonl")}`,
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.text) return [];
    const lines = data.text.trim().split("\n").filter(Boolean);
    const entries: OpenRouterLogEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ── Provider Balance Card ─────────────────────────────────────────────────

function ProviderCard({ entry }: { entry: ProviderCostEntry }) {
  const isNous = entry.provider === "nous";
  const isOR = entry.provider === "openrouter";
  const accent = isNous ? "text-primary" : isOR ? "text-blue-400" : "text-muted-foreground";
  const Icon = isNous ? Zap : isOR ? CreditCard : Wallet;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon className={cn("w-4 h-4", accent)} />
            <span className="text-sm font-medium">{entry.label}</span>
          </div>
          {entry.plan && (
            <span className="text-[10px] text-muted-foreground capitalize">
              {entry.plan}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {!entry.logged_in ? (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <AlertCircle className="w-3 h-3" />
            <span>
              {entry.unavailable_reason || entry.error || "Not logged in"}
            </span>
          </div>
        ) : (
          <>
            {/* Usage windows (gauge bars) */}
            {entry.windows?.map((w, i) => (
              <div key={i} className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{w.label}</span>
                  {w.used_percent !== null && (
                    <span className="font-mono">
                      {w.used_percent.toFixed(0)}% used
                    </span>
                  )}
                </div>
                {w.used_percent !== null && (
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        w.used_percent > 80
                          ? "bg-destructive"
                          : w.used_percent > 50
                            ? "bg-amber-500"
                            : "bg-emerald-500",
                      )}
                      style={{ width: `${Math.min(100, w.used_percent)}%` }}
                    />
                  </div>
                )}
                {w.detail && (
                  <div className="text-[10px] text-muted-foreground">{w.detail}</div>
                )}
                {w.reset_at && (
                  <div className="text-[10px] text-muted-foreground">
                    Resets: {formatTime(w.reset_at)}
                  </div>
                )}
              </div>
            ))}

            {/* Balance lines for Nous credits */}
            {entry.balance_lines?.map((line, i) => (
              <div key={`bl-${i}`} className="text-muted-foreground">
                {line}
              </div>
            ))}

            {/* Details for OpenRouter */}
            {entry.details?.map((detail, i) => (
              <div key={`d-${i}`} className="text-muted-foreground">
                {detail}
              </div>
            ))}

            {entry.depleted && (
              <div className="flex items-center gap-1 text-destructive font-medium">
                <AlertCircle className="w-3 h-3" />
                Credits depleted — top up to restore
              </div>
            )}

            {entry.topup_url && (
              <a
                href={entry.topup_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <DollarSign className="w-3 h-3" />
                Top up
              </a>
            )}

            {entry.fetched_at && (
              <div className="text-[10px] text-muted-foreground pt-1 border-t border-border/30">
                Updated: {formatTime(entry.fetched_at)}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── umans Usage Mini-Chart ─────────────────────────────────────────────────

function UmansUsageChart({ entries }: { entries: UsageLogEntry[] }) {
  const data = useMemo(() => {
    const recent = entries.slice(-48);
    if (recent.length === 0) return { points: [], maxReq: 200 };
    const points = recent.map((e) => ({
      ts: e.ts,
      requests: e.requests,
      remaining: e.cap - e.requests,
      cap: e.cap,
      concurrency: e.concurrency,
    }));
    const maxReq = Math.max(...points.map((p) => p.requests), 100);
    return { points, maxReq: Math.ceil(maxReq / 50) * 50 };
  }, [entries]);

  if (data.points.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-6 text-center">
        No umans usage data. The usage logger cron job may not be running.
      </div>
    );
  }

  const chartWidth = 500;
  const chartHeight = 100;
  const padding = { top: 8, right: 8, bottom: 16, left: 30 };
  const plotW = chartWidth - padding.left - padding.right;
  const plotH = chartHeight - padding.top - padding.bottom;

  const xScale = (i: number) =>
    padding.left + (i / Math.max(data.points.length - 1, 1)) * plotW;
  const yScale = (val: number) =>
    padding.top + plotH - (val / data.maxReq) * plotH;

  const requestPath = data.points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(p.requests)}`)
    .join(" ");

  const lastEntry = data.points[data.points.length - 1];
  const pct = lastEntry.cap > 0 ? (lastEntry.requests / lastEntry.cap) * 100 : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4 flex-wrap text-xs">
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 bg-primary" />
          <span className="text-muted-foreground">Requests</span>
          <span className="font-medium text-foreground">
            {lastEntry.requests} / {lastEntry.cap}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 bg-emerald-500" />
          <span className="text-muted-foreground">Remaining</span>
          <span className="font-medium text-foreground">{lastEntry.remaining}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Zap className="w-3 h-3 text-muted-foreground" />
          <span className="text-muted-foreground">Concurrency</span>
          <span className="font-medium text-foreground">{lastEntry.concurrency}/5</span>
        </div>
        <span className="text-muted-foreground">{pct.toFixed(0)}% used</span>
        <span className="text-muted-foreground">Resets in {lastEntry.cap > 0 ? entries[entries.length - 1]?.reset || "—" : "—"}</span>
      </div>
      <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="w-full" style={{ maxHeight: "120px" }}>
        {[0, 50, 100, 150, 200].filter((v) => v <= data.maxReq).map((v) => (
          <g key={v}>
            <line
              x1={padding.left}
              y1={yScale(v)}
              x2={chartWidth - padding.right}
              y2={yScale(v)}
              stroke="currentColor"
              className="text-border"
              strokeWidth={0.5}
            />
            <text
              x={padding.left - 5}
              y={yScale(v) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[8px]"
            >
              {v}
            </text>
          </g>
        ))}
        <path d={requestPath} fill="none" stroke="currentColor" className="text-primary" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{formatTime(data.points[0]?.ts)}</span>
        <span>{formatTime(lastEntry.ts)}</span>
      </div>
    </div>
  );
}

// ── Daily Cost Chart ──────────────────────────────────────────────────────

function DailyCostChart({ daily }: { daily: AnalyticsResponse["daily"] }) {
  if (daily.length === 0) return null;

  const maxCost = Math.max(...daily.map((d) => d.estimated_cost || 0), 0.01);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <TrendingDown className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Daily Cost</CardTitle>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 bg-primary" />
            Estimated cost
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-[2px]" style={{ height: CHART_HEIGHT_PX }}>
          {daily.map((d) => {
            const cost = d.estimated_cost || 0;
            const h = Math.round((cost / maxCost) * CHART_HEIGHT_PX);
            return (
              <div
                key={d.day}
                className="flex-1 min-w-0 group relative flex flex-col justify-end"
                style={{ height: CHART_HEIGHT_PX }}
              >
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10 pointer-events-none">
                  <div className="bg-card border border-border px-2.5 py-1.5 text-xs text-foreground shadow-lg whitespace-nowrap">
                    <div className="font-medium">{formatDate(d.day)}</div>
                    <div>Cost: {formatCost(cost)}</div>
                    <div>Tokens: {formatTokens(d.input_tokens + d.output_tokens)}</div>
                    <div>Sessions: {d.sessions}</div>
                  </div>
                </div>
                <div
                  className="w-full rounded-t"
                  style={{
                    backgroundColor: "color-mix(in srgb, var(--color-primary) 70%, transparent)",
                    height: Math.max(h, cost > 0 ? 2 : 0),
                  }}
                />
              </div>
            );
          })}
        </div>
        <div className="flex justify-between mt-2 text-xs text-muted-foreground">
          <span>{daily.length > 0 ? formatDate(daily[0].day) : ""}</span>
          {daily.length > 2 && (
            <span>{formatDate(daily[Math.floor(daily.length / 2)].day)}</span>
          )}
          <span>{daily.length > 1 ? formatDate(daily[daily.length - 1].day) : ""}</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Cost by Model Table ───────────────────────────────────────────────────

function useTableSort<T>(data: T[], defaultKey: keyof T & string, defaultDir: "asc" | "desc" = "desc") {
  const [sortKey, setSortKey] = useState<string>(defaultKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultDir);

  const sorted = useMemo(() => {
    return [...data].sort((a, b) => {
      const aVal = a[sortKey as keyof T];
      const bVal = b[sortKey as keyof T];
      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;
      if (aVal === bVal) return 0;
      const cmp = aVal > bVal ? 1 : -1;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir]);

  const toggle = useCallback((key: string) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }, [sortKey]);

  return { sorted, sortKey, sortDir, toggle };
}

function SortHeader({ label, col, sortKey, sortDir, toggle, className }: {
  label: string;
  col: string;
  sortKey: string;
  sortDir: "asc" | "desc";
  toggle: (key: string) => void;
  className?: string;
}) {
  const active = col === sortKey;
  return (
    <th onClick={() => toggle(col)} className={`cursor-pointer select-none ${className ?? ""}`}>
      <span className="inline-flex items-center gap-1.5 rounded px-1 -mx-1 py-0.5 hover:bg-muted/40 transition-colors">
        {label}
        {active ? (
          sortDir === "asc" ? <ArrowUp className="h-3.5 w-3.5 text-foreground/80 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 text-foreground/80 shrink-0" />
        ) : (
          <ArrowUpDown className="h-3 w-3 text-text-tertiary shrink-0" />
        )}
      </span>
    </th>
  );
}

interface ModelCostRow {
  model: string;
  provider: string;
  estimated_cost: number;
  actual_cost: number;
  input_tokens: number;
  output_tokens: number;
  sessions: number;
  api_calls: number;
}

function CostByModelTable({ models }: { models: ModelCostRow[] }) {
  const { sorted, sortKey, sortDir, toggle } = useTableSort(models, "estimated_cost", "desc");

  if (models.length === 0) return null;
  const totalEst = models.reduce((s, m) => s + (m.estimated_cost || 0), 0);
  const totalActual = models.reduce((s, m) => s + (m.actual_cost || 0), 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Cost by Model</CardTitle>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>Total estimated: <span className="font-medium text-foreground">{formatCost(totalEst)}</span></span>
          {totalActual > 0 && (
            <span>Total actual: <span className="font-medium text-foreground">{formatCost(totalActual)}</span></span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground text-xs">
                <SortHeader label="Model" col="model" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-left py-2 pr-4 font-medium" />
                <SortHeader label="Provider" col="provider" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-left py-2 px-4 font-medium" />
                <SortHeader label="Est. Cost" col="estimated_cost" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-right py-2 px-4 font-medium" />
                <SortHeader label="Tokens" col="input_tokens" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-right py-2 px-4 font-medium" />
                <SortHeader label="Sessions" col="sessions" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-right py-2 pl-4 font-medium" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((m, i) => (
                <tr key={`${m.model}:${m.provider}:${i}`} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="py-2 pr-4">
                    <span className="font-mono text-xs">{shortModel(m.model)}</span>
                  </td>
                  <td className="py-2 px-4 text-muted-foreground text-xs">
                    {m.provider || "—"}
                  </td>
                  <td className="py-2 px-4 text-right font-mono">
                    {formatCost(m.estimated_cost || 0)}
                  </td>
                  <td className="py-2 px-4 text-right text-muted-foreground">
                    {formatTokens(m.input_tokens + m.output_tokens)}
                  </td>
                  <td className="py-2 pl-4 text-right text-muted-foreground">
                    {m.sessions}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── OpenRouter Spend Chart ──────────────────────────────────────────────────

function OpenRouterSpendChart({ entries }: { entries: OpenRouterLogEntry[] }) {
  const data = useMemo(() => {
    const recent = entries.slice(-96); // ~48h at 30-min intervals
    if (recent.length === 0) return { points: [], maxBal: 20, minBal: 0 };
    const points = recent.map((e) => ({
      ts: e.ts,
      balance: e.balance,
      total_usage: e.total_usage,
    }));
    const maxBal = Math.max(...points.map((p) => p.balance), 20);
    const minBal = Math.min(...points.map((p) => p.balance), 0);
    return { points, maxBal: Math.ceil(maxBal), minBal: Math.floor(minBal) };
  }, [entries]);

  if (data.points.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-6 text-center">
        No OpenRouter history yet. The logger cron job is collecting data — check back in 30 minutes.
      </div>
    );
  }

  const chartWidth = 500;
  const chartHeight = 120;
  const padding = { top: 8, right: 8, bottom: 16, left: 35 };
  const plotW = chartWidth - padding.left - padding.right;
  const plotH = chartHeight - padding.top - padding.bottom;

  const range = data.maxBal - data.minBal || 1;
  const xScale = (i: number) =>
    padding.left + (i / Math.max(data.points.length - 1, 1)) * plotW;
  const yScale = (val: number) =>
    padding.top + plotH - ((val - data.minBal) / range) * plotH;

  const balancePath = data.points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(p.balance)}`)
    .join(" ");

  const usagePath = data.points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(p.total_usage)}`)
    .join(" ");

  const last = data.points[data.points.length - 1];
  const first = data.points[0];
  const spendRate = last && first ? last.total_usage - first.total_usage : 0;
  const hoursSpan = last && first
    ? (new Date(last.ts).getTime() - new Date(first.ts).getTime()) / 3_600_000
    : 0;
  const dailyRate = hoursSpan > 0 ? (spendRate / hoursSpan) * 24 : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4 flex-wrap text-xs">
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 bg-blue-400" />
          <span className="text-muted-foreground">Balance</span>
          <span className="font-medium text-foreground">${last.balance.toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 bg-amber-500" />
          <span className="text-muted-foreground">Cumulative Spend</span>
          <span className="font-medium text-foreground">${last.total_usage.toFixed(2)}</span>
        </div>
        {dailyRate > 0 && (
          <div className="flex items-center gap-1.5">
            <TrendingDown className="w-3 h-3 text-muted-foreground" />
            <span className="text-muted-foreground">Rate</span>
            <span className="font-medium text-foreground">${dailyRate.toFixed(2)}/day</span>
          </div>
        )}
      </div>
      <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="w-full" style={{ maxHeight: "140px" }}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const val = data.minBal + range * frac;
          return (
            <g key={frac}>
              <line
                x1={padding.left}
                y1={yScale(val)}
                x2={chartWidth - padding.right}
                y2={yScale(val)}
                stroke="currentColor"
                className="text-border"
                strokeWidth={0.5}
              />
              <text
                x={padding.left - 5}
                y={yScale(val) + 3}
                textAnchor="end"
                className="fill-muted-foreground text-[8px]"
              >
                ${val.toFixed(0)}
              </text>
            </g>
          );
        })}
        {/* Balance line */}
        <path d={balancePath} fill="none" stroke="currentColor" className="text-blue-400" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        {/* Cumulative spend line */}
        <path d={usagePath} fill="none" stroke="currentColor" className="text-amber-500" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.8} />
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{formatTime(data.points[0]?.ts)}</span>
        <span>{formatTime(last.ts)}</span>
      </div>
      {dailyRate > 0 && (
        <div className="text-xs text-muted-foreground pt-1 border-t border-border/30">
          At current rate: ${dailyRate.toFixed(2)}/day → ~${(dailyRate * 30).toFixed(2)}/month
          {dailyRate * 30 > 20 && (
            <span className="text-amber-500 ml-2">
              ⚠ Exceeds Claude Code Pro ($20/mo) — consider shifting load
            </span>
          )}
          {dailyRate * 30 <= 20 && dailyRate > 0 && (
            <span className="text-emerald-500 ml-2">
              ✓ Under Claude Code Pro ($20/mo) — OpenRouter is cheaper
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Subscription Comparison ──────────────────────────────────────────────────

function SubscriptionComparison({
  umansUsage,
  orEntries,
  analytics,
  days,
}: {
  umansUsage: UsageLogEntry[];
  orEntries: OpenRouterLogEntry[];
  analytics: AnalyticsResponse | null;
  days: number;
}) {
  // umans: $20/mo, 200 req / 5hr window, effectively unlimited tokens
  const latestUmans = umansUsage[umansUsage.length - 1];
  const umansRequestsUsed = latestUmans?.requests ?? 0;
  const umansCap = latestUmans?.cap ?? 200;
  const umansPct = umansCap > 0 ? (umansRequestsUsed / umansCap) * 100 : 0;

  // OpenRouter: pay-per-token, tracked from log
  const latestOR = orEntries[orEntries.length - 1];
  const orBalance = latestOR?.balance ?? 0;
  const orSpent = latestOR?.total_usage ?? 0;

  // Hermes session cost (umans model, estimated)
  const hermesEstCost = analytics?.totals?.total_estimated_cost ?? 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Wallet className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Subscription Value Comparison</CardTitle>
        </div>
        <p className="text-xs text-muted-foreground">
          What you get for your money — {days}d window
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-3">
          {/* umans */}
          <div className="space-y-2 p-3 rounded-lg border border-border/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Zap className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">umans Pro</span>
              </div>
              <span className="text-lg font-bold">${UMANS_PLAN_COST}<span className="text-xs text-muted-foreground">/mo</span></span>
            </div>
            <div className="text-xs space-y-1 text-muted-foreground">
              <div className="flex justify-between">
                <span>Model</span>
                <span className="text-foreground">GLM-5.2</span>
              </div>
              <div className="flex justify-between">
                <span>Requests</span>
                <span className="text-foreground">{umansRequestsUsed}/{umansCap} per 5hr</span>
              </div>
              <div className="flex justify-between">
                <span>Tokens</span>
                <span className="text-foreground">Unlimited</span>
              </div>
              <div className="flex justify-between">
                <span>Window used</span>
                <span className="text-foreground">{umansPct.toFixed(0)}%</span>
              </div>
              <div className="flex justify-between">
                <span>Est. token value ({days}d)</span>
                <span className="text-foreground">{formatCost(hermesEstCost)}</span>
              </div>
            </div>
            {hermesEstCost > UMANS_PLAN_COST && (
              <div className="text-xs text-emerald-500 pt-1">
                ✓ {((hermesEstCost / UMANS_PLAN_COST)).toFixed(0)}x value vs pay-per-token
              </div>
            )}
          </div>

          {/* OpenRouter */}
          <div className="space-y-2 p-3 rounded-lg border border-border/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <CreditCard className="w-4 h-4 text-blue-400" />
                <span className="text-sm font-medium">OpenRouter</span>
              </div>
              <span className="text-lg font-bold">Pay/token</span>
            </div>
            <div className="text-xs space-y-1 text-muted-foreground">
              <div className="flex justify-between">
                <span>Models</span>
                <span className="text-foreground">300+ providers</span>
              </div>
              <div className="flex justify-between">
                <span>Balance</span>
                <span className="text-foreground">${orBalance.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Spent all-time</span>
                <span className="text-foreground">${orSpent.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Flexibility</span>
                <span className="text-foreground">Any model, any time</span>
              </div>
              <div className="flex justify-between">
                <span>Rate limits</span>
                <span className="text-foreground">None (pay-per-use)</span>
              </div>
            </div>
          </div>

          {/* Claude Code */}
          <div className="space-y-2 p-3 rounded-lg border border-border/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <CreditCard className="w-4 h-4 text-amber-500" />
                <span className="text-sm font-medium">Claude Code Pro</span>
              </div>
              <span className="text-lg font-bold">${CLAUDE_CODE_COST}<span className="text-xs text-muted-foreground">/mo</span></span>
            </div>
            <div className="text-xs space-y-1 text-muted-foreground">
              <div className="flex justify-between">
                <span>Model</span>
                <span className="text-foreground">Sonnet 4 / Opus 4</span>
              </div>
              <div className="flex justify-between">
                <span>Usage</span>
                <span className="text-foreground">Capped (5hr windows)</span>
              </div>
              <div className="flex justify-between">
                <span>Visibility</span>
                <span className="text-foreground">None in Hermes</span>
              </div>
              <div className="flex justify-between">
                <span>Best for</span>
                <span className="text-foreground">Complex multi-file edits</span>
              </div>
              <div className="flex justify-between">
                <span>Tracking</span>
                <span className="text-foreground">No data available</span>
              </div>
            </div>
            <div className="text-xs text-amber-500/70 pt-1">
              Runs outside Hermes — no session data logged
            </div>
          </div>
        </div>

        {/* Total monthly spend */}
        <div className="mt-4 pt-3 border-t border-border/30 flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Total monthly spend</span>
          <span className="text-lg font-bold">
            ${UMANS_PLAN_COST + CLAUDE_CODE_COST + orBalance > 0 ? UMANS_PLAN_COST + CLAUDE_CODE_COST : UMANS_PLAN_COST + CLAUDE_CODE_COST}
            <span className="text-xs text-muted-foreground">/mo subscriptions</span>
            {orSpent > 0 && (
              <span className="text-sm text-muted-foreground"> + ${orSpent.toFixed(2)} pay-per-token</span>
            )}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function CostPage() {
  const [days, setDays] = useState(30);
  const [providerCosts, setProviderCosts] = useState<ProviderCostResponse | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [modelsData, setModelsData] = useState<ModelsAnalyticsResponse | null>(null);
  const [umansUsage, setUmansUsage] = useState<UsageLogEntry[]>([]);
  const [orLog, setOrLog] = useState<OpenRouterLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { setAfterTitle, setEnd } = usePageHeader();

  const loadAll = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.getProviderCosts().catch(() => null),
      api.getAnalytics(days).catch(() => null),
      api.getModelsAnalytics(days).catch(() => null),
      fetchUsageLog(),
      fetchOpenRouterLog(),
    ])
      .then(([pc, an, ma, uu, or]) => {
        setProviderCosts(pc);
        setAnalytics(an);
        setModelsData(ma);
        setUmansUsage(uu);
        setOrLog(or);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Auto-refresh provider balances every 60s
  useEffect(() => {
    const interval = setInterval(() => {
      api.getProviderCosts().then(setProviderCosts).catch(() => {});
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setAfterTitle(
      <div className="flex flex-wrap items-center gap-1.5">
        {PERIODS.map((p) => (
          <Button
            key={p.label}
            type="button"
            size="sm"
            outlined={days !== p.days}
            onClick={() => setDays(p.days)}
          >
            {p.label}
          </Button>
        ))}
        <Button
          type="button"
          ghost
          size="icon"
          className="text-muted-foreground hover:text-foreground"
          onClick={loadAll}
          disabled={loading}
          aria-label="Refresh"
        >
          {loading ? <Spinner /> : <RefreshCw />}
        </Button>
      </div>,
    );
    setEnd(null);
    return () => {
      setAfterTitle(null);
      setEnd(null);
    };
  }, [days, loading, loadAll, setAfterTitle, setEnd]);

  // ── Derived stats ──────────────────────────────────────────────────────

  const totalEstCost = analytics?.totals?.total_estimated_cost ?? 0;
  const totalActualCost = analytics?.totals?.total_actual_cost ?? 0;
  const totalTokens = (analytics?.totals?.total_input ?? 0) + (analytics?.totals?.total_output ?? 0);
  const totalSessions = analytics?.totals?.total_sessions ?? 0;
  const dailyAvgCost = analytics?.daily?.length ? totalEstCost / analytics.daily.length : 0;
  const monthlyProjection = dailyAvgCost * 30;

  const latestUmans = umansUsage[umansUsage.length - 1];
  const umansPct = latestUmans && latestUmans.cap > 0
    ? (latestUmans.requests / latestUmans.cap) * 100
    : 0;

  const modelCostRows: ModelCostRow[] = useMemo(() => {
    if (!modelsData?.models) return [];
    return modelsData.models
      .map((m) => ({
        model: m.model,
        provider: m.provider,
        estimated_cost: m.estimated_cost || 0,
        actual_cost: m.actual_cost || 0,
        input_tokens: m.input_tokens || 0,
        output_tokens: m.output_tokens || 0,
        sessions: m.sessions || 0,
        api_calls: m.api_calls || 0,
      }))
      .filter((m) => m.estimated_cost > 0 || m.actual_cost > 0);
  }, [modelsData]);

  return (
    <div className="space-y-4 p-4 lg:p-6 max-w-7xl mx-auto">
      {/* Summary Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                Est. Cost ({days}d)
              </span>
            </div>
            <div className="text-2xl font-bold">{formatCost(totalEstCost)}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {totalActualCost > 0
                ? `Actual: ${formatCost(totalActualCost)}`
                : `${formatCost(dailyAvgCost)}/day avg`}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Monthly Projection</span>
            </div>
            <div className="text-2xl font-bold">{formatCost(monthlyProjection)}</div>
            <div className="text-xs text-muted-foreground mt-1">
              Based on {formatCost(dailyAvgCost)}/day
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Zap className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">umans Usage</span>
            </div>
            <div className="text-2xl font-bold">
              {latestUmans ? `${latestUmans.requests}` : "—"}
              <span className="text-sm text-muted-foreground font-normal">
                {" "}/ {latestUmans?.cap ?? UMANS_CAP}
              </span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {umansPct.toFixed(0)}% used · resets {latestUmans?.reset || "—"}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <CreditCard className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Fixed Subscriptions</span>
            </div>
            <div className="text-2xl font-bold">
              ${UMANS_PLAN_COST + CLAUDE_CODE_COST}
              <span className="text-sm text-muted-foreground font-normal">/mo</span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              umans Pro ${UMANS_PLAN_COST} + Claude Code ${CLAUDE_CODE_COST}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Provider Balances */}
      <div>
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <Wallet className="w-5 h-5" />
          Provider Balances
        </h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {providerCosts?.providers.map((p) => (
            <ProviderCard key={p.provider} entry={p} />
          )) ?? (
            <Card className="col-span-full">
              <CardContent className="py-6 text-center text-sm text-muted-foreground">
                {loading ? "Loading provider data..." : "No provider data available"}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* umans Usage Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5" />
            umans Request Usage
          </CardTitle>
        </CardHeader>
        <CardContent>
          <UmansUsageChart entries={umansUsage} />
        </CardContent>
      </Card>

      {/* OpenRouter Spend Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-blue-400" />
            OpenRouter Balance & Spend History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <OpenRouterSpendChart entries={orLog} />
        </CardContent>
      </Card>

      {/* Subscription Value Comparison */}
      <SubscriptionComparison
        umansUsage={umansUsage}
        orEntries={orLog}
        analytics={analytics}
        days={days}
      />

      {/* Daily Cost Chart */}
      {analytics?.daily && analytics.daily.length > 0 && (
        <DailyCostChart daily={analytics.daily} />
      )}

      {/* Cost by Model */}
      <CostByModelTable models={modelCostRows} />

      {/* Token Summary */}
      {analytics && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base">Token Summary ({days}d)</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Total Tokens</div>
                <div className="text-lg font-medium">{formatTokens(totalTokens)}</div>
                <div className="text-xs text-muted-foreground">
                  {formatTokens(analytics.totals.total_input ?? 0)} in /{" "}
                  {formatTokens(analytics.totals.total_output ?? 0)} out
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Sessions</div>
                <div className="text-lg font-medium">{totalSessions}</div>
                <div className="text-xs text-muted-foreground">
                  {days > 0 ? `${(totalSessions / days).toFixed(1)}/day` : ""}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Cache Read</div>
                <div className="text-lg font-medium">
                  {formatTokens(analytics.totals.total_cache_read ?? 0)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {analytics.totals.total_reasoning
                    ? `${formatTokens(analytics.totals.total_reasoning)} reasoning`
                    : ""}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <div className="text-sm text-destructive">Error loading cost data: {error}</div>
          </CardContent>
        </Card>
      )}

      {/* Loading */}
      {loading && !providerCosts && !analytics && (
        <div className="flex items-center justify-center py-24">
          <Spinner className="text-2xl text-primary" />
        </div>
      )}

      {/* No data */}
      {!loading && !analytics && !providerCosts && (
        <Card>
          <CardContent className="py-12">
            <div className="flex flex-col items-center text-muted-foreground">
              <Wallet className="h-8 w-8 mb-3 opacity-40" />
              <p className="text-sm font-medium">No cost data available</p>
              <p className="text-xs mt-1 text-text-tertiary">
                Cost data appears after you start using the agent with token analytics enabled.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
