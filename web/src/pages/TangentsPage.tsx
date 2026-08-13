import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Compass,
  Flag,
  Lightbulb,
  RefreshCw,
  Search,
  Sparkles,
  Tag,
} from "lucide-react";
import { fetchJSON } from "@/lib/api";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { usePageHeader } from "@/contexts/usePageHeader";
import { cn } from "@/lib/utils";

const CATEGORIES = ["all", "tech", "game", "helmself", "ttrpg", "curiosity"] as const;
const CATEGORY_LABELS: Record<string, string> = { tech: "Technology", game: "Gaming", helmself: "HELM's Own", ttrpg: "TTRPG", curiosity: "Curiosity" };

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function priColor(p: string) { return p === "high" ? "text-destructive" : p === "medium" ? "text-amber-500" : "text-muted-foreground"; }
function priTone(p: string): "destructive" | "warning" | "secondary" { return p === "high" ? "destructive" : p === "medium" ? "warning" : "secondary"; }
function statusTone(s: string): "outline" | "success" | "warning" { return s === "parked" ? "outline" : s === "promoted" ? "warning" : s === "researched" ? "success" : "outline"; }

function TangentRow({ entry, onPromote }: { entry: any; onPromote: (t: string) => void }) {
  const [updating, setUpdating] = useState(false);
  const catLabel = CATEGORY_LABELS[entry.category] || entry.category;
  return (
    <div className={cn("border border-border/50 rounded-md px-3 py-2.5 space-y-1.5", entry.priority === "high" && "border-l-2 border-l-amber-500")}>
      <div className="flex items-start gap-2.5">
        <Lightbulb className={cn("h-4 w-4 shrink-0 mt-0.5", priColor(entry.priority))} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={priTone(entry.priority)} className="text-[10px]">{entry.priority}</Badge>
            <Badge tone="outline" className="text-[10px]">{catLabel}</Badge>
            <Badge tone={statusTone(entry.status)} className="text-[10px]">{entry.status}</Badge>
            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{formatTime(entry.timestamp)}</span>
          </div>
          <p className="text-xs text-foreground">{entry.tangent}</p>
          <p className="text-[10px] text-muted-foreground">Sparked by: {entry.source}</p>
          {entry.promoted_at && <p className="text-[10px] text-amber-500/80">Promoted {formatTime(entry.promoted_at)}</p>}
          {entry.status === "parked" && (
            <div className="flex gap-2 mt-1">
              <Button type="button" ghost size="sm" className="h-6 text-[10px] gap-1" disabled={updating} onClick={() => { setUpdating(true); onPromote(entry.timestamp); }}>
                {updating ? <Spinner className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />} Promote to Research
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function TangentsPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catFilter, setCatFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("parked");
  const { setAfterTitle, setEnd } = usePageHeader();

  const load = useCallback(() => {
    setLoading(true); setError(null);
    fetchJSON<any>("/api/plugins/helm-tangents?limit=200&status=" + statusFilter + (catFilter !== "all" ? "&category=" + catFilter : "")).then(setData).catch((e) => setError(String(e))).finally(() => setLoading(false));
  }, [statusFilter, catFilter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setAfterTitle(<Button type="button" ghost size="icon" className="text-muted-foreground hover:text-foreground" onClick={load} disabled={loading} aria-label="Refresh">{loading ? <Spinner /> : <RefreshCw />}</Button>);
    setEnd(null);
    return () => { setAfterTitle(null); setEnd(null); };
  }, [loading, load, setAfterTitle, setEnd]);

  const handlePromote = useCallback((ts: string) => { fetchJSON<any>("/api/plugins/helm-tangents/" + ts + "/update?status=promoted", { method: "POST" }).then(() => load()).catch((e) => setError(String(e))); }, [load]);
  const s = data?.summary;
  const entries = data?.entries ?? [];

  const cats = useMemo(() => { if (!s?.by_category) return []; return Object.entries(s.by_category as Record<string, number>).sort((a, b) => b[1] - a[1]); }, [s]);

  return (
    <div className="space-y-4 p-4 lg:p-6 max-w-7xl mx-auto">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card><CardContent className="pt-4"><div className="flex items-center gap-2 mb-1"><Lightbulb className="w-4 h-4 text-muted-foreground" /><span className="text-xs text-muted-foreground">Parked</span></div><div className="text-2xl font-bold">{s?.parked ?? 0}</div><div className="text-xs text-muted-foreground mt-1">Ideas waiting</div></CardContent></Card>
        <Card><CardContent className="pt-4"><div className="flex items-center gap-2 mb-1"><ArrowUpRight className="w-4 h-4 text-amber-500" /><span className="text-xs text-muted-foreground">Promoted</span></div><div className="text-2xl font-bold">{s?.promoted ?? 0}</div><div className="text-xs text-muted-foreground mt-1">Queued for research</div></CardContent></Card>
        <Card><CardContent className="pt-4"><div className="flex items-center gap-2 mb-1"><Search className="w-4 h-4 text-emerald-500" /><span className="text-xs text-muted-foreground">Researched</span></div><div className="text-2xl font-bold">{s?.researched ?? 0}</div><div className="text-xs text-muted-foreground mt-1">Explored</div></CardContent></Card>
        <Card><CardContent className="pt-4"><div className="flex items-center gap-2 mb-1"><Flag className={cn("w-4 h-4", (s?.by_priority?.high ?? 0) > 0 ? "text-amber-500" : "text-muted-foreground")} /><span className="text-xs text-muted-foreground">High Priority</span></div><div className="text-2xl font-bold">{s?.by_priority?.high ?? 0}</div><div className="text-xs text-muted-foreground mt-1">{(s?.by_priority?.high ?? 0) > 0 ? "Needs attention" : "None"}</div></CardContent></Card>
      </div>

      {cats.length > 0 && (
        <Card><CardHeader className="pb-2"><div className="flex items-center gap-2"><Tag className="h-4 w-4 text-muted-foreground" /><CardTitle className="text-sm">Categories</CardTitle></div></CardHeader><CardContent><div className="flex flex-wrap gap-2">{cats.map(([c, n]) => <Badge key={c} tone="outline" className="text-xs gap-1"><span>{CATEGORY_LABELS[c] || c}</span><span className="text-muted-foreground">×{n}</span></Badge>)}</div></CardContent></Card>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-muted-foreground mr-1">Status:</span>
        {["parked", "promoted", "researched", "all"].map((f) => <Button key={f} type="button" ghost size="sm" className={cn("text-xs capitalize", statusFilter === f && "bg-primary text-primary-foreground")} onClick={() => setStatusFilter(f)}>{f}</Button>)}
        <span className="text-[10px] text-muted-foreground ml-4 mr-1">Category:</span>
        {CATEGORIES.map((f) => <Button key={f} type="button" ghost size="sm" className={cn("text-xs capitalize", catFilter === f && "bg-primary text-primary-foreground")} onClick={() => setCatFilter(f)}>{f === "all" ? "All" : CATEGORY_LABELS[f] || f}</Button>)}
      </div>

      <Card>
        <CardHeader><div className="flex items-center gap-2"><Compass className="h-5 w-5 text-muted-foreground" /><CardTitle className="text-base">Tangents Log</CardTitle><span className="text-xs text-muted-foreground ml-auto">{entries.length} {entries.length === 1 ? "entry" : "entries"}</span></div></CardHeader>
        <CardContent className="space-y-2">
          {error && <div className="flex items-center gap-2 text-xs text-destructive"><Sparkles className="h-4 w-4" />{error}</div>}
          {entries.length === 0 ? <div className="flex flex-col items-center justify-center py-8 gap-2"><Compass className="h-8 w-8 text-muted-foreground/40" /><p className="text-sm text-muted-foreground">{loading ? "Loading..." : "No tangents parked. All focus — nothing drifted."}</p></div> : entries.map((e: any) => <TangentRow key={e.timestamp} entry={e} onPromote={handlePromote} />)}
        </CardContent>
      </Card>
    </div>
  );
}