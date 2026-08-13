import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Activity,
  Clock,
  FileText,
  FlaskConical,
  Moon,
  RefreshCw,
  Telescope,
  TrendingUp,
  Zap,
} from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { usePageHeader } from "@/contexts/usePageHeader";
import { PluginSlot } from "@/plugins";
import { fetchJSON, api } from "@/lib/api";
import type { CronJob } from "@/lib/api";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────

interface FsListEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FsListResponse {
  entries: FsListEntry[];
  error?: string;
}

interface FsReadTextResponse {
  text: string;
  byteSize: number;
  truncated: boolean;
}

interface UsageLogEntry {
  ts: string;
  requests: number;
  cap: number;
  concurrency: number;
  reset?: string;
  event?: string;
  trigger?: number;
  remaining?: number;
}

interface ResearchBriefing {
  filename: string;
  path: string;
  date: string;
  content: string;
  size: number;
}

interface PollerState {
  triggerCount: number | null;
  lastTriggered: string | null;
  todoState: string | null;
}

const RESEARCH_DIR = "/home/neuronine/.hermes/research";
const MONITOR_DIR = "/home/neuronine/.hermes/scripts/.openrouter-monitor";

// Known research system cron job IDs (from SKILL.md)
const RESEARCH_CRON_IDS = [
  "6dc2a34f082c", // Usage Logger
  "7e7f288babae", // Overnight Poller
  "193a6b2b2f73", // Overnight Research
  "10f7001074e4", // Overnight Cleanup
  "ef373ebf25a7", // Weekly Profiler
  "2b96e49478b0", // Dreaming Session
];

const CRON_LABELS: Record<string, { label: string; icon: typeof Activity }> = {
  "6dc2a34f082c": { label: "Usage Logger", icon: TrendingUp },
  "7e7f288babae": { label: "Overnight Poller", icon: Moon },
  "193a6b2b2f73": { label: "Overnight Research", icon: Telescope },
  "10f7001074e4": { label: "Overnight Cleanup", icon: Clock },
  "ef373ebf25a7": { label: "Weekly Profiler", icon: Activity },
  "2b96e49478b0": { label: "Dreaming Session", icon: FlaskConical },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
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

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function extractDateFromFilename(filename: string): string {
  const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

// ── Data fetching ───────────────────────────────────────────────────────────

async function fetchResearchDir(): Promise<ResearchBriefing[]> {
  const resp = await fetchJSON<FsListResponse>(
    `/api/fs/list?path=${encodeURIComponent(RESEARCH_DIR)}`,
  );
  if (resp.error || !resp.entries) return [];

  const mdFiles = resp.entries.filter(
    (e) => !e.isDirectory && e.name.endsWith(".md"),
  );

  const briefings = await Promise.all(
    mdFiles.map(async (entry) => {
      try {
        const readResp = await fetchJSON<FsReadTextResponse>(
          `/api/fs/read-text?path=${encodeURIComponent(entry.path)}`,
        );
        return {
          filename: entry.name,
          path: entry.path,
          date: extractDateFromFilename(entry.name),
          content: readResp.text || "",
          size: readResp.byteSize || 0,
        } as ResearchBriefing;
      } catch {
        return {
          filename: entry.name,
          path: entry.path,
          date: extractDateFromFilename(entry.name),
          content: "(unable to read)",
          size: 0,
        } as ResearchBriefing;
      }
    }),
  );

  return briefings.sort((a, b) => b.date.localeCompare(a.date));
}

async function fetchUsageLog(): Promise<UsageLogEntry[]> {
  try {
    const resp = await fetchJSON<FsReadTextResponse>(
      `/api/fs/read-text?path=${encodeURIComponent(MONITOR_DIR + "/usage-log.jsonl")}`,
    );
    if (!resp.text) return [];
    const lines = resp.text.trim().split("\n").filter(Boolean);
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

async function fetchPollerState(): Promise<PollerState> {
  const today = todayStr();
  const state: PollerState = {
    triggerCount: null,
    lastTriggered: null,
    todoState: null,
  };

  // Try reading trigger count file
  try {
    const resp = await fetchJSON<FsReadTextResponse>(
      `/api/fs/read-text?path=${encodeURIComponent(MONITOR_DIR + "/research-count-" + today)}`,
    );
    state.triggerCount = parseInt(resp.text?.trim() || "0", 10) || 0;
  } catch {
    // file doesn't exist yet today
  }

  // Try reading triggered timestamp
  try {
    const resp = await fetchJSON<FsReadTextResponse>(
      `/api/fs/read-text?path=${encodeURIComponent(MONITOR_DIR + "/research-triggered-" + today)}`,
    );
    state.lastTriggered = resp.text?.trim() || null;
  } catch {
    // not triggered today
  }

  // Try reading todo state
  try {
    const resp = await fetchJSON<FsReadTextResponse>(
      `/api/fs/read-text?path=${encodeURIComponent(MONITOR_DIR + "/todo-state")}`,
    );
    state.todoState = resp.text?.trim() || null;
  } catch {
    // no state file
  }

  return state;
}

// ── Usage Chart Component ───────────────────────────────────────────────────

function UsageChart({ entries }: { entries: UsageLogEntry[] }) {
  const data = useMemo(() => {
    // Take last 48 entries (12 hours at 15-min intervals)
    const recent = entries.slice(-48);
    if (recent.length === 0) return { points: [], maxReq: 200, maxRemaining: 200 };

    const points = recent.map((e) => ({
      ts: e.ts,
      requests: e.requests,
      remaining: e.cap - e.requests,
      cap: e.cap,
      concurrency: e.concurrency,
      event: e.event,
    }));
    const maxReq = Math.max(...points.map((p) => p.requests), 100);
    return { points, maxReq: Math.ceil(maxReq / 50) * 50, maxRemaining: 200 };
  }, [entries]);

  if (data.points.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        No usage data available. The usage logger cron job may not be running.
      </div>
    );
  }

  const chartWidth = 600;
  const chartHeight = 140;
  const padding = { top: 10, right: 10, bottom: 20, left: 35 };
  const plotW = chartWidth - padding.left - padding.right;
  const plotH = chartHeight - padding.top - padding.bottom;

  const xScale = (i: number) =>
    padding.left + (i / Math.max(data.points.length - 1, 1)) * plotW;
  const yScale = (val: number) =>
    padding.top + plotH - (val / data.maxReq) * plotH;

  // Build path for requests line
  const requestPath = data.points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(p.requests)}`)
    .join(" ");

  // Build path for remaining line (scaled to same maxReq for visual comparison)
  const remainingPath = data.points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(p.remaining)}`)
    .join(" ");

  // Threshold line at 150 (poller trigger threshold: cap - 50 = 150)
  const thresholdY = yScale(150);

  const lastEntry = data.points[data.points.length - 1];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 flex-wrap text-xs">
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 bg-primary" />
          <span className="text-muted-foreground">Requests Used</span>
          <span className="font-medium text-foreground">{lastEntry.requests}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 bg-emerald-500" />
          <span className="text-muted-foreground">Remaining</span>
          <span className="font-medium text-foreground">{lastEntry.remaining}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 border-t border-dashed border-amber-500" />
          <span className="text-muted-foreground">Trigger Threshold (150)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Zap className="w-3 h-3 text-muted-foreground" />
          <span className="text-muted-foreground">Concurrency</span>
          <span className="font-medium text-foreground">{lastEntry.concurrency}/5</span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        className="w-full"
        style={{ maxHeight: "180px" }}
      >
        {/* Grid lines */}
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

        {/* Threshold line */}
        <line
          x1={padding.left}
          y1={thresholdY}
          x2={chartWidth - padding.right}
          y2={thresholdY}
          stroke="currentColor"
          className="text-amber-500"
          strokeWidth={1}
          strokeDasharray="4 3"
          opacity={0.6}
        />

        {/* Remaining area (light fill) */}
        <path
          d={`${remainingPath} L ${xScale(data.points.length - 1)} ${padding.top + plotH} L ${padding.left} ${padding.top + plotH} Z`}
          fill="currentColor"
          className="text-emerald-500"
          opacity={0.06}
        />

        {/* Requests line */}
        <path
          d={requestPath}
          fill="none"
          stroke="currentColor"
          className="text-primary"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Remaining line */}
        <path
          d={remainingPath}
          fill="none"
          stroke="currentColor"
          className="text-emerald-500"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={0.7}
        />

        {/* Event markers */}
        {data.points.map((p, i) =>
          p.event ? (
            <circle
              key={`evt-${i}`}
              cx={xScale(i)}
              cy={yScale(p.requests)}
              r={3}
              fill="currentColor"
              className={
                p.event.includes("pre-trigger")
                  ? "text-amber-500"
                  : p.event.includes("post-trigger")
                    ? "text-blue-500"
                    : "text-purple-500"
              }
            >
              <title>{`${p.event} at ${p.ts}`}</title>
            </circle>
          ) : null,
        )}
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{formatTime(data.points[0]?.ts)}</span>
        <span>{formatTime(lastEntry.ts)}</span>
      </div>
    </div>
  );
}

// ── Cron Job Card ───────────────────────────────────────────────────────────

function CronJobCard({ job }: { job: CronJob }) {
  const meta = CRON_LABELS[job.id];
  const Icon = meta?.icon ?? Clock;
  const isResearchJob = job.id === "193a6b2b2f73";
  const isPoller = job.id === "7e7f288babae";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium truncate">
              {meta?.label ?? job.name ?? job.id}
            </span>
          </div>
          <Badge
            tone={job.enabled ? "success" : "secondary"}
            className="text-[10px] shrink-0"
          >
            {job.enabled ? "Active" : "Paused"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5 text-xs">
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">Schedule</span>
          <span className="font-mono text-right truncate">
            {job.schedule_display || job.schedule?.display || job.schedule?.expr || "—"}
          </span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">Last Run</span>
          <span className="text-right">{formatTime(job.last_run_at)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">Next Run</span>
          <span className="text-right">{formatTime(job.next_run_at)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">Status</span>
          <span
            className={cn(
              "text-right",
              job.last_status === "ok" && "text-emerald-500",
              job.last_status === "error" && "text-destructive",
            )}
          >
            {job.last_status || "—"}
          </span>
        </div>
        {isResearchJob && (
          <div className="pt-1 text-muted-foreground italic">
            Jan 1 placeholder — only fires when triggered by the poller
          </div>
        )}
        {isPoller && (
          <div className="pt-1 text-muted-foreground italic">
            No-agent script — checks usage log, triggers research when budget available
          </div>
        )}
        {!job.no_agent && (
          <div className="pt-1 text-muted-foreground">
            {job.no_agent ? "Script only" : "Agent-driven"}
          </div>
        )}
        {job.no_agent && (
          <div className="pt-1 text-muted-foreground">
            Script only (zero token cost)
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function ResearchPage() {
  const [briefings, setBriefings] = useState<ResearchBriefing[]>([]);
  const [usageEntries, setUsageEntries] = useState<UsageLogEntry[]>([]);
  const [pollerState, setPollerState] = useState<PollerState | null>(null);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [selectedBriefing, setSelectedBriefing] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { setAfterTitle, setEnd } = usePageHeader();

  const fetchAll = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchResearchDir(),
      fetchUsageLog(),
      fetchPollerState(),
      api.getCronJobs("all").catch(() => [] as CronJob[]),
    ])
      .then(([briefs, usage, poller, jobs]) => {
        setBriefings(briefs);
        setUsageEntries(usage);
        setPollerState(poller);
        // Filter to known research system jobs
        setCronJobs(jobs.filter((j) => RESEARCH_CRON_IDS.includes(j.id)));
        // Auto-select the latest briefing
        if (briefs.length > 0 && !selectedBriefing) {
          setSelectedBriefing(briefs[0].filename);
        }
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [selectedBriefing]);

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh every 60s
  useEffect(() => {
    const interval = setInterval(fetchAll, 60_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  useEffect(() => {
    setAfterTitle(
      <span className="flex items-center gap-1.5">
        <Badge tone="secondary" className="text-xs">
          {briefings.length} briefing{briefings.length !== 1 ? "s" : ""}
        </Badge>
        <Button
          type="button"
          ghost
          size="icon"
          className="text-muted-foreground hover:text-foreground"
          onClick={fetchAll}
          disabled={loading}
          aria-label="Refresh"
        >
          {loading ? <Spinner /> : <RefreshCw />}
        </Button>
      </span>,
    );
    setEnd(null);
  }, [setAfterTitle, setEnd, briefings.length, loading, fetchAll]);

  const activeBriefing = useMemo(
    () => briefings.find((b) => b.filename === selectedBriefing) ?? briefings[0] ?? null,
    [briefings, selectedBriefing],
  );

  const latestUsage = usageEntries[usageEntries.length - 1];

  return (
    <div className="space-y-4 p-4 lg:p-6 max-w-7xl mx-auto">
      <PluginSlot name="research-page-top" />

      {/* System Overview */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Current Usage</span>
            </div>
            <div className="text-2xl font-bold">
              {latestUsage ? `${latestUsage.requests}` : "—"}
              <span className="text-sm text-muted-foreground font-normal">
                {" "}/ {latestUsage?.cap ?? 200}
              </span>
            </div>
            {latestUsage && (
              <div className="text-xs text-muted-foreground mt-1">
                {latestUsage.cap - latestUsage.requests} remaining · resets in{" "}
                {latestUsage.reset || "—"}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Moon className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Tonight's Triggers</span>
            </div>
            <div className="text-2xl font-bold">
              {pollerState?.triggerCount !== null
                ? `${pollerState?.triggerCount ?? 0}`
                : "0"}
              <span className="text-sm text-muted-foreground font-normal"> / 3</span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {pollerState?.lastTriggered
                ? `Last: ${formatTime(pollerState.lastTriggered)}`
                : "Not triggered tonight"}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <FileText className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Briefings</span>
            </div>
            <div className="text-2xl font-bold">{briefings.length}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {briefings[0]
                ? `Latest: ${briefings[0].date}`
                : "No briefings yet"}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Activity className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">System Jobs</span>
            </div>
            <div className="text-2xl font-bold">{cronJobs.length}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {cronJobs.filter((j) => j.enabled).length} active ·{" "}
              {cronJobs.filter((j) => !j.enabled).length} paused
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Usage Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5" />
            Usage History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <UsageChart entries={usageEntries} />
        </CardContent>
      </Card>

      {/* Cron Jobs Grid */}
      <div>
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <Clock className="w-5 h-5" />
          Research System Components
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cronJobs.map((job) => (
            <CronJobCard key={job.id} job={job} />
          ))}
          {cronJobs.length === 0 && !loading && (
            <Card className="col-span-full">
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No research system cron jobs found. Expected job IDs:{" "}
                {RESEARCH_CRON_IDS.join(", ")}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Research Briefings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Telescope className="w-5 h-5" />
            Research Briefings
          </CardTitle>
        </CardHeader>
        <CardContent>
          {briefings.length === 0 && !loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No research briefings found. Briefings are saved to{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                ~/.hermes/research/
              </code>{" "}
              after each overnight research run.
            </div>
          ) : briefings.length > 0 ? (
            <div className="space-y-3">
              {/* Briefing selector */}
              <div className="flex flex-wrap gap-2">
                {briefings.map((b) => (
                  <Button
                    key={b.filename}
                    size="sm"
                    ghost={activeBriefing?.filename !== b.filename}
                    onClick={() => setSelectedBriefing(b.filename)}
                    className="text-xs"
                  >
                    {b.date || b.filename}
                    <span className="ml-1.5 text-[10px] opacity-60">
                      {formatBytes(b.size)}
                    </span>
                  </Button>
                ))}
              </div>

              {/* Briefing content */}
              {activeBriefing && (
                <div className="border rounded-lg p-4 bg-muted/30 max-h-[600px] overflow-y-auto">
                  <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                    <FileText className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {activeBriefing.filename}
                    </span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {formatBytes(activeBriefing.size)}
                    </span>
                  </div>
                  <Markdown content={activeBriefing.content} />
                </div>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Poller State Detail */}
      {pollerState && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Moon className="w-5 h-5" />
              Poller State — {todayStr()}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground mb-1">
                  Trigger Count
                </div>
                <div className="text-lg font-medium">
                  {pollerState.triggerCount ?? 0} / 3
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">
                  Last Triggered
                </div>
                <div className="text-lg font-medium">
                  {formatTime(pollerState.lastTriggered)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">
                  Todo Queue State
                </div>
                <div className="text-lg font-medium capitalize">
                  {pollerState.todoState ?? "—"}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <div className="text-sm text-destructive">
              Error loading research data: {error}
            </div>
          </CardContent>
        </Card>
      )}

      <PluginSlot name="research-page-bottom" />
    </div>
  );
}
