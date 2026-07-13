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
import { api } from "@//lib/api";
import type {
  AnalyticsResponse,
  ModelsAnalyticsResponse,
  ProviderCostResponse,
  ProviderCostEntry,
} from "@//lib/api";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { usePageHeader } from "@//contexts/usePageHeader";
import { cn } from "@//lib/utils";

// ── Constants ──────────────────────────────────────────────────────────────

const MONITOR_DIR = "/home/neuronine/.hermes/scripts/.umans-monitor";
const UMANS_CAP = 200;
const UMANS_PLAN_COST = 20; // $20/mo Pro
const CLAUDE_CODE_COST = 20; // $20/mo Claude Code Pro

/**
 * Pricing rates — all per-million tokens.
 *
 * umans is a FLAT-FEE provider. The per-M rates below are what umans *would*
 * charge if they were pay-per-token. We use them to compute "token value"
 * — the equivalent pay-per-token cost of the tokens consumed.
 *
 * The OR comparison rates let the Commander see what the same tokens would
 * cost on OpenRouter using a comparable model.
 */
const UMANS_RATES: Record<string, { input: number; output: number }> = {
  "umans-glm-5.2": { input: 1.4, output: 4.4 },
  "umans-kimi-k2.7": { input: 0.95, output: 4.0 },
  "umans-coder": { input: 0.95, output: 4.0 },
  "umans-flash": { input: 0.15, output: 1.0 },
  "umans-qwen3.6-35b-a3b": { input: 0.15, output: 1.0 },
};
const UMANS_DEFAULT_RATES = { input: 1.4, output: 4.4 };

/** OpenRouter comparison rates for models in similar quality tiers. */
const OR_COMPARISON_MODELS = [
  { label: "Claude Sonnet 4", input: 3.0, output: 15.0 },
  { label: "DeepSeek V3", input: 0.2, output: 0.8 },
  { label: "GPT-4o", input: 2.5, output: 10.0 },
];

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

/** Compute token value: what would these tokens cost at given per-M rates? */
function tokenValue(
  inputTokens: number,
  outputTokens: number,
  rates: { input: number; output: number },
): number {
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

/** Get umans rates for a model, falling back to defaults. */
function getUmansRates(model: string): { input: number; output: number } {
  return UMANS_RATES[model] ?? UMANS_DEFAULT_RATES;
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
      reset: e.reset,
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

  const yScale = (val: number) =>
    padding.top + plotH - (val / data.maxReq) * plotH;
  const xScale = (i: number) =>
    padding.left + (i / Math.max(data.points.length - 1, 1)) * plotW;

  const requestPath = data.points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(p.requests)}`)
    .join(" ");

  const lastEntry = data.points[data.points.length - 1];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4 flex-wrap text-xs">
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 bg-primary" />
          <span className="text-muted-foreground">Requests</span>
          <span className="font-medium text-foreground">
            {lastEntry.requests}/{lastEntry.cap}
          </span>
        </div>
        {lastEntry.concurrency > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Concurrent:</span>
            <span className="font-medium text-foreground">{lastEntry.concurrency}</span>
          </div>
        )}
        {lastEntry.reset && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Resets in:</span>
            <span className="font-medium text-foreground">{lastEntry.reset}</span>
          </div>
        )}
      </div>
      <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="w-full" style={{ maxHeight: "120px" }}>
        {[0, 0.5, 1].map((frac) => {
          const v = Math.round(data.maxReq * frac);
          return (
            <g key={frac}>
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
          );
        })}
        <path d={requestPath} fill="none" stroke="currentColor" className="text-primary" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{formatTime(data.points[0]?.ts)}</span>
        <span>{formatTime(lastEntry.ts)}</span>
      </div>
    </div>
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
        <path d={balancePath} fill="none" stroke="currentColor" className="text-blue-400" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
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

// ── Daily Token Value Chart ─────────────────────────────────────────────────

function DailyTokenValueChart({
  daily,
  comparison,
}: {
  daily: AnalyticsResponse["daily"];
  comparison: { input: number; output: number; label: string };
}) {
  if (daily.length === 0) return null;

  // Compute token value per day at both umans rates and OR comparison rates
  const days = daily.map((d) => {
    const umansVal = tokenValue(d.input_tokens || 0, d.output_tokens || 0, UMANS_DEFAULT_RATES);
    const orVal = tokenValue(d.input_tokens || 0, d.output_tokens || 0, comparison);
    return { ...d, umansVal, orVal };
  });

  const maxVal = Math.max(...days.map((d) => Math.max(d.umansVal, d.orVal)), 0.01);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <TrendingDown className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Daily Token Value</CardTitle>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 bg-primary" />
            At umans rates
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 bg-amber-500" />
            At {comparison.label} rates (OR)
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-[2px]" style={{ height: CHART_HEIGHT_PX }}>
          {days.map((d) => {
            const umansH = Math.round((d.umansVal / maxVal) * CHART_HEIGHT_PX);
            const orH = Math.round((d.orVal / maxVal) * CHART_HEIGHT_PX);
            return (
              <div
                key={d.day}
                className="flex-1 min-w-0 group relative flex flex-col justify-end"
                style={{ height: CHART_HEIGHT_PX }}
              >
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10 pointer-events-none">
                  <div className="bg-card border border-border px-2.5 py-1.5 text-xs text-foreground shadow-lg whitespace-nowrap">
                    <div className="font-medium">{formatDate(d.day)}</div>
                    <div>umans value: {formatCost(d.umansVal)}</div>
                    <div>{comparison.label}: {formatCost(d.orVal)}</div>
                    <div>Tokens: {formatTokens(d.input_tokens + d.output_tokens)}</div>
                    <div>Sessions: {d.sessions}</div>
                  </div>
                </div>
                {/* OR comparison bar (behind, taller) */}
                <div
                  className="absolute bottom-0 left-0 right-0 rounded-t opacity-40"
                  style={{
                    backgroundColor: "var(--color-amber-500, #f59e0b)",
                    height: Math.max(orH, d.orVal > 0 ? 2 : 0),
                  }}
                />
                {/* umans value bar (in front) */}
                <div
                  className="w-full rounded-t relative z-10"
                  style={{
                    backgroundColor: "color-mix(in srgb, var(--color-primary) 70%, transparent)",
                    height: Math.max(umansH, d.umansVal > 0 ? 2 : 0),
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

// ── Model Value Table ─────────────────────────────────────────────────────

interface ModelValueRow {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  sessions: number;
  api_calls: number;
  umansValue: number;
  orValue: number;
}

function ModelValueTable({
  models,
  comparison,
}: {
  models: ModelValueRow[];
  comparison: { input: number; output: number; label: string };
}) {
  const { sorted, sortKey, sortDir, toggle } = useTableSort(models, "umansValue", "desc");

  if (models.length === 0) return null;
  const totalUmans = models.reduce((s, m) => s + m.umansValue, 0);
  const totalOR = models.reduce((s, m) => s + m.orValue, 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Token Value by Model</CardTitle>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>Total at umans rates: <span className="font-medium text-foreground">{formatCost(totalUmans)}</span></span>
          <span>Total at {comparison.label}: <span className="font-medium text-foreground">{formatCost(totalOR)}</span></span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground text-xs">
                <SortHeader label="Model" col="model" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-left py-2 pr-4 font-medium" />
                <SortHeader label="Tokens" col="input_tokens" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-right py-2 px-4 font-medium" />
                <SortHeader label="umans Value" col="umansValue" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-right py-2 px-4 font-medium" />
                <SortHeader label={`${comparison.label} (OR)`} col="orValue" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-right py-2 px-4 font-medium" />
                <SortHeader label="Sessions" col="sessions" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-right py-2 pl-4 font-medium" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((m, i) => (
                <tr key={`${m.model}:${m.provider}:${i}`} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="py-2 pr-4">
                    <span className="font-mono text-xs">{shortModel(m.model)}</span>
                  </td>
                  <td className="py-2 px-4 text-right text-muted-foreground">
                    {formatTokens(m.input_tokens + m.output_tokens)}
                    <span className="text-[10px] block text-text-tertiary">
                      {formatTokens(m.input_tokens)} in / {formatTokens(m.output_tokens)} out
                    </span>
                  </td>
                  <td className="py-2 px-4 text-right font-mono">
                    {formatCost(m.umansValue)}
                  </td>
                  <td className="py-2 px-4 text-right font-mono text-amber-500/80">
                    {formatCost(m.orValue)}
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

// ── Subscription Value Comparison ──────────────────────────────────────────

function SubscriptionComparison({
  umansUsage,
  orEntries,
  umansValue,
  orValue,
  comparison,
  days,
}: {
  umansUsage: UsageLogEntry[];
  orEntries: OpenRouterLogEntry[];
  umansValue: number;
  orValue: number;
  comparison: { input: number; output: number; label: string };
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

  // Value ratio: how many times the subscription cost are we getting in tokens?
  const valueRatio = umansValue > 0 ? umansValue / (UMANS_PLAN_COST / 30 * days) : 0;
  const orValueRatio = orValue > 0 ? orValue / (UMANS_PLAN_COST / 30 * days) : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Wallet className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Subscription Value</CardTitle>
        </div>
        <p className="text-xs text-muted-foreground">
          What {formatCost(umansValue)} in tokens gets you for $20/mo — {days}d window
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
                <span>Token value ({days}d)</span>
                <span className="text-foreground font-medium">{formatCost(umansValue)}</span>
              </div>
            </div>
            {valueRatio > 1 && (
              <div className="text-xs text-emerald-500 pt-1">
                ✓ {valueRatio.toFixed(1)}x value vs flat fee
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
                <span>Same tokens would cost</span>
                <span className="text-foreground font-medium">{formatCost(orValue)}</span>
              </div>
              <div className="flex justify-between">
                <span>vs umans flat fee</span>
                <span className={cn("font-medium", orValue > UMANS_PLAN_COST ? "text-emerald-500" : "text-amber-500")}>
                  {orValue > UMANS_PLAN_COST
                    ? `Save ${formatCost(orValue - UMANS_PLAN_COST)}`
                    : `OR cheaper by ${formatCost(UMANS_PLAN_COST - orValue)}`}
                </span>
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
                <span className="text-foreground">Sonnet 4.6</span>
              </div>
              <div className="flex justify-between">
                <span>Usage</span>
                <span className="text-foreground">Unlimited</span>
              </div>
              <div className="flex justify-between">
                <span>Flexibility</span>
                <span className="text-foreground">CLI only</span>
              </div>
              <div className="flex justify-between">
                <span>Best for</span>
                <span className="text-foreground">Deep coding</span>
              </div>
              <div className="flex justify-between">
                <span>Runs outside HELM</span>
                <span className="text-foreground">No session data</span>
              </div>
            </div>
          </div>
        </div>

        {/* Value summary banner */}
        {umansValue > 0 && (
          <div className="mt-4 p-3 rounded-lg bg-secondary/30 border border-border/30">
            <div className="text-sm">
              <span className="text-muted-foreground">In {days} days, your tokens were worth </span>
              <span className="font-bold text-foreground">{formatCost(umansValue)}</span>
              <span className="text-muted-foreground"> at umans rates, or </span>
              <span className="font-bold text-amber-500">{formatCost(orValue)}</span>
              <span className="text-muted-foreground"> at {comparison.label} rates on OpenRouter.</span>
              {orValueRatio > 1 && (
                <span className="text-emerald-500 font-medium">
                  {" "}— {orValueRatio.toFixed(1)}x your monthly subscription.
                </span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Sort hook ──────────────────────────────────────────────────────────────

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

// ── Main Page Component ───────────────────────────────────────────────────

export default function CostPage() {
  const [days, setDays] = useState(7);
  const [providerCosts, setProviderCosts] = useState<ProviderCostResponse | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [modelsData, setModelsData] = useState<ModelsAnalyticsResponse | null>(null);
  const [umansUsage, setUmansUsage] = useState<UsageLogEntry[]>([]);
  const [orLog, setOrLog] = useState<OpenRouterLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [comparisonIdx, setComparisonIdx] = useState(0);
  const { setAfterTitle, setEnd } = usePageHeader();

  const comparison = OR_COMPARISON_MODELS[comparisonIdx];

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

  // ── Derived stats (computed from actual token counts, not DB estimated_cost) ──

  const totalInput = analytics?.totals?.total_input ?? 0;
  const totalOutput = analytics?.totals?.total_output ?? 0;
  const totalTokens = totalInput + totalOutput;
  const totalSessions = analytics?.totals?.total_sessions ?? 0;

  // Token value: what would these tokens cost at umans' per-M rates?
  const umansTokenValue = tokenValue(totalInput, totalOutput, UMANS_DEFAULT_RATES);

  // OR equivalent: what would these tokens cost on OpenRouter?
  const orEquivalent = tokenValue(totalInput, totalOutput, comparison);

  // Daily average (based on umans token value)
  const dailyAvgValue = analytics?.daily?.length ? umansTokenValue / analytics.daily.length : 0;

  // Value ratio: how many times the subscription cost?
  const subscriptionCostPerDay = UMANS_PLAN_COST / 30;
  const valueRatio = dailyAvgValue > 0 ? dailyAvgValue / subscriptionCostPerDay : 0;

  const latestUmans = umansUsage[umansUsage.length - 1];
  const umansPct = latestUmans && latestUmans.cap > 0
    ? (latestUmans.requests / latestUmans.cap) * 100
    : 0;

  // Model value rows: compute per-model token value
  const modelValueRows: ModelValueRow[] = useMemo(() => {
    if (!modelsData?.models) return [];
    return modelsData.models
      .filter((m) => (m.input_tokens || 0) + (m.output_tokens || 0) > 0)
      .map((m) => {
        const rates = getUmansRates(m.model);
        return {
          model: m.model,
          provider: m.provider || "",
          input_tokens: m.input_tokens || 0,
          output_tokens: m.output_tokens || 0,
          sessions: m.sessions || 0,
          api_calls: m.api_calls || 0,
          umansValue: tokenValue(m.input_tokens || 0, m.output_tokens || 0, rates),
          orValue: tokenValue(m.input_tokens || 0, m.output_tokens || 0, comparison),
        };
      });
  }, [modelsData, comparison]);

  // Actual data days available (for honest display)
  const dataDays = analytics?.daily?.length ?? 0;

  return (
    <div className="space-y-4 p-4 lg:p-6 max-w-7xl mx-auto">
      {/* Summary Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Token Value */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Zap className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground">
                Token Value ({days}d)
              </span>
            </div>
            <div className="text-2xl font-bold">{formatCost(umansTokenValue)}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {formatTokens(totalTokens)} tokens at umans rates
            </div>
          </CardContent>
        </Card>

        {/* OR Equivalent */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="w-4 h-4 text-amber-500" />
              <span className="text-xs text-muted-foreground">
                OR Equivalent ({comparison.label})
              </span>
            </div>
            <div className="text-2xl font-bold text-amber-500">{formatCost(orEquivalent)}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {valueRatio > 1
                ? `${valueRatio.toFixed(1)}x your $20/mo subscription`
                : `Below subscription value`}
            </div>
          </CardContent>
        </Card>

        {/* umans Usage */}
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

        {/* Fixed Subscriptions */}
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

      {/* Data availability notice */}
      {dataDays > 0 && dataDays < days && (
        <div className="text-xs text-muted-foreground italic">
          Showing {dataDays} days of available data (requested {days}d).
        </div>
      )}

      {/* Comparison model selector */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Compare against:</span>
        {OR_COMPARISON_MODELS.map((m, i) => (
          <Button
            key={m.label}
            type="button"
            size="sm"
            outlined={comparisonIdx !== i}
            onClick={() => setComparisonIdx(i)}
          >
            {m.label}
          </Button>
        ))}
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
            <CreditCard className="w-5 w-5 text-blue-400" />
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
        umansValue={umansTokenValue}
        orValue={orEquivalent}
        comparison={comparison}
        days={days}
      />

      {/* Daily Token Value Chart */}
      {analytics?.daily && analytics.daily.length > 0 && (
        <DailyTokenValueChart daily={analytics.daily} comparison={comparison} />
      )}

      {/* Model Value Table */}
      <ModelValueTable models={modelValueRows} comparison={comparison} />

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
