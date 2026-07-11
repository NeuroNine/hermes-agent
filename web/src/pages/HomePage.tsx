import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  Clock,
  Cpu,
  Database,
  HardDrive,
  MessageSquare,
  Radio,
  Server,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { H2 } from "@nous-research/ui/ui/components/typography/h2";
import { cn, timeAgo } from "@/lib/utils";
import { api } from "@/lib/api";
import type { StatusResponse, SystemStats, CronJob, SessionInfo } from "@/lib/api";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Relative time until a future ISO-8601 timestamp (e.g. a cron job's next run). */
function isoTimeUntil(iso: string): string {
  const delta = (new Date(iso).getTime() - Date.now()) / 1000;
  if (Number.isNaN(delta)) return "unknown";
  if (delta <= 0) return "due now";
  if (delta < 60) return "in <1m";
  if (delta < 3600) return `in ${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `in ${Math.floor(delta / 3600)}h`;
  return `in ${Math.floor(delta / 86400)}d`;
}

function Meter({ label, percent, icon: Icon }: { label: string; percent: number | undefined; icon: typeof Cpu }) {
  const pct = Math.max(0, Math.min(100, percent ?? 0));
  const tone = pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-success";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs uppercase tracking-wider text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5" /> {label}
        </span>
        <span className="font-mono text-foreground">
          {percent === undefined ? "—" : `${pct.toFixed(0)}%`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function HomePage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      api.getStatus(),
      api.getSystemStats(),
      api.getCronJobs(),
      api.getSessions(5),
    ]).then(([s, st, cj, se]) => {
      if (cancelled) return;
      if (s.status === "fulfilled") setStatus(s.value);
      if (st.status === "fulfilled") setStats(st.value);
      if (cj.status === "fulfilled") setCronJobs(cj.value);
      if (se.status === "fulfilled") setSessions(se.value.sessions);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="text-2xl text-primary" />
      </div>
    );
  }

  const gatewayRunning = status?.gateway_running;
  const platforms = Object.entries(status?.gateway_platforms ?? {});
  const enabledCronJobs = cronJobs.filter((j) => j.enabled);
  const erroredCronJobs = cronJobs.filter((j) => j.last_error);
  const nextCronJob = enabledCronJobs
    .filter((j) => j.next_run_at)
    .sort((a, b) => (a.next_run_at! < b.next_run_at! ? -1 : 1))[0];

  return (
    <div className="flex flex-col gap-8">
      {/* ── HELM status banner ───────────────────────────────────── */}
      <Card>
        <CardContent className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border",
                gatewayRunning
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-destructive/40 bg-destructive/10 text-destructive",
              )}
            >
              {gatewayRunning ? (
                <ShieldCheck className="h-5 w-5" />
              ) : (
                <ShieldAlert className="h-5 w-5" />
              )}
            </div>
            <div className="flex flex-col">
              <span className="font-sans text-display text-lg uppercase tracking-[0.08em]">
                HELM
              </span>
              <span className="text-sm text-muted-foreground">
                {gatewayRunning ? "Ship systems nominal" : "Anomaly detected"}
                {stats?.hostname ? ` · ${stats.hostname}` : ""}
                {typeof stats?.uptime_seconds === "number"
                  ? ` · up ${formatDuration(stats.uptime_seconds)}`
                  : ""}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={gatewayRunning ? "success" : "destructive"}>
              {gatewayRunning ? "running" : "stopped"}
            </Badge>
            {status?.version && (
              <span className="font-mono text-xs text-muted-foreground">
                v{status.version}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* ── System resources ───────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <H2 variant="sm" className="flex items-center gap-2 text-muted-foreground">
            <Server className="h-4 w-4" /> System Resources
          </H2>
          <Card>
            <CardContent className="flex flex-col gap-4 py-4">
              <Meter label="CPU" percent={stats?.cpu_percent} icon={Cpu} />
              <Meter label="Memory" percent={stats?.memory?.percent} icon={Database} />
              <Meter label="Disk" percent={stats?.disk?.percent} icon={HardDrive} />
              {stats?.memory && (
                <span className="text-xs text-muted-foreground">
                  {formatBytes(stats.memory.used)} / {formatBytes(stats.memory.total)} memory used
                </span>
              )}
              {stats?.disk && (
                <span className="text-xs text-muted-foreground">
                  {formatBytes(stats.disk.used)} / {formatBytes(stats.disk.total)} disk used
                </span>
              )}
              {stats && !stats.psutil && (
                <p className="text-xs text-muted-foreground">
                  Install the <span className="font-mono">psutil</span> extra for
                  live CPU / memory / disk metrics.
                </p>
              )}
            </CardContent>
          </Card>
        </section>

        {/* ── Gateway status ──────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <H2 variant="sm" className="flex items-center gap-2 text-muted-foreground">
            <Radio className="h-4 w-4" /> Gateway Status
          </H2>
          <Card>
            <CardContent className="flex flex-col gap-3 py-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">State</span>
                <span className="flex items-center gap-2">
                  <Badge tone={gatewayRunning ? "success" : "secondary"}>
                    {status?.gateway_state ?? (gatewayRunning ? "running" : "stopped")}
                  </Badge>
                  {status?.gateway_pid && (
                    <span className="font-mono text-xs text-muted-foreground">
                      pid {status.gateway_pid}
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Active sessions</span>
                <span className="font-mono">{status?.active_sessions ?? 0}</span>
              </div>
              {platforms.length > 0 && (
                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  <span className="text-xs uppercase tracking-wider text-muted-foreground">
                    Platforms
                  </span>
                  {platforms.map(([name, p]) => (
                    <div key={name} className="flex items-center justify-between text-sm">
                      <span className="capitalize">{name}</span>
                      <Badge tone={p.state === "connected" ? "success" : "secondary"}>
                        {p.state}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
              {platforms.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No messaging platforms configured.{" "}
                  <Link to="/channels" className="underline">
                    Set one up →
                  </Link>
                </p>
              )}
            </CardContent>
          </Card>
        </section>

        {/* ── Cron jobs ───────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <H2 variant="sm" className="flex items-center gap-2 text-muted-foreground">
            <Clock className="h-4 w-4" /> Cron Jobs
          </H2>
          <Card>
            <CardContent className="flex flex-col gap-3 py-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Enabled</span>
                <span className="font-mono">
                  {enabledCronJobs.length} / {cronJobs.length}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Next run</span>
                <span className="font-mono text-xs">
                  {nextCronJob?.next_run_at
                    ? isoTimeUntil(nextCronJob.next_run_at)
                    : "—"}
                </span>
              </div>
              {erroredCronJobs.length > 0 ? (
                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  <span className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" /> Errors
                  </span>
                  {erroredCronJobs.slice(0, 3).map((job) => (
                    <div key={job.id} className="flex flex-col gap-0.5 text-sm">
                      <span className="truncate">{job.name ?? job.id}</span>
                      <span className="truncate text-xs text-destructive">
                        {job.last_error}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground border-t border-border pt-3">
                  No job errors.
                </p>
              )}
              <Link to="/cron" className="text-xs text-primary underline">
                View all cron jobs →
              </Link>
            </CardContent>
          </Card>
        </section>

        {/* ── Recent sessions ─────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <H2 variant="sm" className="flex items-center gap-2 text-muted-foreground">
            <MessageSquare className="h-4 w-4" /> Recent Sessions
          </H2>
          <Card>
            <CardContent className="flex flex-col gap-1 py-4">
              {sessions.length === 0 && (
                <p className="text-sm text-muted-foreground">No sessions yet.</p>
              )}
              {sessions.map((session) => (
                <Link
                  key={session.id}
                  to={`/sessions/${session.id}`}
                  className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0 hover:text-primary"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">
                      {session.title || "Untitled session"}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {session.model ?? "unknown model"} · {session.message_count} msgs
                    </span>
                  </div>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {timeAgo(session.last_active)}
                  </span>
                </Link>
              ))}
              <Link to="/sessions" className="mt-2 text-xs text-primary underline">
                View all sessions →
              </Link>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
