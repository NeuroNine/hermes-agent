import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  FileText,
  Moon,
  RefreshCw,
  Sparkles,
  UserCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
  BrainCheckpoint,
  BrainOverviewResponse,
  BrainFlatMemoryResponse,
} from "@/lib/api";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { usePageHeader } from "@/contexts/usePageHeader";
import { cn } from "@/lib/utils";

const RECENT_CHECKPOINTS_SHOWN = 5;

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

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return "$0.00";
}

function splitFlatMemoryEntries(content: string): string[] {
  return content
    .split(/\n§\n?/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function triggerTone(trigger: string): "secondary" | "success" | "warning" | "outline" {
  switch (trigger) {
    case "poller":
      return "secondary";
    case "session_end":
      return "success";
    case "compression":
      return "warning";
    default:
      return "outline";
  }
}

// ── Capacity Bar ─────────────────────────────────────────────────────────

function CapacityBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            pct > 90 ? "bg-destructive" : pct > 70 ? "bg-amber-500" : "bg-emerald-500",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-[10px] text-muted-foreground">
        {used.toLocaleString()} / {limit.toLocaleString()} chars ({pct.toFixed(0)}%)
      </div>
    </div>
  );
}

// ── Checkpoint Row (expandable) ─────────────────────────────────────────

function CheckpointRow({ checkpoint }: { checkpoint: BrainCheckpoint }) {
  const [expanded, setExpanded] = useState(false);
  const facts = checkpoint.facts;
  const factCount = facts
    ? (facts.entities?.length ?? 0) +
      (facts.decisions?.length ?? 0) +
      (facts.progress_markers?.length ?? 0) +
      (facts.file_states?.length ?? 0) +
      (facts.preferences?.length ?? 0) +
      (facts.unresolved_threads?.length ?? 0)
    : 0;

  return (
    <div className="border border-border/50 rounded-md">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-secondary/20 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={triggerTone(checkpoint.trigger)} className="text-[10px]">
              {checkpoint.trigger}
            </Badge>
            {checkpoint.session_title && (
              <span className="text-xs font-medium truncate">{checkpoint.session_title}</span>
            )}
            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
              {formatTime(checkpoint.created_at)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{checkpoint.summary}</p>
          {factCount > 0 && !expanded && (
            <span className="text-[10px] text-text-tertiary">{factCount} facts captured</span>
          )}
        </div>
      </button>

      {expanded && facts && (
        <div className="border-t border-border/50 px-3 py-2.5 space-y-2.5 text-xs">
          {facts.entities && facts.entities.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Entities</div>
              <ul className="space-y-0.5">
                {facts.entities.map((e, i) => (
                  <li key={i}>
                    <span className="font-medium">{e.name}</span>
                    {e.type && <span className="text-muted-foreground"> ({e.type})</span>}
                    {e.detail && <span className="text-muted-foreground"> — {e.detail}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {facts.decisions && facts.decisions.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Decisions</div>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                {facts.decisions.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          {facts.preferences && facts.preferences.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Preferences</div>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                {facts.preferences.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {facts.file_states && facts.file_states.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">File States</div>
              <ul className="space-y-0.5">
                {facts.file_states.map((f, i) => (
                  <li key={i}>
                    <span className="font-mono text-[11px]">{f.path}</span>
                    <span className="text-muted-foreground"> — {f.state}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {facts.unresolved_threads && facts.unresolved_threads.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Unresolved Threads</div>
              <ul className="list-disc list-inside space-y-0.5 text-amber-500/90">
                {facts.unresolved_threads.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          )}
          {facts.progress_markers && facts.progress_markers.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Progress Markers</div>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                {facts.progress_markers.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Flat Memory File Card ────────────────────────────────────────────────

function FlatMemoryCard({
  title,
  icon: Icon,
  entry,
}: {
  title: string;
  icon: typeof FileText;
  entry: { content: string; chars: number; limit: number } | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const entries = useMemo(() => splitFlatMemoryEntries(entry?.content ?? ""), [entry]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="w-full flex items-center justify-between gap-2 text-left"
        >
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">{title}</CardTitle>
            <span className="text-xs text-muted-foreground">({entries.length} entries)</span>
          </div>
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
        </button>
        {entry && <CapacityBar used={entry.chars} limit={entry.limit} />}
      </CardHeader>
      {expanded && (
        <CardContent className="pt-0">
          {entries.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No entries yet.</p>
          ) : (
            <ul className="space-y-2 text-xs">
              {entries.map((e, i) => (
                <li key={i} className="border-l-2 border-border pl-2.5 py-0.5 text-muted-foreground">
                  {e}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ── Poller / Dreaming Status Card ────────────────────────────────────────

function PollerStatusCard({ overview }: { overview: BrainOverviewResponse | null }) {
  const poller = overview?.poller;
  const stats = poller?.last_stats;
  const hasErrors = (stats?.errors ?? 0) > 0;
  const neverRun = !poller?.last_run;

  const StatusIcon = neverRun ? Clock : hasErrors ? AlertCircle : CheckCircle2;
  const statusColor = neverRun
    ? "text-muted-foreground"
    : hasErrors
      ? "text-amber-500"
      : "text-emerald-500";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Checkpoint Poller</CardTitle>
          <StatusIcon className={cn("h-4 w-4 ml-auto", statusColor)} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Last run</span>
          <span>{poller?.last_run ? `${formatTime(poller.last_run)} (${formatRelative(poller.last_run)})` : "never"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Next run</span>
          <span>{poller?.next_run ? formatRelative(poller.next_run) : "—"}</span>
        </div>
        {stats && (
          <>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Sessions seen</span>
              <span>{stats.sessions_seen ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Checkpointed</span>
              <span>{stats.checkpointed ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Skipped (idle / no-new)</span>
              <span>{stats.skipped_idle ?? 0} / {stats.skipped_no_new ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className={hasErrors ? "text-amber-500" : "text-muted-foreground"}>Errors</span>
              <span className={hasErrors ? "text-amber-500 font-medium" : ""}>{stats.errors ?? 0}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DreamingStatusCard({ overview }: { overview: BrainOverviewResponse | null }) {
  const dreaming = overview?.dreaming;
  const status = dreaming?.status ?? "never_run";
  const tone = status === "ok" ? "success" : status === "never_run" ? "outline" : "warning";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Moon className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Dreaming Consolidation</CardTitle>
          <Badge tone={tone} className="text-[10px] ml-auto">{status}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Last run</span>
          <span>{dreaming?.last_run ? `${formatTime(dreaming.last_run)} (${formatRelative(dreaming.last_run)})` : "never"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Next run</span>
          <span>{dreaming?.next_run ? formatRelative(dreaming.next_run) : "—"}</span>
        </div>
        <p className="text-[10px] text-muted-foreground pt-1 border-t border-border/30">
          Reviews the day's checkpoints and promotes durable facts to the fact store.
        </p>
      </CardContent>
    </Card>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function BrainPage() {
  const [overview, setOverview] = useState<BrainOverviewResponse | null>(null);
  const [checkpoints, setCheckpoints] = useState<BrainCheckpoint[]>([]);
  const [flatMemory, setFlatMemory] = useState<BrainFlatMemoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { setAfterTitle, setEnd } = usePageHeader();

  const loadAll = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.getBrainOverview(),
      api.getBrainCheckpoints(RECENT_CHECKPOINTS_SHOWN),
      api.getBrainFlatMemory(),
    ])
      .then(([ov, cp, fm]) => {
        setOverview(ov);
        setCheckpoints(cp.checkpoints);
        setFlatMemory(fm);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    setAfterTitle(
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
      </Button>,
    );
    setEnd(null);
    return () => {
      setAfterTitle(null);
      setEnd(null);
    };
  }, [loading, loadAll, setAfterTitle, setEnd]);

  return (
    <div className="space-y-4 p-4 lg:p-6 max-w-7xl mx-auto">
      {/* Overview Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Brain className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Checkpoints</span>
            </div>
            <div className="text-2xl font-bold">{overview?.checkpoints.total ?? "—"}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {overview ? `${overview.checkpoints.today} today · ${formatCost(overview.checkpoints.est_cost_usd)} est.` : ""}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Database className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Fact Store</span>
            </div>
            <div className="text-2xl font-bold">{overview?.fact_store.total_facts ?? "—"}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {overview ? `avg trust ${overview.fact_store.avg_trust.toFixed(2)}` : ""}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <FileText className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">L1 Memory</span>
            </div>
            {overview ? (
              <CapacityBar used={overview.flat_memory.memory_chars} limit={overview.flat_memory.memory_limit} />
            ) : (
              <div className="text-2xl font-bold">—</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <UserCircle className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">L1 User Profile</span>
            </div>
            {overview ? (
              <CapacityBar used={overview.flat_memory.user_chars} limit={overview.flat_memory.user_limit} />
            ) : (
              <div className="text-2xl font-bold">—</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent Checkpoints */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Recent Checkpoints</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {checkpoints.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {loading ? "Loading checkpoints..." : "No checkpoints yet."}
            </p>
          ) : (
            checkpoints.map((cp) => <CheckpointRow key={cp.id} checkpoint={cp} />)
          )}
        </CardContent>
      </Card>

      {/* Poller + Dreaming Status */}
      <div className="grid gap-4 md:grid-cols-2">
        <PollerStatusCard overview={overview} />
        <DreamingStatusCard overview={overview} />
      </div>

      {/* Flat Memory Contents */}
      <div className="grid gap-4 md:grid-cols-2">
        <FlatMemoryCard title="MEMORY.md" icon={FileText} entry={flatMemory?.memory} />
        <FlatMemoryCard title="USER.md" icon={UserCircle} entry={flatMemory?.user} />
      </div>

      {/* Error */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <div className="text-sm text-destructive">Error loading brain data: {error}</div>
          </CardContent>
        </Card>
      )}

      {/* Loading */}
      {loading && !overview && (
        <div className="flex items-center justify-center py-24">
          <Spinner className="text-2xl text-primary" />
        </div>
      )}
    </div>
  );
}
