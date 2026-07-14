import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Heart,
  RefreshCw,
  ShieldAlert,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import type { AiHealthEntry, AiHealthResponse } from "@/lib/api";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { usePageHeader } from "@/contexts/usePageHeader";
import { cn } from "@/lib/utils";

// ── Helpers ───────────────────────────────────────────────────────────────

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

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diffMs = d.getTime() - Date.now();
  const diffMin = Math.round(diffMs / 60_000);
  const abs = Math.abs(diffMin);
  if (abs < 1) return "now";
  if (abs < 60) return diffMin < 0 ? `${abs}m ago` : `in ${abs}m`;
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 24) return diffHr < 0 ? `${Math.abs(diffHr)}h ago` : `in ${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  return diffDay < 0 ? `${Math.abs(diffDay)}d ago` : `in ${diffDay}d`;
}

function severityIcon(sev: string) {
  switch (sev) {
    case "error":
      return XCircle;
    case "warning":
      return AlertTriangle;
    default:
      return Activity;
  }
}

function severityColor(sev: string): string {
  switch (sev) {
    case "error":
      return "text-destructive";
    case "warning":
      return "text-amber-500";
    default:
      return "text-muted-foreground";
  }
}

function severityTone(sev: string): "destructive" | "warning" | "secondary" {
  switch (sev) {
    case "error":
      return "destructive";
    case "warning":
      return "warning";
    default:
      return "secondary";
  }
}

// ── Entry Row ─────────────────────────────────────────────────────────────

function HealthEntryRow({
  entry,
  onResolve,
}: {
  entry: AiHealthEntry;
  onResolve: (timestamp: string) => void;
}) {
  const [resolving, setResolving] = useState(false);
  const Icon = severityIcon(entry.severity);
  const isOpen = entry.status === "open";

  return (
    <div
      className={cn(
        "border border-border/50 rounded-md px-3 py-2.5 space-y-1.5",
        isOpen && "border-l-2",
        isOpen && entry.severity === "error" && "border-l-destructive",
        isOpen && entry.severity === "warning" && "border-l-amber-500",
        isOpen && entry.severity === "info" && "border-l-border",
        !isOpen && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon className={cn("h-4 w-4 shrink-0 mt-0.5", severityColor(entry.severity))} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={severityTone(entry.severity)} className="text-[10px]">
              {entry.severity}
            </Badge>
            <span className="text-xs font-medium font-mono">{entry.tool}</span>
            {isOpen ? (
              <Badge tone="outline" className="text-[10px]">open</Badge>
            ) : (
              <Badge tone="success" className="text-[10px]">resolved</Badge>
            )}
            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
              {formatTime(entry.timestamp)} ({formatRelative(entry.timestamp)})
            </span>
          </div>
          <p className="text-xs text-foreground">{entry.description}</p>
          {entry.context && (
            <p className="text-[10px] text-muted-foreground">
              <span className="text-text-tertiary">Context: </span>
              {entry.context}
            </p>
          )}
          {entry.resolved_at && (
            <p className="text-[10px] text-emerald-500/80">
              Resolved {formatRelative(entry.resolved_at)}
            </p>
          )}
          {isOpen && (
            <Button
              type="button"
              ghost
              size="sm"
              className="h-6 text-[10px] gap-1 mt-1"
              disabled={resolving}
              onClick={() => {
                setResolving(true);
                onResolve(entry.timestamp);
              }}
            >
              {resolving ? <Spinner className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
              Mark Resolved
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Summary Stat Card ─────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  iconClass,
}: {
  icon: typeof Heart;
  label: string;
  value: string | number;
  sub?: string;
  iconClass?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-2 mb-1">
          <Icon className={cn("w-4 h-4 text-muted-foreground", iconClass)} />
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        <div className="text-2xl font-bold">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function AiHealthPage() {
  const [data, setData] = useState<AiHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "resolved">("all");
  const { setAfterTitle, setEnd } = usePageHeader();

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getAiHealth(200, statusFilter)
      .then(setData)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setAfterTitle(
      <Button
        type="button"
        ghost
        size="icon"
        className="text-muted-foreground hover:text-foreground"
        onClick={load}
        disabled={loading}
        aria-label="Refresh"
      >
        {loading ? <Spinner /> : <RefreshCw />}
      </Button>,
    );
    setEnd(null);
    return () => {
      setAfterTitle(null);
      setEnd(null);
    };
  }, [loading, load, setAfterTitle, setEnd]);

  const handleResolve = useCallback(
    (timestamp: string) => {
      api
        .resolveAiHealthEntry(timestamp)
        .then(() => load())
        .catch((err) => setError(String(err)));
    },
    [load],
  );

  const summary = data?.summary;
  const entries = data?.entries ?? [];
  const openCount = summary?.open ?? 0;
  const errorCount = summary?.by_severity?.error ?? 0;
  const warningCount = summary?.by_severity?.warning ?? 0;

  // Top affected tools
  const topTools = useMemo(() => {
    if (!summary?.by_tool) return [];
    return Object.entries(summary.by_tool)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [summary]);

  return (
    <div className="space-y-4 p-4 lg:p-6 max-w-7xl mx-auto">
      {/* Summary Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={ShieldAlert}
          label="Open Issues"
          value={openCount}
          sub={openCount === 0 ? "All clear" : "Needs attention"}
          iconClass={openCount > 0 ? "text-amber-500" : "text-emerald-500"}
        />
        <StatCard
          icon={XCircle}
          label="Errors"
          value={errorCount}
          sub={errorCount > 0 ? "Investigate" : "None logged"}
          iconClass={errorCount > 0 ? "text-destructive" : ""}
        />
        <StatCard
          icon={AlertTriangle}
          label="Warnings"
          value={warningCount}
          sub={warningCount > 0 ? "Monitor" : "None logged"}
          iconClass={warningCount > 0 ? "text-amber-500" : ""}
        />
        <StatCard
          icon={CheckCircle2}
          label="Resolved"
          value={summary?.resolved ?? 0}
          sub={`of ${summary?.total ?? 0} total`}
          iconClass="text-emerald-500"
        />
      </div>

      {/* Top Affected Tools */}
      {topTools.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Most Affected Tools</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {topTools.map(([tool, count]) => (
                <Badge key={tool} tone="outline" className="text-xs gap-1">
                  <span className="font-mono">{tool}</span>
                  <span className="text-muted-foreground">×{count}</span>
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filter Buttons */}
      <div className="flex items-center gap-2">
        {(["all", "open", "resolved"] as const).map((f) => (
          <Button
            key={f}
            type="button"
            ghost
            size="sm"
            className={cn(
              "text-xs capitalize",
              statusFilter === f && "bg-primary text-primary-foreground",
            )}
            onClick={() => setStatusFilter(f)}
          >
            {f}
          </Button>
        ))}
      </div>

      {/* Issue List */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Heart className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">AI Health Log</CardTitle>
            <span className="text-xs text-muted-foreground ml-auto">
              {entries.length} {entries.length === 1 ? "entry" : "entries"}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {error && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </div>
          )}
          {entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 gap-2">
              <Zap className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                {loading ? "Loading..." : "No issues logged. All systems nominal."}
              </p>
            </div>
          ) : (
            entries.map((entry) => (
              <HealthEntryRow key={entry.timestamp} entry={entry} onResolve={handleResolve} />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
