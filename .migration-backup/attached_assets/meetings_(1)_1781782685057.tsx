import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { apiRequest } from "@/lib/queryClient";
import type {
  Conversation,
  ConversationActionItem,
  DiarizedUtterance,
  Project,
  SpeakerMap,
  TeamsMeeting,
  GoogleMeetMeeting,
  ZoomMeeting,
} from "@shared/schema";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  MessageSquare,
  Upload,
  Trash2,
  Sparkles,
  Loader2,
  Users,
  FileText,
  Plus,
  Calendar,
  Clock,
  ExternalLink,
  CheckCircle,
  Unplug,
  Download,
  RefreshCw,
  Mic,
  Video,
  Edit3,
  Save,
  X,
  Eye,
  Check,
  Copy,
  AlertCircle,
  Link2Off,
  ClipboardPaste,
  Wand2,
  Mail,
  ListChecks,
  FolderPlus,
  Folder,
  Search,
  ArrowRight,
  MoreHorizontal,
  Move,
  MessagesSquare,
  Play,
  Brain,
} from "lucide-react";
import DiscordBrowser from "@/components/discord-browser";
import { MeetingIntelligenceTab } from "@/components/meetings/MeetingIntelligenceTab";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { useUpgradeModal } from "@/hooks/useUpgradeModal";
import { useDropzone } from "react-dropzone";
import { SiSlack, SiZoom, SiGooglemeet } from "react-icons/si";

interface IntegrationStatus {
  connected: boolean;
  workspaceName?: string;
  lastSynced?: string;
}

type IntegrationStatuses = Record<string, IntegrationStatus>;

function SourceIcon({ source }: { source: string }) {
  const cls = "h-4 w-4";
  switch (source) {
    case "slack":
      return <SiSlack className={cls} />;
    case "zoom":
      return <SiZoom className={cls} />;
    case "google_meet":
      return <SiGooglemeet className={cls} />;
    case "teams":
      return <Users className={cls} />;
    case "transcription":
      return <Mic className={cls} />;
    default:
      return <MessageSquare className={cls} />;
  }
}

function sourceLabel(source: string) {
  switch (source) {
    case "slack":
      return "Slack";
    case "zoom":
      return "Zoom";
    case "google_meet":
      return "Google Meet";
    case "teams":
      return "Teams";
    case "transcription":
      return "Transcription";
    default:
      return "Manual";
  }
}

function sourceBadgeColor(source: string) {
  switch (source) {
    case "slack":
      return "bg-purple-100 text-purple-700 border-purple-200";
    case "zoom":
      return "bg-blue-100 text-blue-700 border-blue-200";
    case "google_meet":
      return "bg-green-100 text-green-700 border-green-200";
    case "teams":
      return "bg-indigo-100 text-indigo-700 border-indigo-200";
    case "transcription":
      return "bg-violet-100 text-violet-700 border-violet-200";
    default:
      return "bg-slate-100 text-slate-700 border-slate-200";
  }
}

function IntegrationPanel({
  provider,
  icon,
  name,
  description,
  status,
  onConnect,
  onDisconnect,
  onImport,
  isConnecting,
  isImporting,
  accentColor,
}: {
  provider: string;
  icon: React.ReactNode;
  name: string;
  description: string;
  status: IntegrationStatus;
  onConnect: () => void;
  onDisconnect: () => void;
  onImport: () => void;
  isConnecting: boolean;
  isImporting: boolean;
  accentColor: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center space-y-4">
      <div
        className={`h-14 w-14 rounded-xl ${status.connected ? accentColor : "bg-slate-100"} flex items-center justify-center ${status.connected ? "text-white" : "text-slate-400"}`}
      >
        {icon}
      </div>
      <div>
        <h3 className="text-lg font-semibold text-slate-700 mb-1">{name}</h3>
        <p className="text-sm text-slate-500 max-w-sm">{description}</p>
      </div>

      {status.connected ? (
        <div className="space-y-3 w-full max-w-xs">
          <div className="flex items-center justify-center gap-2 text-sm text-emerald-600">
            <CheckCircle className="h-4 w-4" />
            <span className="font-medium">Connected</span>
            {status.workspaceName && (
              <span className="text-slate-400">· {status.workspaceName}</span>
            )}
          </div>
          {status.lastSynced && (
            <p className="text-xs text-slate-400">
              Last synced: {new Date(status.lastSynced).toLocaleDateString()}
            </p>
          )}
          <div className="flex gap-2 justify-center">
            <Button
              variant="default"
              size="sm"
              className="gap-2 bg-emerald-600 hover:bg-emerald-700"
              onClick={onImport}
              disabled={isImporting}
            >
              {isImporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Import Conversations
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-red-500 hover:text-red-700 hover:bg-red-50 border-red-200"
              onClick={onDisconnect}
            >
              <Unplug className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          className="gap-2"
          onClick={onConnect}
          disabled={isConnecting}
        >
          {isConnecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ExternalLink className="h-4 w-4" />
          )}
          Connect {name}
        </Button>
      )}
    </div>
  );
}

interface TeamsStatus {
  configured: boolean;
  connected: boolean;
}

const TALK_TIME_COLORS = [
  { bar: "bg-emerald-500", dot: "bg-emerald-500", text: "text-emerald-700" },
  { bar: "bg-violet-500", dot: "bg-violet-500", text: "text-violet-700" },
  { bar: "bg-amber-500", dot: "bg-amber-500", text: "text-amber-700" },
  { bar: "bg-sky-500", dot: "bg-sky-500", text: "text-sky-700" },
  { bar: "bg-rose-500", dot: "bg-rose-500", text: "text-rose-700" },
  { bar: "bg-indigo-500", dot: "bg-indigo-500", text: "text-indigo-700" },
];

function TalkTimeBar({
  utterances,
  speakerMap,
}: {
  utterances: DiarizedUtterance[];
  speakerMap?: SpeakerMap | null;
}) {
  if (!Array.isArray(utterances) || utterances.length === 0) return null;

  const totals = new Map<string, number>();
  let grand = 0;
  for (const u of utterances) {
    const dur = Math.max(0, (u.end || 0) - (u.start || 0));
    totals.set(u.speaker, (totals.get(u.speaker) || 0) + dur);
    grand += dur;
  }
  if (grand <= 0) return null;

  const entries = Array.from(totals.entries())
    .map(([speaker, ms]) => ({
      speaker,
      name: speakerMap?.[speaker]?.name || speaker,
      ms,
      pct: (ms / grand) * 100,
    }))
    .sort((a, b) => b.ms - a.ms);

  const top = entries.slice(0, 3);
  const rest = entries.slice(3);
  const segments = [...top];
  if (rest.length > 0) {
    const restMs = rest.reduce((s, r) => s + r.ms, 0);
    segments.push({
      speaker: "__others__",
      name: `${rest.length} other${rest.length === 1 ? "" : "s"}`,
      ms: restMs,
      pct: (restMs / grand) * 100,
    });
  }

  const fmtDur = (ms: number) => {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return ss > 0 ? `${m}m ${ss}s` : `${m}m`;
  };

  return (
    <div className="mb-2" data-testid="talktime-bar">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100">
        {segments.map((seg, i) => (
          <div
            key={seg.speaker}
            className={`${TALK_TIME_COLORS[i % TALK_TIME_COLORS.length].bar} h-full transition-opacity hover:opacity-80`}
            style={{ width: `${seg.pct}%` }}
            title={`${seg.name} — ${seg.pct.toFixed(1)}% (${fmtDur(seg.ms)})`}
          />
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {segments.map((seg, i) => {
          const color = TALK_TIME_COLORS[i % TALK_TIME_COLORS.length];
          return (
            <div
              key={seg.speaker}
              className="flex items-center gap-1.5 text-[10px] text-slate-600"
              title={`${seg.name} — ${seg.pct.toFixed(1)}% (${fmtDur(seg.ms)})`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${color.dot}`} />
              <span className={`font-medium ${color.text}`}>{seg.name}</span>
              <span className="tabular-nums text-slate-500">
                {seg.pct.toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActionItemsBlock({
  conversationId,
  conversationTitle,
  items,
}: {
  conversationId: number;
  conversationTitle: string;
  items: ConversationActionItem[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const [pickerOpenFor, setPickerOpenFor] = useState<string | null>(null);
  const [createOpenFor, setCreateOpenFor] = useState<string | null>(null);
  const [projectQuery, setProjectQuery] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDesc, setNewProjectDesc] = useState("");
  // When set, the picker / create dialog re-routes an already-routed item
  // instead of routing for the first time.
  const [moveModeFor, setMoveModeFor] = useState<string | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] =
    useState<ConversationActionItem | null>(null);

  const resetDialogState = () => {
    setPickerOpenFor(null);
    setCreateOpenFor(null);
    setProjectQuery("");
    setNewProjectName("");
    setNewProjectDesc("");
    setMoveModeFor(null);
  };

  const invalidateAfterChange = (projectIds: Array<number | null | undefined>) => {
    queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    const seen = new Set<number>();
    for (const pid of projectIds) {
      if (typeof pid === "number" && !seen.has(pid)) {
        seen.add(pid);
        queryClient.invalidateQueries({
          queryKey: [`/api/projects/${pid}/tasks`],
        });
      }
    }
  };

  const routeMutation = useMutation({
    mutationFn: async (vars: {
      itemId: string;
      body: { projectId?: number; newProject?: { name: string; description?: string } };
    }) => {
      return await apiRequest(
        `/api/conversations/${conversationId}/action-items/${vars.itemId}/route`,
        { method: "POST", body: JSON.stringify(vars.body) },
      );
    },
    onSuccess: (data: any) => {
      invalidateAfterChange([data?.projectId]);
      resetDialogState();
      toast({
        title: "Action item routed",
        description: data?.projectName
          ? `Added as a task in ${data.projectName}.`
          : "Added as a task.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Could not route action item",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const reRouteMutation = useMutation({
    mutationFn: async (vars: {
      itemId: string;
      body: { projectId?: number; newProject?: { name: string; description?: string } };
    }) => {
      return await apiRequest(
        `/api/conversations/${conversationId}/action-items/${vars.itemId}/route`,
        { method: "PATCH", body: JSON.stringify(vars.body) },
      );
    },
    onSuccess: (data: any) => {
      invalidateAfterChange([data?.projectId, data?.previousProjectId]);
      resetDialogState();
      toast({
        title: "Action item moved",
        description: data?.projectName
          ? `Now lives in ${data.projectName}.`
          : "Moved to a different project.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Could not move action item",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const unrouteMutation = useMutation({
    mutationFn: async (vars: { itemId: string; previousProjectId: number | null }) => {
      const res = await apiRequest(
        `/api/conversations/${conversationId}/action-items/${vars.itemId}/route`,
        { method: "DELETE" },
      );
      return { ...res, previousProjectId: vars.previousProjectId };
    },
    onSuccess: (data: any) => {
      invalidateAfterChange([data?.previousProjectId]);
      toast({
        title: "Action item unrouted",
        description: "The task was removed and the action item is back to un-routed.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Could not unroute action item",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (vars: { itemId: string; previousProjectId: number | null }) => {
      const res = await apiRequest(
        `/api/conversations/${conversationId}/action-items/${vars.itemId}`,
        { method: "DELETE" },
      );
      return { ...res, previousProjectId: vars.previousProjectId };
    },
    onSuccess: (data: any) => {
      invalidateAfterChange([data?.previousProjectId]);
      setConfirmDeleteFor(null);
      toast({
        title: "Action item deleted",
        description: "Removed from this transcript.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Could not delete action item",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const filteredProjects = projectQuery.trim()
    ? projects.filter((p) =>
        p.name.toLowerCase().includes(projectQuery.trim().toLowerCase()),
      )
    : projects;

  const moveItem = moveModeFor
    ? items.find((it) => it.id === moveModeFor) || null
    : null;
  const moveCandidates = moveItem
    ? filteredProjects.filter((p) => p.id !== moveItem.routedProjectId)
    : filteredProjects;

  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-400 mb-3">
        <ListChecks className="h-3 w-3" />
        No action items found in this transcript.
      </div>
    );
  }

  return (
    <div className="border border-slate-200 rounded-md p-3 mb-3 bg-white">
      <div className="flex items-center gap-1 mb-2">
        <ListChecks className="h-3 w-3 text-slate-600" />
        <span className="text-xs font-semibold text-slate-700">
          Action items ({items.length})
        </span>
      </div>
      <ul className="space-y-2">
        {items.map((item) => {
          const routed = !!item.routedTaskId && !!item.routedProjectId;
          return (
            <li
              key={item.id}
              className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between border border-slate-100 rounded-md p-2"
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs text-slate-800 break-words">{item.text}</p>
                {(item.owner || item.dueHint) && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {item.owner && (
                      <Badge
                        variant="outline"
                        className="text-[10px] h-4 px-1.5 bg-slate-50 text-slate-600 border-slate-200"
                      >
                        <Users className="h-2.5 w-2.5 mr-1" />
                        {item.owner}
                      </Badge>
                    )}
                    {item.dueHint && (
                      <Badge
                        variant="outline"
                        className="text-[10px] h-4 px-1.5 bg-slate-50 text-slate-600 border-slate-200"
                      >
                        <Clock className="h-2.5 w-2.5 mr-1" />
                        {item.dueHint}
                      </Badge>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1 sm:ml-2 shrink-0">
                {routed ? (
                  <>
                    <a
                      href={`/projects/${item.routedProjectId}`}
                      className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-800"
                      data-testid={`action-item-routed-${item.id}`}
                    >
                      <CheckCircle className="h-3.5 w-3.5" />
                      <span className="truncate max-w-[160px]">
                        Added to {item.routedProjectName || "project"}
                      </span>
                      <ArrowRight className="h-3 w-3" />
                    </a>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-slate-500 hover:text-slate-700"
                          data-testid={`button-action-item-menu-${item.id}`}
                          disabled={
                            unrouteMutation.isPending ||
                            reRouteMutation.isPending ||
                            deleteMutation.isPending
                          }
                          aria-label="Action item options"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem
                          onClick={() => {
                            setMoveModeFor(item.id);
                            setProjectQuery("");
                          }}
                          data-testid={`menu-move-${item.id}`}
                        >
                          <Move className="h-3.5 w-3.5 mr-2" />
                          Move to another project
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            unrouteMutation.mutate({
                              itemId: item.id,
                              previousProjectId: item.routedProjectId ?? null,
                            })
                          }
                          data-testid={`menu-unroute-${item.id}`}
                        >
                          <Link2Off className="h-3.5 w-3.5 mr-2" />
                          Unroute (delete task)
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-red-600 focus:text-red-600"
                          onClick={() => setConfirmDeleteFor(item)}
                          data-testid={`menu-delete-${item.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" />
                          Delete action item
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                ) : (
                  <>
                    <Popover
                      open={pickerOpenFor === item.id}
                      onOpenChange={(open) => {
                        setPickerOpenFor(open ? item.id : null);
                        if (!open) setProjectQuery("");
                      }}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs h-7 px-2"
                          data-testid={`button-add-to-project-${item.id}`}
                          disabled={routeMutation.isPending}
                          onClick={() => setMoveModeFor(null)}
                        >
                          <Folder className="h-3 w-3 mr-1" />
                          Add to project
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="end"
                        className="p-0 w-72"
                      >
                        <div className="p-2 border-b border-slate-100">
                          <div className="relative">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                            <Input
                              autoFocus
                              value={projectQuery}
                              onChange={(e) => setProjectQuery(e.target.value)}
                              placeholder="Search projects..."
                              className="text-xs h-8 pl-7"
                              data-testid={`input-search-projects-${item.id}`}
                            />
                          </div>
                        </div>
                        <ScrollArea className="max-h-56">
                          {filteredProjects.length === 0 ? (
                            <div className="p-3 text-center text-xs text-slate-500">
                              {projects.length === 0
                                ? "No projects yet."
                                : "No matching projects."}
                              <Button
                                variant="link"
                                size="sm"
                                className="text-xs h-auto p-0 mt-1 block mx-auto"
                                onClick={() => {
                                  setPickerOpenFor(null);
                                  setNewProjectName(item.text.slice(0, 60));
                                  setNewProjectDesc(
                                    `Created from action item in: ${conversationTitle}`,
                                  );
                                  setCreateOpenFor(item.id);
                                }}
                                data-testid={`button-create-from-empty-${item.id}`}
                              >
                                Create a new project instead
                              </Button>
                            </div>
                          ) : (
                            <div className="py-1">
                              {filteredProjects.map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  onClick={() =>
                                    routeMutation.mutate({
                                      itemId: item.id,
                                      body: { projectId: p.id },
                                    })
                                  }
                                  disabled={routeMutation.isPending}
                                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-100 flex items-center gap-2 disabled:opacity-50"
                                  data-testid={`option-project-${p.id}-for-${item.id}`}
                                >
                                  <Folder className="h-3 w-3 text-slate-500" />
                                  <span className="truncate">{p.name}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </ScrollArea>
                      </PopoverContent>
                    </Popover>

                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-7 px-2"
                      data-testid={`button-create-project-${item.id}`}
                      disabled={routeMutation.isPending}
                      onClick={() => {
                        setMoveModeFor(null);
                        setNewProjectName(item.text.slice(0, 60));
                        setNewProjectDesc(
                          `Created from action item in: ${conversationTitle}`,
                        );
                        setCreateOpenFor(item.id);
                      }}
                    >
                      <FolderPlus className="h-3 w-3 mr-1" />
                      New project
                    </Button>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-slate-500 hover:text-slate-700"
                          data-testid={`button-action-item-menu-${item.id}`}
                          disabled={
                            routeMutation.isPending || deleteMutation.isPending
                          }
                          aria-label="Action item options"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem
                          className="text-red-600 focus:text-red-600"
                          onClick={() => setConfirmDeleteFor(item)}
                          data-testid={`menu-delete-${item.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" />
                          Delete action item
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <Dialog
        open={createOpenFor !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpenFor(null);
            setNewProjectName("");
            setNewProjectDesc("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {createOpenFor && moveModeFor === createOpenFor
                ? "Move action item to a new project"
                : "Create project from action item"}
            </DialogTitle>
            <DialogDescription>
              {createOpenFor && moveModeFor === createOpenFor
                ? "We'll create a new project and move this action item there as a fresh task. The previous task will be deleted."
                : "We'll create a new project and add this action item as its first task."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="ai-new-project-name" className="text-xs">
                Project name
              </Label>
              <Input
                id="ai-new-project-name"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="e.g., Security review follow-ups"
                data-testid="input-new-project-name"
              />
            </div>
            <div>
              <Label htmlFor="ai-new-project-desc" className="text-xs">
                Description (optional)
              </Label>
              <Textarea
                id="ai-new-project-desc"
                value={newProjectDesc}
                onChange={(e) => setNewProjectDesc(e.target.value)}
                rows={3}
                data-testid="input-new-project-desc"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateOpenFor(null);
                setNewProjectName("");
                setNewProjectDesc("");
              }}
              disabled={routeMutation.isPending || reRouteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!createOpenFor) return;
                const name = newProjectName.trim();
                if (!name) {
                  toast({
                    title: "Project name required",
                    variant: "destructive",
                  });
                  return;
                }
                const body = {
                  newProject: {
                    name,
                    description: newProjectDesc.trim() || undefined,
                  },
                };
                if (moveModeFor === createOpenFor) {
                  reRouteMutation.mutate({ itemId: createOpenFor, body });
                } else {
                  routeMutation.mutate({ itemId: createOpenFor, body });
                }
              }}
              disabled={
                routeMutation.isPending ||
                reRouteMutation.isPending ||
                !newProjectName.trim()
              }
              data-testid="button-confirm-create-project"
            >
              {routeMutation.isPending || reRouteMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <FolderPlus className="h-3.5 w-3.5 mr-1" />
              )}
              {moveModeFor === createOpenFor
                ? "Move to new project"
                : "Create project & add task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={moveItem !== null && createOpenFor === null}
        onOpenChange={(open) => {
          if (!open) {
            setMoveModeFor(null);
            setProjectQuery("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move action item to another project</DialogTitle>
            <DialogDescription>
              Pick a different project. We'll delete the current task in
              {moveItem?.routedProjectName ? ` "${moveItem.routedProjectName}"` : " the previous project"}
              {" "}and create a fresh one in the project you choose.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <Input
                autoFocus
                value={projectQuery}
                onChange={(e) => setProjectQuery(e.target.value)}
                placeholder="Search projects..."
                className="text-xs h-9 pl-7"
                data-testid="input-search-move-projects"
              />
            </div>
            <ScrollArea className="max-h-72 border border-slate-100 rounded-md">
              {moveCandidates.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-500">
                  {projects.length <= 1
                    ? "No other projects to move this to."
                    : "No matching projects."}
                </div>
              ) : (
                <div className="py-1">
                  {moveCandidates.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() =>
                        moveItem &&
                        reRouteMutation.mutate({
                          itemId: moveItem.id,
                          body: { projectId: p.id },
                        })
                      }
                      disabled={reRouteMutation.isPending}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-slate-100 flex items-center gap-2 disabled:opacity-50"
                      data-testid={`option-move-project-${p.id}`}
                    >
                      <Folder className="h-3 w-3 text-slate-500" />
                      <span className="truncate">{p.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setMoveModeFor(null);
                setProjectQuery("");
              }}
              disabled={reRouteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (!moveItem) return;
                setNewProjectName(moveItem.text.slice(0, 60));
                setNewProjectDesc(
                  `Created from action item in: ${conversationTitle}`,
                );
                setCreateOpenFor(moveItem.id);
              }}
              disabled={reRouteMutation.isPending}
              data-testid="button-move-to-new-project"
            >
              <FolderPlus className="h-3.5 w-3.5 mr-1" />
              Move to a new project instead
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmDeleteFor !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this action item?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDeleteFor?.routedTaskId
                ? `This will remove the action item from this transcript and also delete the task that was added to ${confirmDeleteFor.routedProjectName || "the routed project"}.`
                : "This will remove the action item from this transcript. You can re-summarize the conversation to bring it back."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (!confirmDeleteFor) return;
                deleteMutation.mutate({
                  itemId: confirmDeleteFor.id,
                  previousProjectId: confirmDeleteFor.routedProjectId ?? null,
                });
              }}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
              data-testid="button-confirm-delete-action-item"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5 mr-1" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function MeetingsPage() {
  const { toast } = useToast();
  const { handleBudgetError } = useUpgradeModal();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [source, setSource] = useState("manual");
  const [participants, setParticipants] = useState("");
  const [meetingDate, setMeetingDate] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [connectingProvider, setConnectingProvider] = useState<string | null>(
    null,
  );

  const [showCreateMeeting, setShowCreateMeeting] = useState(false);
  const [showTranscriptDialog, setShowTranscriptDialog] = useState(false);
  const [showPlanDialog, setShowPlanDialog] = useState(false);
  const [selectedMeeting, setSelectedMeeting] = useState<TeamsMeeting | null>(
    null,
  );
  const [pasteTranscript, setPasteTranscript] = useState("");
  const [deleteMeetingItem, setDeleteMeetingItem] =
    useState<TeamsMeeting | null>(null);
  const [editTeamsMeeting, setEditTeamsMeeting] = useState<TeamsMeeting | null>(
    null,
  );
  const [editTeamsForm, setEditTeamsForm] = useState({
    subject: "",
    date: "",
    startTime: "",
    endTime: "",
    attendees: "",
    description: "",
  });
  const [meetingForm, setMeetingForm] = useState({
    subject: "",
    date: format(new Date(), "yyyy-MM-dd"),
    startTime: format(new Date(Date.now() + 60 * 60 * 1000), "HH:mm"),
    endTime: format(new Date(Date.now() + 2 * 60 * 60 * 1000), "HH:mm"),
    attendees: "",
  });

  const { data: conversations = [], isLoading } = useQuery<Conversation[]>({
    queryKey: ["/api/conversations"],
  });

  const {
    data: integrationStatuses = {} as IntegrationStatuses,
    refetch: refetchStatuses,
  } = useQuery<IntegrationStatuses>({
    queryKey: ["/api/integrations/meetings/status"],
  });

  const { data: teamsStatus } = useQuery<TeamsStatus>({
    queryKey: ["/api/teams/status"],
  });

  const { data: teamsMeetings, isLoading: meetingsLoading } = useQuery<
    TeamsMeeting[]
  >({
    queryKey: ["/api/teams/meetings"],
    enabled: teamsStatus?.connected === true,
  });

  const isTeamsConnected = teamsStatus?.connected ?? false;
  const isTeamsConfigured = teamsStatus?.configured ?? false;

  const { data: googleMeetStatus } = useQuery<{ connected: boolean }>({
    queryKey: ["/api/google-meet/status"],
  });

  const { data: googleMeetMeetings, isLoading: googleMeetLoading } = useQuery<
    GoogleMeetMeeting[]
  >({
    queryKey: ["/api/google-meet/meetings"],
    enabled: googleMeetStatus?.connected === true,
  });

  const isGoogleMeetConnected = googleMeetStatus?.connected ?? false;

  const { data: zoomStatus } = useQuery<{ connected: boolean; configured: boolean }>({
    queryKey: ["/api/zoom/status"],
  });

  const { data: zoomMeetings, isLoading: zoomMeetingsLoading } = useQuery<ZoomMeeting[]>({
    queryKey: ["/api/zoom/meetings"],
    enabled: zoomStatus?.connected === true,
  });

  const isZoomConnected = zoomStatus?.connected ?? false;
  const isZoomConfigured = zoomStatus?.configured ?? false;

  const [showCreateGoogleMeeting, setShowCreateGoogleMeeting] = useState(false);
  const [selectedGoogleMeeting, setSelectedGoogleMeeting] =
    useState<GoogleMeetMeeting | null>(null);
  const [showGoogleTranscriptDialog, setShowGoogleTranscriptDialog] =
    useState(false);
  const [googlePasteTranscript, setGooglePasteTranscript] = useState("");
  const [deleteGoogleMeetingItem, setDeleteGoogleMeetingItem] =
    useState<GoogleMeetMeeting | null>(null);
  const [googleMeetForm, setGoogleMeetForm] = useState({
    subject: "",
    date: format(new Date(), "yyyy-MM-dd"),
    startTime: format(new Date(), "HH:mm"),
    endTime: format(new Date(Date.now() + 60 * 60 * 1000), "HH:mm"),
    attendees: "",
    description: "",
  });
  const [editGoogleMeeting, setEditGoogleMeeting] =
    useState<GoogleMeetMeeting | null>(null);
  const [editGoogleMeetForm, setEditGoogleMeetForm] = useState({
    subject: "",
    date: "",
    startTime: "",
    endTime: "",
    attendees: "",
    description: "",
  });

  const [showCreateZoomMeeting, setShowCreateZoomMeeting] = useState(false);
  const [editZoomMeeting, setEditZoomMeeting] = useState<ZoomMeeting | null>(null);
  const [deleteZoomMeetingItem, setDeleteZoomMeetingItem] = useState<ZoomMeeting | null>(null);
  const [selectedZoomMeeting, setSelectedZoomMeeting] = useState<ZoomMeeting | null>(null);
  const [showZoomTranscriptDialog, setShowZoomTranscriptDialog] = useState(false);
  const [zoomPasteTranscript, setZoomPasteTranscript] = useState("");
  const [fetchingZoomTranscriptId, setFetchingZoomTranscriptId] = useState<number | null>(null);
  const [conversationToDelete, setConversationToDelete] = useState<{id: number; title: string} | null>(null);
  const [fetchingGoogleTranscriptId, setFetchingGoogleTranscriptId] = useState<number | null>(null);
  const [fetchingTeamsTranscriptId, setFetchingTeamsTranscriptId] = useState<number | null>(null);
  const [zoomMeetingForm, setZoomMeetingForm] = useState({
    subject: "",
    date: format(new Date(), "yyyy-MM-dd"),
    startTime: format(new Date(Date.now() + 60 * 60 * 1000), "HH:mm"),
    duration: "60",
    attendees: "",
    description: "",
  });
  const [editZoomForm, setEditZoomForm] = useState({
    subject: "",
    date: "",
    startTime: "",
    duration: "",
    attendees: "",
    description: "",
  });

  const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const utcOffsetMinutes = new Date().getTimezoneOffset();
  const offsetSign = utcOffsetMinutes <= 0 ? "+" : "-";
  const offsetHours = Math.floor(Math.abs(utcOffsetMinutes) / 60);
  const offsetMins = Math.abs(utcOffsetMinutes) % 60;
  const utcOffsetStr = `UTC${offsetSign}${offsetHours}${offsetMins > 0 ? `:${String(offsetMins).padStart(2, "0")}` : ""}`;
  const timezoneDisplay = `${userTimeZone} (${utcOffsetStr})`;
  const tzAbbr = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date()).find(p => p.type === "timeZoneName")?.value || utcOffsetStr;

  const createGoogleMeetingMutation = useMutation({
    mutationFn: async (data: {
      subject: string;
      startTime: string;
      endTime: string;
      attendees: string[];
      description: string;
      timeZone: string;
    }) => {
      return (await apiRequest("/api/google-meet/meetings", {
        method: "POST",
        body: JSON.stringify(data),
      })) as GoogleMeetMeeting;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/google-meet/meetings"],
      });
      setShowCreateGoogleMeeting(false);
      setGoogleMeetForm({
        subject: "",
        date: format(new Date(), "yyyy-MM-dd"),
        startTime: format(new Date(), "HH:mm"),
        endTime: format(new Date(Date.now() + 60 * 60 * 1000), "HH:mm"),
        attendees: "",
        description: "",
      });
      toast({
        title: "Meeting Created",
        description: data.meetLink
          ? "Google Meet link generated successfully!"
          : "Calendar event created.",
      });
    },
    onError: (error: any) => {
      if (handleBudgetError(error)) return;
      toast({
        title: "Error",
        description: error.message || "Failed to create meeting",
        variant: "destructive",
      });
    },
  });

  const updateGoogleMeetingMutation = useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: number;
      data: {
        subject: string;
        startTime: string;
        endTime: string;
        attendees: string[];
        description: string;
        timeZone: string;
      };
    }) => {
      return (await apiRequest(`/api/google-meet/meetings/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      })) as GoogleMeetMeeting;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/google-meet/meetings"],
      });
      setEditGoogleMeeting(null);
      toast({
        title: "Meeting Updated",
        description: "Meeting and Google Calendar event updated.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update meeting",
        variant: "destructive",
      });
    },
  });

  const createZoomMeetingMutation = useMutation({
    mutationFn: async (data: {
      subject: string;
      startTime: string;
      duration: number;
      attendees: string[];
      description: string;
      timeZone: string;
    }) => {
      return (await apiRequest("/api/zoom/meetings", {
        method: "POST",
        body: JSON.stringify(data),
      })) as ZoomMeeting;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/zoom/meetings"] });
      setShowCreateZoomMeeting(false);
      setZoomMeetingForm({
        subject: "",
        date: format(new Date(), "yyyy-MM-dd"),
        startTime: format(new Date(Date.now() + 60 * 60 * 1000), "HH:mm"),
        duration: "60",
        attendees: "",
        description: "",
      });
      toast({
        title: "Meeting Created",
        description: data.joinUrl
          ? "Your Zoom meeting is ready! Click 'Join' to start."
          : "Zoom meeting created.",
      });
    },
    onError: (error: any) => {
      if (handleBudgetError(error)) return;
      toast({
        title: "Error",
        description: error.message || "Failed to create Zoom meeting",
        variant: "destructive",
      });
    },
  });

  const updateZoomMeetingMutation = useMutation({
    mutationFn: async ({ id, data }: {
      id: number;
      data: {
        subject?: string;
        startTime?: string;
        duration?: number;
        attendees?: string[];
        description?: string;
        timeZone?: string;
      };
    }) => {
      return (await apiRequest(`/api/zoom/meetings/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      })) as ZoomMeeting;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/zoom/meetings"] });
      setEditZoomMeeting(null);
      toast({
        title: "Meeting Updated",
        description: "Zoom meeting updated successfully.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update meeting",
        variant: "destructive",
      });
    },
  });

  const deleteZoomMeetingMutation = useMutation({
    mutationFn: async (id: number) => {
      return await apiRequest(`/api/zoom/meetings/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/zoom/meetings"] });
      setDeleteZoomMeetingItem(null);
      toast({
        title: "Meeting Deleted",
        description: "Zoom meeting has been deleted.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to delete meeting",
        variant: "destructive",
      });
    },
  });

  const fetchZoomTranscriptMutation = useMutation({
    mutationFn: async (meetingId: number) => {
      setFetchingZoomTranscriptId(meetingId);
      return await apiRequest(`/api/zoom/meetings/${meetingId}/fetch-transcript`, { method: "POST" });
    },
    onSuccess: () => {
      setFetchingZoomTranscriptId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/zoom/meetings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      toast({
        title: "Transcript Fetched",
        description: "Zoom transcript found and saved from cloud recording.",
      });
    },
    onError: (error: any) => {
      setFetchingZoomTranscriptId(null);
      if (handleBudgetError(error)) return;
      const msg = error.message || "Could not find a transcript.";
      const isNotFound = msg.toLowerCase().includes("no transcript") || msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("not available");
      toast({
        title: isNotFound ? "No Transcript Available" : "Error",
        description: isNotFound
          ? "No transcript is available for this meeting yet. Make sure cloud recording with audio transcript is enabled in Zoom. Transcripts may take a few minutes to appear after the meeting ends."
          : msg,
        variant: isNotFound ? "default" : "destructive",
      });
    },
  });

  const saveZoomTranscriptMutation = useMutation({
    mutationFn: async ({ meetingId, transcript }: { meetingId: number; transcript: string }) => {
      return await apiRequest(`/api/zoom/meetings/${meetingId}/save-transcript`, {
        method: "POST",
        body: JSON.stringify({ transcript }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/zoom/meetings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      setShowZoomTranscriptDialog(false);
      setZoomPasteTranscript("");
      toast({ title: "Transcript Saved", description: "Zoom meeting transcript saved and added to conversations." });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to save transcript",
        variant: "destructive",
      });
    },
  });

  const fetchGoogleTranscriptMutation = useMutation({
    mutationFn: async (meetingId: number) => {
      setFetchingGoogleTranscriptId(meetingId);
      return await apiRequest(
        `/api/google-meet/meetings/${meetingId}/fetch-transcript`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      setFetchingGoogleTranscriptId(null);
      queryClient.invalidateQueries({
        queryKey: ["/api/google-meet/meetings"],
      });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      toast({
        title: "Transcript Fetched",
        description: "Transcript found and saved from Google Drive.",
      });
    },
    onError: (error: any) => {
      setFetchingGoogleTranscriptId(null);
      if (handleBudgetError(error)) return;
      const msg = error.message || "Could not find a transcript.";
      const isNotFound = msg.toLowerCase().includes("no transcript") || msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("not available");
      toast({
        title: isNotFound ? "No Transcript Available" : "Error",
        description: isNotFound
          ? "No transcript is available for this meeting yet. Make sure transcription was enabled during the meeting. Transcripts typically appear in Google Drive a few minutes after the meeting ends. You can also paste a transcript manually."
          : msg,
        variant: isNotFound ? "default" : "destructive",
      });
    },
  });

  const saveGoogleTranscriptMutation = useMutation({
    mutationFn: async ({
      meetingId,
      transcript,
    }: {
      meetingId: number;
      transcript: string;
    }) => {
      return await apiRequest(
        `/api/google-meet/meetings/${meetingId}/save-transcript`,
        { method: "POST", body: JSON.stringify({ transcript }) },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/google-meet/meetings"],
      });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      setShowGoogleTranscriptDialog(false);
      setGooglePasteTranscript("");
      toast({ title: "Transcript Saved" });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const importCalendarMeetingsMutation = useMutation({
    mutationFn: async () => {
      return (await apiRequest("/api/google-meet/import-calendar", {
        method: "POST",
      })) as { imported: number; total: number; skipped: number };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/google-meet/meetings"],
      });
      toast({
        title: data.imported > 0 ? "Calendar Imported" : "No New Meetings",
        description:
          data.imported > 0
            ? `Imported ${data.imported} new meeting${data.imported !== 1 ? "s" : ""} from Google Calendar (${data.total} total found, ${data.skipped || 0} already existed).`
            : `Found ${data.total} calendar event${data.total !== 1 ? "s" : ""} with Meet links, all already imported.`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Import Failed",
        description: error.message || "Failed to import calendar events",
        variant: "destructive",
      });
    },
  });

  const deleteGoogleMeetingMutation = useMutation({
    mutationFn: async (meetingId: number) => {
      return await apiRequest(`/api/google-meet/meetings/${meetingId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/google-meet/meetings"],
      });
      setDeleteGoogleMeetingItem(null);
      toast({ title: "Meeting Deleted" });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleCreateGoogleMeeting = () => {
    const startDateTime = `${googleMeetForm.date}T${googleMeetForm.startTime}:00`;
    const endDateTime = `${googleMeetForm.date}T${googleMeetForm.endTime}:00`;
    const attendeeList = googleMeetForm.attendees
      .split(/[,\n]+/)
      .map((e) => e.trim())
      .filter((e) => e.includes("@"));
    createGoogleMeetingMutation.mutate({
      subject: googleMeetForm.subject,
      startTime: startDateTime,
      endTime: endDateTime,
      attendees: attendeeList,
      description: googleMeetForm.description,
      timeZone: userTimeZone,
    });
  };

  const openEditGoogleMeeting = (meeting: GoogleMeetMeeting) => {
    const startDate = new Date(meeting.startTime);
    const endDate = new Date(meeting.endTime);
    setEditGoogleMeetForm({
      subject: meeting.subject,
      date: format(startDate, "yyyy-MM-dd"),
      startTime: format(startDate, "HH:mm"),
      endTime: format(endDate, "HH:mm"),
      attendees: (meeting.attendees || []).join(", "),
      description: "",
    });
    setEditGoogleMeeting(meeting);
  };

  const handleUpdateGoogleMeeting = () => {
    if (!editGoogleMeeting) return;
    const startDateTime = `${editGoogleMeetForm.date}T${editGoogleMeetForm.startTime}:00`;
    const endDateTime = `${editGoogleMeetForm.date}T${editGoogleMeetForm.endTime}:00`;
    const attendeeList = editGoogleMeetForm.attendees
      .split(/[,\n]+/)
      .map((e) => e.trim())
      .filter((e) => e.includes("@"));
    updateGoogleMeetingMutation.mutate({
      id: editGoogleMeeting.id,
      data: {
        subject: editGoogleMeetForm.subject,
        startTime: startDateTime,
        endTime: endDateTime,
        attendees: attendeeList,
        description: editGoogleMeetForm.description,
        timeZone: userTimeZone,
      },
    });
  };

  const handleGoogleMeetConnect = async () => {
    handleConnect("google_meet");
  };

  const handleGoogleMeetDisconnect = async () => {
    disconnectMutation.mutate("google_meet");
  };

  const createMeetingMutation = useMutation({
    mutationFn: async (data: {
      subject: string;
      startTime: string;
      endTime: string;
      attendees: string[];
      timeZone: string;
    }) => {
      return (await apiRequest("/api/teams/meetings", {
        method: "POST",
        body: JSON.stringify(data),
      })) as TeamsMeeting & { meetingType?: string };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/teams/meetings"] });
      setShowCreateMeeting(false);
      setMeetingForm({
        subject: "",
        date: format(new Date(), "yyyy-MM-dd"),
        startTime: format(new Date(Date.now() + 60 * 60 * 1000), "HH:mm"),
        endTime: format(new Date(Date.now() + 2 * 60 * 60 * 1000), "HH:mm"),
        attendees: "",
      });
      const hasJoinLink =
        data.joinUrl &&
        !data.joinUrl.includes("outlook.live.com") &&
        !data.joinUrl.includes("outlook.office");
      if (hasJoinLink) {
        toast({
          title: "Meeting Created",
          description:
            "Your Teams meeting is ready! Click 'Join Meeting' to start.",
        });
      } else {
        toast({
          title: "Calendar Event Created",
          description:
            "A calendar event was created. Teams join links require a Microsoft 365 Business license.",
        });
      }
    },
    onError: (error: any) => {
      if (handleBudgetError(error)) return;
      toast({
        title: "Error",
        description: error.message || "Failed to create meeting.",
        variant: "destructive",
      });
    },
  });

  const fetchTranscriptMutation = useMutation({
    mutationFn: async (meetingId: number) => {
      setFetchingTeamsTranscriptId(meetingId);
      return (await apiRequest(
        `/api/teams/meetings/${meetingId}/fetch-transcript`,
        {
          method: "POST",
        },
      )) as TeamsMeeting;
    },
    onSuccess: (data) => {
      setFetchingTeamsTranscriptId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/teams/meetings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      setSelectedMeeting(data);
      toast({
        title: "Transcript Fetched",
        description: "Meeting transcript has been saved.",
      });
    },
    onError: (error: any) => {
      setFetchingTeamsTranscriptId(null);
      if (handleBudgetError(error)) return;
      const msg = error.message || "Could not fetch transcript.";
      const isNotFound = msg.toLowerCase().includes("no transcript") || msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("not available");
      toast({
        title: isNotFound ? "No Transcript Available" : "Error",
        description: isNotFound
          ? "No transcript is available for this meeting yet. Transcripts may take a few minutes to appear after the meeting ends. You can also paste a transcript manually."
          : msg,
        variant: isNotFound ? "default" : "destructive",
      });
    },
  });

  const saveTranscriptMutation = useMutation({
    mutationFn: async ({
      meetingId,
      transcript,
    }: {
      meetingId: number;
      transcript: string;
    }) => {
      return (await apiRequest(
        `/api/teams/meetings/${meetingId}/save-transcript`,
        {
          method: "POST",
          body: JSON.stringify({ transcript }),
        },
      )) as TeamsMeeting;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/teams/meetings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      setSelectedMeeting(data);
      setShowTranscriptDialog(false);
      setPasteTranscript("");
      toast({
        title: "Transcript Saved",
        description: "Meeting transcript has been saved.",
      });
    },
  });

  const generatePlanMutation = useMutation({
    mutationFn: async (meetingId: number) => {
      return (await apiRequest(
        `/api/teams/meetings/${meetingId}/generate-plan`,
        {
          method: "POST",
        },
      )) as { meeting: TeamsMeeting; plan: any };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/teams/meetings"] });
      setSelectedMeeting(data.meeting);
      setShowPlanDialog(true);
      toast({
        title: "Project Plan Generated",
        description: "AI has created a project plan from the transcript.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to generate plan.",
        variant: "destructive",
      });
    },
  });

  const deleteMeetingMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest(`/api/teams/meetings/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/teams/meetings"] });
      toast({ title: "Deleted", description: "Meeting removed." });
    },
  });

  const updateTeamsMeetingMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: any }) => {
      return (await apiRequest(`/api/teams/meetings/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      })) as TeamsMeeting;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/teams/meetings"] });
      setEditTeamsMeeting(null);
      toast({
        title: "Meeting Updated",
        description: "Meeting details and calendar event have been updated.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Update Failed",
        description: error.message || "Could not update meeting.",
        variant: "destructive",
      });
    },
  });

  const handleEditTeamsMeeting = (meeting: TeamsMeeting) => {
    setEditTeamsMeeting(meeting);
    setEditTeamsForm({
      subject: meeting.subject,
      date: format(new Date(meeting.startTime), "yyyy-MM-dd"),
      startTime: format(new Date(meeting.startTime), "HH:mm"),
      endTime: format(new Date(meeting.endTime), "HH:mm"),
      attendees: (meeting.attendees || []).join("\n"),
      description: "",
    });
  };

  const handleUpdateTeamsMeeting = () => {
    if (!editTeamsMeeting) return;
    const startDateTime = `${editTeamsForm.date}T${editTeamsForm.startTime}:00`;
    const endDateTime = `${editTeamsForm.date}T${editTeamsForm.endTime}:00`;
    const attendeeList = editTeamsForm.attendees
      .split(/[,\n]+/)
      .map((e) => e.trim())
      .filter((e) => e.includes("@"));
    updateTeamsMeetingMutation.mutate({
      id: editTeamsMeeting.id,
      data: {
        subject: editTeamsForm.subject,
        startTime: startDateTime,
        endTime: endDateTime,
        attendees: attendeeList,
        description: editTeamsForm.description,
        timeZone: userTimeZone,
      },
    });
  };

  const handleTeamsConnect = async () => {
    setConnectingProvider("teams");
    try {
      const res = await fetch("/api/teams/connect", { credentials: "include" });
      const data = await res.json();
      if (!res.ok) {
        setConnectingProvider(null);
        toast({
          title: res.status === 501 ? "Not configured" : "Error",
          description: data.message || data.error || "Failed to connect.",
          variant: "destructive",
        });
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      setConnectingProvider(null);
      toast({
        title: "Error",
        description: "Failed to initiate connection.",
        variant: "destructive",
      });
    }
  };

  const handleZoomConnect = async () => {
    setConnectingProvider("zoom");
    try {
      const res = await fetch("/api/integrations/meetings/zoom/auth-url", { credentials: "include" });
      const data = await res.json();
      if (data.authUrl) {
        window.location.href = data.authUrl;
      } else {
        toast({
          title: "Error",
          description: "Could not get Zoom authorization URL.",
          variant: "destructive",
        });
        setConnectingProvider(null);
      }
    } catch {
      setConnectingProvider(null);
      toast({
        title: "Error",
        description: "Failed to initiate Zoom connection.",
        variant: "destructive",
      });
    }
  };

  const handleZoomDisconnect = async () => {
    try {
      await apiRequest("/api/integrations/meetings/zoom/disconnect", { method: "POST" });
      queryClient.invalidateQueries({ queryKey: ["/api/zoom/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/zoom/meetings"] });
      refetchStatuses();
      toast({
        title: "Disconnected",
        description: "Zoom has been disconnected.",
      });
    } catch {
      toast({
        title: "Error",
        description: "Failed to disconnect Zoom.",
        variant: "destructive",
      });
    }
  };

  const handleCreateZoomMeeting = () => {
    const { subject, date, startTime, duration, attendees, description } = zoomMeetingForm;
    if (!subject || !date || !startTime) {
      toast({
        title: "Missing fields",
        description: "Please provide a subject, date, and start time.",
        variant: "destructive",
      });
      return;
    }
    const startDateTime = `${date}T${startTime}:00`;
    const attendeeList = attendees
      .split(/[,\n]/)
      .map((e) => e.trim())
      .filter((e) => e.includes("@"));

    createZoomMeetingMutation.mutate({
      subject,
      startTime: startDateTime,
      duration: parseInt(duration) || 60,
      attendees: attendeeList,
      description,
      timeZone: userTimeZone,
    });
  };

  const handleEditZoomMeeting = () => {
    if (!editZoomMeeting) return;
    const startDateTime = `${editZoomForm.date}T${editZoomForm.startTime}:00`;
    const attendeeList = editZoomForm.attendees
      .split(/[,\n]/)
      .map((e) => e.trim())
      .filter((e) => e.includes("@"));
    updateZoomMeetingMutation.mutate({
      id: editZoomMeeting.id,
      data: {
        subject: editZoomForm.subject,
        startTime: startDateTime,
        duration: parseInt(editZoomForm.duration) || 60,
        attendees: attendeeList,
        description: editZoomForm.description,
        timeZone: userTimeZone,
      },
    });
  };

  const handleTeamsDisconnect = async () => {
    try {
      await apiRequest("/api/teams/disconnect", { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: ["/api/teams/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/teams/meetings"] });
      toast({
        title: "Disconnected",
        description: "Microsoft Teams has been disconnected.",
      });
    } catch {
      toast({
        title: "Error",
        description: "Failed to disconnect.",
        variant: "destructive",
      });
    }
  };

  const handleCreateMeeting = () => {
    const { subject, date, startTime, endTime, attendees } = meetingForm;
    if (!subject || !date || !startTime || !endTime) {
      toast({
        title: "Missing fields",
        description: "Please fill in all required fields.",
        variant: "destructive",
      });
      return;
    }
    const startDateTime = `${date}T${startTime}:00`;
    const endDateTime = `${date}T${endTime}:00`;
    if (endTime <= startTime) {
      toast({
        title: "Invalid time",
        description: "End time must be after start time.",
        variant: "destructive",
      });
      return;
    }
    const attendeeList = attendees
      ? attendees
          .split(/[,\n]+/)
          .map((e) => e.trim())
          .filter((e) => e.includes("@"))
      : [];
    createMeetingMutation.mutate({
      subject,
      startTime: startDateTime,
      endTime: endDateTime,
      attendees: attendeeList,
      timeZone: userTimeZone,
    });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied", description: "Link copied to clipboard." });
  };

  const getMeetingStatusBadge = (status: string) => {
    switch (status) {
      case "scheduled":
        return (
          <Badge
            variant="outline"
            className="text-blue-600 border-blue-300 bg-blue-50"
          >
            Scheduled
          </Badge>
        );
      case "completed":
        return (
          <Badge
            variant="outline"
            className="text-green-600 border-green-300 bg-green-50"
          >
            Completed
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const renderPlanContent = (plan: any) => {
    if (!plan) return null;
    return (
      <div className="space-y-4">
        <div>
          <h3 className="font-semibold text-lg">
            {plan.name || "Project Plan"}
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            {plan.description}
          </p>
        </div>
        {plan.tasks && plan.tasks.length > 0 && (
          <div>
            <h4 className="font-medium mb-2">Tasks ({plan.tasks.length})</h4>
            <div className="space-y-2">
              {plan.tasks.map((task: any, i: number) => (
                <div key={i} className="border rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-medium text-sm">{task.name}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      {task.priority && (
                        <Badge
                          variant={
                            task.priority === "high"
                              ? "destructive"
                              : task.priority === "medium"
                                ? "default"
                                : "secondary"
                          }
                        >
                          {task.priority}
                        </Badge>
                      )}
                      {task.dueDate && (
                        <span className="text-xs text-muted-foreground">
                          {task.dueDate}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {task.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
        {plan.milestones && plan.milestones.length > 0 && (
          <div>
            <h4 className="font-medium mb-2">Milestones</h4>
            <div className="space-y-1">
              {plan.milestones.map((m: any, i: number) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <Check className="h-4 w-4 text-green-600" />
                  <span>{m.name || m}</span>
                  {m.date && (
                    <span className="text-muted-foreground">- {m.date}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const handleOAuthMessage = useCallback(
    (event: MessageEvent) => {
      if (event.data?.type === "oauth-success") {
        queryClient.invalidateQueries({ queryKey: ["/api/teams/status"] });
        queryClient.invalidateQueries({ queryKey: ["/api/teams/meetings"] });
        queryClient.invalidateQueries({
          queryKey: ["/api/integrations/meetings/status"],
        });
        setConnectingProvider(null);
        toast({
          title: "Connected",
          description: `Successfully connected to ${event.data.provider}.`,
        });
      } else if (event.data?.type === "oauth-error") {
        setConnectingProvider(null);
        toast({
          title: "Connection failed",
          description: `Could not connect: ${event.data.error}`,
          variant: "destructive",
        });
      }
    },
    [queryClient, toast],
  );

  useEffect(() => {
    window.addEventListener("message", handleOAuthMessage);
    return () => window.removeEventListener("message", handleOAuthMessage);
  }, [handleOAuthMessage]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");
    if (connected) {
      toast({
        title: `${sourceLabel(connected)} connected!`,
        description: "You can now import conversations from this service.",
      });
      refetchStatuses();
      queryClient.invalidateQueries({ queryKey: ["/api/teams/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/teams/meetings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/google-meet/status"] });
      queryClient.invalidateQueries({
        queryKey: ["/api/google-meet/meetings"],
      });
      setConnectingProvider(null);
      const tabMap: Record<string, string> = {
        slack: "slack",
        zoom: "zoom",
        google_meet: "meet",
        teams: "teams",
      };
      if (tabMap[connected]) setActiveTab(tabMap[connected]);
      window.history.replaceState({}, "", "/meetings");
    }
    if (error) {
      const provider = params.get("provider");
      const detail = params.get("detail");
      toast({
        title: "Connection failed",
        description: `Could not connect ${provider ? sourceLabel(provider) : "the service"}. ${detail ? `(${decodeURIComponent(detail)})` : "Please try again."}`,
        variant: "destructive",
      });
      window.history.replaceState({}, "", "/meetings");
    }
    const teamsError = params.get("teams_error");
    if (teamsError) {
      setConnectingProvider(null);
      toast({
        title: "Teams Connection Failed",
        description:
          teamsError === "auth_failed"
            ? "Authentication failed. Please try again."
            : teamsError === "expired_state"
              ? "Session expired. Please try connecting again."
              : teamsError === "missing_code"
                ? "OAuth response was incomplete. Please try again."
                : `Error: ${teamsError}`,
        variant: "destructive",
      });
      window.history.replaceState({}, "", "/meetings");
    }
  }, []);

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      return await apiRequest("/api/conversations", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      setTitle("");
      setContent("");
      setParticipants("");
      setMeetingDate("");
      toast({
        title: "Conversation imported",
        description: "Your conversation has been saved.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to import conversation.",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest(`/api/conversations/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      toast({ title: "Deleted", description: "Conversation removed." });
    },
  });

  const summarizeMutation = useMutation({
    mutationFn: async (id: number) => {
      return await apiRequest(`/api/conversations/${id}/summarize`, {
        method: "PATCH",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      toast({
        title: "Summary generated",
        description: "AI summary has been added to the conversation.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to generate summary.",
        variant: "destructive",
      });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async (provider: string) => {
      return await apiRequest(
        `/api/integrations/meetings/${provider}/disconnect`,
        { method: "POST" },
      );
    },
    onSuccess: (_, provider) => {
      refetchStatuses();
      queryClient.invalidateQueries({ queryKey: ["/api/google-meet/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/google-meet/meetings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/teams/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/zoom/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/zoom/meetings"] });
      toast({
        title: "Disconnected",
        description: `${sourceLabel(provider)} has been disconnected.`,
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to disconnect. Please try again.",
        variant: "destructive",
      });
    },
  });

  const importMutation = useMutation({
    mutationFn: async (provider: string) => {
      const res = await apiRequest(
        `/api/integrations/meetings/${provider}/import`,
        { method: "POST" },
      );
      return res;
    },
    onSuccess: (data: any, provider) => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      refetchStatuses();
      const count = data.imported || 0;
      toast({
        title: count > 0 ? "Import complete" : "No conversations found",
        description:
          count > 0
            ? `Imported ${count} conversation${count !== 1 ? "s" : ""} from ${sourceLabel(provider)}.`
            : `No meeting transcripts were found in your ${sourceLabel(provider)} account. Make sure you have meeting recordings with transcripts enabled.`,
      });
    },
    onError: (_, provider) => {
      toast({
        title: "Import failed",
        description: `Could not import from ${sourceLabel(provider)}. The connection may have expired — try reconnecting.`,
        variant: "destructive",
      });
    },
  });

  const handleConnect = async (provider: string) => {
    setConnectingProvider(provider);
    try {
      const res = await fetch(
        `/api/integrations/meetings/${provider}/auth-url`,
        { credentials: "include" },
      );
      const data = await res.json();
      if (data.authUrl) {
        window.location.href = data.authUrl;
      } else {
        toast({
          title: "Error",
          description: "Could not get authorization URL.",
          variant: "destructive",
        });
        setConnectingProvider(null);
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to start connection.",
        variant: "destructive",
      });
      setConnectingProvider(null);
    }
  };

  const handleFileDrop = async (acceptedFiles: File[]) => {
    for (const file of acceptedFiles) {
      const text = await file.text();
      createMutation.mutate({
        title: file.name.replace(/\.[^/.]+$/, ""),
        source: "manual",
        content: text,
        participants: [],
        tags: [],
      });
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: handleFileDrop,
    accept: {
      "text/plain": [".txt"],
      "text/csv": [".csv"],
      "application/json": [".json"],
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        [".docx"],
    },
    maxSize: 50 * 1024 * 1024,
  });

  const handleSubmit = () => {
    if (!title.trim() || !content.trim()) {
      toast({
        title: "Missing fields",
        description: "Title and content are required.",
        variant: "destructive",
      });
      return;
    }
    createMutation.mutate({
      title: title.trim(),
      source,
      content: content.trim(),
      participants: participants
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      meetingDate: meetingDate || undefined,
      tags: [],
    });
  };

  const [rawTranscriptConv, setRawTranscriptConv] = useState<Conversation | null>(null);
  const [confirmSpeakerLabel, setConfirmSpeakerLabel] = useState<string | null>(null);
  const [confirmSpeakerName, setConfirmSpeakerName] = useState("");
  const transcriptAudioRef = useRef<HTMLAudioElement | null>(null);
  const [transcriptAudioTime, setTranscriptAudioTime] = useState(0);
  const [transcriptPlayingRange, setTranscriptPlayingRange] = useState<{ start: number; end: number } | null>(null);

  const seekAndPlay = useCallback((startMs: number, endMs?: number) => {
    const el = transcriptAudioRef.current;
    if (!el) return;
    try {
      el.currentTime = Math.max(0, startMs / 1000);
      if (typeof endMs === "number" && endMs > startMs) {
        setTranscriptPlayingRange({ start: startMs, end: endMs });
      } else {
        setTranscriptPlayingRange(null);
      }
      const p = el.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
  }, []);

  useEffect(() => {
    if (!rawTranscriptConv) {
      setTranscriptAudioTime(0);
      setTranscriptPlayingRange(null);
    }
  }, [rawTranscriptConv]);

  const confirmSpeakerMutation = useMutation({
    mutationFn: async (params: { conversationId: number; speakerLabel: string; name: string }) => {
      return await apiRequest(
        `/api/conversations/${params.conversationId}/confirm-speaker`,
        {
          method: "POST",
          body: JSON.stringify({ speakerLabel: params.speakerLabel, name: params.name }),
        },
      );
    },
    onSuccess: (data) => {
      toast({
        title: "Speaker confirmed",
        description: `Voice profile updated. ${data?.voiceprint?.canonicalName ?? ""} will now be recognized in future meetings.`,
      });
      if (data?.conversation) {
        setRawTranscriptConv(data.conversation);
      }
      setConfirmSpeakerLabel(null);
      setConfirmSpeakerName("");
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/voiceprints"] });
      queryClient.invalidateQueries({ queryKey: ["/api/voiceprints/talk-time"] });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't confirm speaker",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });
  const [showTranscription, setShowTranscription] = useState(false);
  const [transcriptionResult, setTranscriptionResult] = useState<string | null>(
    null,
  );
  const [editedTranscript, setEditedTranscript] = useState("");
  const [isEditingTranscript, setIsEditingTranscript] = useState(false);
  const [transcriptionTitle, setTranscriptionTitle] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);

  const transcribeMutation = useMutation({
    mutationFn: async (file: File) => {
      setUploadProgress(5);

      // Files larger than ~25 MB hit the Replit deployment edge proxy's
      // request-body limit, so for those we upload directly to object storage
      // via a presigned URL and then send only the object reference to
      // /api/transcribe. Small files keep using the simple multipart path.
      const DIRECT_UPLOAD_THRESHOLD = 25 * 1024 * 1024;
      const useDirectUpload = file.size > DIRECT_UPLOAD_THRESHOLD;

      try {
        if (useDirectUpload) {
          // Chunked upload — each chunk stays under the deployment proxy's
          // request-body limit so files up to 2 GB can be uploaded without
          // depending on object-storage signed URLs (which aren't reliably
          // available in production).
          const CHUNK_SIZE = 20 * 1024 * 1024; // 20 MB
          const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

          // 1) Init session.
          const initRes = await fetch("/api/transcribe/init", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filename: file.name,
              mimeType: file.type || "application/octet-stream",
              totalSize: file.size,
              totalChunks,
              chunkSize: CHUNK_SIZE,
            }),
          });
          if (!initRes.ok) {
            const t = await initRes.text();
            throw new Error(t || "Could not start upload");
          }
          const { uploadId, uploadToken } = (await initRes.json()) as {
            uploadId: string;
            uploadToken: string;
          };

          // 2) Upload chunks sequentially with real per-chunk progress.
          let bytesSent = 0;
          for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const blob = file.slice(start, end);

            await new Promise<void>((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              const qs = new URLSearchParams({
                uploadId,
                uploadToken,
                index: String(i),
              });
              xhr.open("POST", `/api/transcribe/chunk?${qs.toString()}`);
              xhr.setRequestHeader(
                "Content-Type",
                "application/octet-stream",
              );
              xhr.withCredentials = true;
              xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                  const sent = bytesSent + e.loaded;
                  // Reserve 90% of the bar for upload.
                  setUploadProgress(
                    Math.min(90, Math.round((sent / file.size) * 90)),
                  );
                }
              };
              xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) resolve();
                else
                  reject(
                    new Error(
                      `Chunk ${i + 1}/${totalChunks} failed (${xhr.status})`,
                    ),
                  );
              };
              xhr.onerror = () =>
                reject(new Error(`Chunk ${i + 1}/${totalChunks} failed`));
              xhr.send(blob);
            });
            bytesSent += blob.size;
            setUploadProgress(
              Math.min(90, Math.round((bytesSent / file.size) * 90)),
            );
          }

          // 3) Finalize: tell the server to transcribe the assembled file.
          setUploadProgress(92);
          const res = await fetch("/api/transcribe", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uploadId, uploadToken }),
          });
          setUploadProgress(100);
          if (!res.ok) {
            const text = await res.text();
            let errorObj: any;
            try { errorObj = JSON.parse(text); } catch { errorObj = { message: text || res.statusText }; }
            const error: any = new Error(errorObj.message || errorObj.error || "Transcription failed");
            error.status = res.status;
            error.data = errorObj;
            throw error;
          }
          return await res.json();
        }

        // Small-file path: multipart upload as before.
        const formData = new FormData();
        formData.append("audio", file);
        formData.append("title", file.name.replace(/\.[^/.]+$/, ""));
        formData.append("autoSave", "true");

        setUploadProgress(10);
        const progressInterval = setInterval(() => {
          setUploadProgress((prev) => Math.min(prev + 5, 90));
        }, 500);

        try {
          const res = await fetch("/api/transcribe", {
            method: "POST",
            body: formData,
            credentials: "include",
          });
          clearInterval(progressInterval);
          setUploadProgress(100);

          if (!res.ok) {
            const text = await res.text();
            let errorObj: any;
            try { errorObj = JSON.parse(text); } catch { errorObj = { message: text || res.statusText }; }
            const error: any = new Error(errorObj.message || errorObj.error || "Transcription failed");
            error.status = res.status;
            error.data = errorObj;
            throw error;
          }
          return await res.json();
        } catch (err) {
          clearInterval(progressInterval);
          throw err;
        }
      } catch (err) {
        setUploadProgress(0);
        throw err;
      }
    },
    onSuccess: (data) => {
      setTranscriptionResult(data.transcript);
      setEditedTranscript(data.transcript);
      setTranscriptionTitle(data.conversation?.title || "Transcription");
      setShowTranscription(true);
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/evidence"] });
      toast({
        title: "Transcription complete",
        description: "Audio has been transcribed and saved.",
      });
      setTimeout(() => setUploadProgress(0), 1000);
    },
    onError: (error: any) => {
      setUploadProgress(0);
      if (handleBudgetError(error)) return;
      toast({
        title: "Transcription failed",
        description: error.message || "Could not transcribe the file.",
        variant: "destructive",
      });
    },
  });

  const saveEditedTranscriptMutation = useMutation({
    mutationFn: async ({ id, content }: { id: number; content: string }) => {
      return await apiRequest(`/api/conversations`, {
        method: "POST",
        body: JSON.stringify({
          title: transcriptionTitle || "Edited Transcription",
          source: "transcription",
          content,
          participants: [],
          tags: ["transcription", "edited"],
        }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      setIsEditingTranscript(false);
      toast({
        title: "Saved",
        description: "Edited transcript saved as a new conversation.",
      });
    },
  });

  const handleAudioDrop = (acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      transcribeMutation.mutate(acceptedFiles[0]);
    }
  };

  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recorderError, setRecorderError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRecordingStream = useCallback(() => {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (recordingStreamRef.current) {
      recordingStreamRef.current.getTracks().forEach((t) => t.stop());
      recordingStreamRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {}
      stopRecordingStream();
    };
  }, [stopRecordingStream]);

  const startRecording = useCallback(async () => {
    setRecorderError(null);
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder === "undefined") {
      setRecorderError("Recording isn't supported in this browser. Try Chrome, Edge, or Firefox.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStreamRef.current = stream;
      let mimeType = "audio/webm;codecs=opus";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      }
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "mp4" : "webm";
        const blob = new Blob(recordedChunksRef.current, { type });
        stopRecordingStream();
        setIsRecording(false);
        if (blob.size === 0) {
          setRecorderError("Recording was empty. Please try again.");
          return;
        }
        const filename = `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
        const file = new File([blob], filename, { type });
        transcribeMutation.mutate(file);
      };
      recorder.onerror = () => {
        setRecorderError("Something went wrong while recording. Please try again.");
        stopRecordingStream();
        setIsRecording(false);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
      setIsRecording(true);
    } catch (err: unknown) {
      stopRecordingStream();
      setIsRecording(false);
      const name = err instanceof Error ? err.name : "";
      const message = err instanceof Error ? err.message : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setRecorderError("Microphone access was blocked. Allow microphone permission and try again.");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setRecorderError("No microphone was found. Connect a mic and try again.");
      } else {
        setRecorderError(message || "Couldn't start recording.");
      }
    }
  }, [stopRecordingStream, transcribeMutation]);

  const stopRecording = useCallback(() => {
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      } else {
        stopRecordingStream();
        setIsRecording(false);
      }
    } catch {
      stopRecordingStream();
      setIsRecording(false);
    }
  }, [stopRecordingStream]);

  const formatRecordingTime = (s: number) => {
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const ss = (s % 60).toString().padStart(2, "0");
    return `${m}:${ss}`;
  };

  const {
    getRootProps: getAudioRootProps,
    getInputProps: getAudioInputProps,
    isDragActive: isAudioDragActive,
  } = useDropzone({
    onDrop: handleAudioDrop,
    accept: {
      "audio/mpeg": [".mp3"],
      "audio/mp4": [".m4a"],
      "audio/wav": [".wav"],
      "audio/webm": [".webm"],
      "video/mp4": [".mp4"],
      "video/webm": [".webm"],
    },
    maxSize: 2 * 1024 * 1024 * 1024, // 2 GB
    maxFiles: 1,
  });

  const connectedCount = Object.values(integrationStatuses).filter(
    (s) => s?.connected,
  ).length;

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
              <MessageSquare className="h-6 w-6 text-emerald-600" />
              Meetings & Conversations
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Import conversations from your meetings, chats, and calls. Attach
              them to AI chat for context-aware analysis.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {connectedCount > 0 && (
              <Badge
                variant="outline"
                className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200"
              >
                <CheckCircle className="h-3 w-3 mr-1" />
                {connectedCount} connected
              </Badge>
            )}
            <Badge variant="outline" className="text-sm">
              {conversations.length} conversation
              {conversations.length !== 1 ? "s" : ""}
            </Badge>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <div
            className={
              activeTab === "intelligence" ? "lg:col-span-5" : "lg:col-span-2"
            }
          >
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <Plus className="h-4 w-4 text-emerald-600" />
                  Import Conversation
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Tabs value={activeTab} onValueChange={setActiveTab}>
                  <TabsList className="flex flex-wrap items-start h-auto gap-1 justify-start">
                    <TabsTrigger value="all" className="text-xs px-2.5">
                      <Calendar className="h-3.5 w-3.5 mr-1" />
                      All
                    </TabsTrigger>
                    <TabsTrigger value="manual" className="text-xs px-2.5">
                      <FileText className="h-3.5 w-3.5 mr-1" />
                      Manual
                    </TabsTrigger>
                    <TabsTrigger value="audio" className="text-xs px-2.5">
                      <Mic className="h-3.5 w-3.5 mr-1" />
                      Audio
                    </TabsTrigger>
                    <TabsTrigger value="zoom" className="text-xs px-2.5 relative">
                      <SiZoom className="h-3.5 w-3.5 mr-1" />
                      Zoom
                      {isZoomConnected && (
                        <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full" />
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="meet" className="text-xs px-2.5 relative">
                      <SiGooglemeet className="h-3.5 w-3.5 mr-1" />
                      Meet
                      {(isGoogleMeetConnected ||
                        integrationStatuses.google_meet?.connected) && (
                        <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full" />
                      )}
                    </TabsTrigger>
                    <TabsTrigger
                      value="teams"
                      className="text-xs px-2.5 relative"
                    >
                      <Users className="h-3.5 w-3.5 mr-1" />
                      Teams
                      {isTeamsConnected && (
                        <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full" />
                      )}
                    </TabsTrigger>
                    <TabsTrigger
                      value="discord"
                      className="text-xs px-2.5 relative"
                    >
                      <MessagesSquare className="h-3.5 w-3.5 mr-1" />
                      Discord
                    </TabsTrigger>
                    <TabsTrigger
                      value="intelligence"
                      className="text-xs px-2.5"
                      data-testid="tab-intelligence"
                    >
                      <Brain className="h-3.5 w-3.5 mr-1" />
                      Intelligence
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="all" className="mt-4 space-y-3">
                    {(() => {
                      const allMeetings: Array<{
                        id: number;
                        subject: string;
                        startTime: string | Date;
                        endTime: string | Date;
                        source: "google_meet" | "teams" | "zoom";
                        joinUrl?: string | null;
                        meetLink?: string | null;
                        attendees?: string[];
                        status?: string | null;
                      }> = [];
                      if (googleMeetMeetings) {
                        googleMeetMeetings.forEach((m) =>
                          allMeetings.push({
                            id: m.id,
                            subject: m.subject,
                            startTime: m.startTime,
                            endTime: m.endTime,
                            source: "google_meet",
                            meetLink: m.meetLink,
                            attendees: m.attendees || [],
                            status: m.status,
                          })
                        );
                      }
                      if (teamsMeetings) {
                        teamsMeetings.forEach((m) =>
                          allMeetings.push({
                            id: m.id,
                            subject: m.subject,
                            startTime: m.startTime,
                            endTime: m.endTime,
                            source: "teams",
                            joinUrl: m.joinUrl,
                            attendees: m.attendees || [],
                            status: m.status,
                          })
                        );
                      }
                      if (zoomMeetings) {
                        zoomMeetings.forEach((m) =>
                          allMeetings.push({
                            id: m.id,
                            subject: m.subject,
                            startTime: m.startTime,
                            endTime: m.endTime,
                            source: "zoom",
                            joinUrl: m.joinUrl,
                            attendees: m.attendees || [],
                            status: m.status,
                          })
                        );
                      }
                      allMeetings.sort(
                        (a, b) =>
                          new Date(b.startTime).getTime() -
                          new Date(a.startTime).getTime()
                      );
                      const isAnyLoading = meetingsLoading || googleMeetLoading || zoomMeetingsLoading;
                      const noConnections = !isGoogleMeetConnected && !isTeamsConnected && !isZoomConnected;

                      if (isAnyLoading) {
                        return (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                          </div>
                        );
                      }

                      if (noConnections) {
                        return (
                          <div className="text-center py-8 text-slate-500">
                            <Calendar className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                            <p className="text-sm font-medium">No integrations connected</p>
                            <p className="text-xs mt-1">Connect Google Meet, Teams, or Zoom to see all your meetings here.</p>
                          </div>
                        );
                      }

                      if (allMeetings.length === 0) {
                        return (
                          <div className="text-center py-8 text-slate-500">
                            <Calendar className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                            <p className="text-sm font-medium">No meetings yet</p>
                            <p className="text-xs mt-1">Create meetings from the Meet, Teams, or Zoom tabs.</p>
                          </div>
                        );
                      }

                      return (
                        <ScrollArea className="h-[400px]">
                          <div className="space-y-2">
                            {allMeetings.map((meeting) => {
                              const start = new Date(meeting.startTime);
                              const end = new Date(meeting.endTime);
                              const link = meeting.source === "google_meet" ? meeting.meetLink : meeting.joinUrl;
                              return (
                                <div
                                  key={`${meeting.source}-${meeting.id}`}
                                  className="border rounded-lg p-3 hover:border-emerald-200 transition-colors"
                                >
                                  <div className="flex items-start justify-between">
                                    <div className="flex items-center gap-2 min-w-0">
                                      {meeting.source === "google_meet" ? (
                                        <SiGooglemeet className="h-4 w-4 text-blue-600 shrink-0" />
                                      ) : meeting.source === "teams" ? (
                                        <Users className="h-4 w-4 text-purple-600 shrink-0" />
                                      ) : (
                                        <SiZoom className="h-4 w-4 text-blue-500 shrink-0" />
                                      )}
                                      <span className="text-sm font-medium truncate">{meeting.subject}</span>
                                      <Badge variant="outline" className="text-[10px] shrink-0">
                                        {meeting.source === "google_meet" ? "Meet" : meeting.source === "teams" ? "Teams" : "Zoom"}
                                      </Badge>
                                    </div>
                                    {link && (
                                      <a
                                        href={link}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="shrink-0 ml-2"
                                      >
                                        <Button size="sm" variant="outline" className="h-7 text-xs gap-1">
                                          <ExternalLink className="h-3 w-3" />
                                          Join
                                        </Button>
                                      </a>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-3 mt-2 text-xs text-slate-500">
                                    <span className="flex items-center gap-1">
                                      <Calendar className="h-3 w-3" />
                                      {format(start, "MMM d, yyyy")}
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <Clock className="h-3 w-3" />
                                      {format(start, "h:mm a")} - {format(end, "h:mm a")} {tzAbbr}
                                    </span>
                                    {meeting.attendees && meeting.attendees.length > 0 && (
                                      <Popover>
                                        <PopoverTrigger asChild>
                                          <button className="flex items-center gap-1 hover:text-emerald-600 cursor-pointer">
                                            <Users className="h-3 w-3" />
                                            {meeting.attendees.length} attendee{meeting.attendees.length !== 1 ? "s" : ""}
                                          </button>
                                        </PopoverTrigger>
                                        <PopoverContent className="w-56 p-2">
                                          <div className="text-xs font-medium mb-1">Attendees</div>
                                          <div className="space-y-1">
                                            {meeting.attendees.map((email, i) => (
                                              <div key={i} className="text-xs text-slate-600 truncate">{email}</div>
                                            ))}
                                          </div>
                                        </PopoverContent>
                                      </Popover>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </ScrollArea>
                      );
                    })()}
                  </TabsContent>

                  <TabsContent value="manual" className="mt-4 space-y-3">
                    <div
                      {...getRootProps()}
                      className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
                        isDragActive
                          ? "border-emerald-400 bg-emerald-50"
                          : "border-slate-200 hover:border-emerald-300 hover:bg-emerald-50/30"
                      }`}
                    >
                      <input {...getInputProps()} />
                      <Upload className="h-6 w-6 mx-auto text-slate-400 mb-2" />
                      <p className="text-sm text-slate-600 font-medium">
                        {isDragActive
                          ? "Drop files here..."
                          : "Drop transcript files here"}
                      </p>
                      <p className="text-xs text-slate-400 mt-1">
                        .txt, .csv, .json, .pdf, .docx
                      </p>
                    </div>

                    <div className="relative">
                      <div className="absolute inset-0 flex items-center">
                        <span className="w-full border-t" />
                      </div>
                      <div className="relative flex justify-center text-xs">
                        <span className="bg-white px-2 text-slate-400">
                          or paste manually
                        </span>
                      </div>
                    </div>

                    <Input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Conversation title..."
                    />
                    <Textarea
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      placeholder="Paste the conversation transcript, meeting notes, or chat export here..."
                      className="min-h-[160px] resize-none text-sm"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        value={participants}
                        onChange={(e) => setParticipants(e.target.value)}
                        placeholder="Participants (comma-separated)"
                      />
                      <Input
                        type="date"
                        value={meetingDate}
                        onChange={(e) => setMeetingDate(e.target.value)}
                      />
                    </div>
                    <Button
                      onClick={handleSubmit}
                      disabled={createMutation.isPending}
                      className="w-full bg-emerald-600 hover:bg-emerald-700"
                    >
                      {createMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4 mr-2" />
                      )}
                      Import Conversation
                    </Button>
                  </TabsContent>

                  <TabsContent value="audio" className="mt-4 space-y-3">
                    <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-4">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-3">
                          <div className={`h-10 w-10 rounded-full flex items-center justify-center ${isRecording ? "bg-red-100 animate-pulse" : "bg-violet-100"}`}>
                            <Mic className={`h-5 w-5 ${isRecording ? "text-red-600" : "text-violet-600"}`} />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-slate-800">
                              {isRecording ? "Recording in progress" : "Record audio in your browser"}
                            </p>
                            <p className="text-xs text-slate-500">
                              {isRecording
                                ? `Mic active · ${formatRecordingTime(recordingSeconds)}`
                                : "Capture a meeting or voice note and transcribe it instantly"}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {isRecording ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              onClick={stopRecording}
                              data-testid="button-stop-recording"
                              className="gap-1.5"
                            >
                              <X className="h-4 w-4" />
                              Stop
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              onClick={startRecording}
                              disabled={transcribeMutation.isPending}
                              data-testid="button-start-recording"
                              className="gap-1.5 bg-red-500 hover:bg-red-600 text-white"
                            >
                              <Mic className="h-4 w-4" />
                              Record
                            </Button>
                          )}
                        </div>
                      </div>
                      {recorderError && (
                        <div className="mt-3 flex items-start gap-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-md p-2">
                          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                          <span>{recorderError}</span>
                        </div>
                      )}
                    </div>

                    <div
                      {...getAudioRootProps()}
                      className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                        isAudioDragActive
                          ? "border-violet-400 bg-violet-50"
                          : "border-slate-200 hover:border-violet-300 hover:bg-violet-50/30"
                      }`}
                    >
                      <input {...getAudioInputProps()} />
                      {transcribeMutation.isPending ? (
                        <>
                          <Loader2 className="h-8 w-8 mx-auto text-violet-500 mb-2 animate-spin" />
                          <p className="text-sm text-violet-600 font-medium">
                            Transcribing audio...
                          </p>
                          <p className="text-xs text-slate-400 mt-1">
                            This may take a moment
                          </p>
                        </>
                      ) : (
                        <>
                          <div className="flex items-center justify-center gap-2 mb-2">
                            <Mic className="h-6 w-6 text-violet-400" />
                            <Video className="h-6 w-6 text-violet-400" />
                          </div>
                          <p className="text-sm text-slate-600 font-medium">
                            {isAudioDragActive
                              ? "Drop recording here..."
                              : "Upload a recording to transcribe"}
                          </p>
                          <p className="text-xs text-slate-400 mt-1">
                            MP3, MP4, WAV, M4A, WebM — up to 2 GB (with speaker
                            diarization)
                          </p>
                        </>
                      )}
                    </div>

                    {uploadProgress > 0 && (
                      <div className="space-y-1">
                        <Progress value={uploadProgress} className="h-2" />
                        <p className="text-xs text-slate-400 text-center">
                          {uploadProgress < 90
                            ? "Uploading & transcribing..."
                            : uploadProgress < 100
                              ? "Processing..."
                              : "Done!"}
                        </p>
                      </div>
                    )}

                    {showTranscription && transcriptionResult && (
                      <div className="border rounded-lg p-3 bg-violet-50/50 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Sparkles className="h-4 w-4 text-violet-600" />
                            <span className="text-sm font-semibold text-violet-700">
                              Transcription Result
                            </span>
                          </div>
                          <div className="flex items-center gap-1">
                            {!isEditingTranscript ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-xs h-7"
                                onClick={() => setIsEditingTranscript(true)}
                              >
                                <Edit3 className="h-3 w-3 mr-1" />
                                Edit
                              </Button>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-xs h-7 text-emerald-600"
                                  onClick={() =>
                                    saveEditedTranscriptMutation.mutate({
                                      id: 0,
                                      content: editedTranscript,
                                    })
                                  }
                                  disabled={
                                    saveEditedTranscriptMutation.isPending
                                  }
                                >
                                  <Save className="h-3 w-3 mr-1" />
                                  Save
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-xs h-7"
                                  onClick={() => {
                                    setIsEditingTranscript(false);
                                    setEditedTranscript(transcriptionResult);
                                  }}
                                >
                                  <X className="h-3 w-3" />
                                </Button>
                              </>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs h-7 text-slate-400"
                              onClick={() => {
                                setShowTranscription(false);
                                setTranscriptionResult(null);
                              }}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                        {isEditingTranscript ? (
                          <Textarea
                            value={editedTranscript}
                            onChange={(e) =>
                              setEditedTranscript(e.target.value)
                            }
                            className="min-h-[160px] text-xs resize-none"
                          />
                        ) : (
                          <p className="text-xs text-slate-700 whitespace-pre-wrap max-h-[200px] overflow-auto">
                            {transcriptionResult}
                          </p>
                        )}
                      </div>
                    )}
                  </TabsContent>

                  {/* <TabsContent value="slack">
                    <IntegrationPanel
                      provider="slack"
                      icon={<SiSlack className="h-6 w-6" />}
                      name="Slack"
                      description="Connect your Slack workspace to import channel conversations and direct messages."
                      status={integrationStatuses.slack || { connected: false }}
                      onConnect={() => handleConnect("slack")}
                      onDisconnect={() => disconnectMutation.mutate("slack")}
                      onImport={() => importMutation.mutate("slack")}
                      isConnecting={connectingProvider === "slack"}
                      isImporting={
                        importMutation.isPending &&
                        importMutation.variables === "slack"
                      }
                      accentColor="bg-purple-500"
                    />
                  </TabsContent> */}
                  <TabsContent value="zoom">
                    {!isZoomConnected ? (
                      <div className="flex flex-col items-center justify-center py-8 text-center space-y-4">
                        <div className="h-14 w-14 rounded-xl bg-blue-100 flex items-center justify-center text-blue-500">
                          <SiZoom className="h-6 w-6" />
                        </div>
                        <div>
                          <h3 className="text-lg font-semibold text-slate-700 mb-1">Zoom</h3>
                          <p className="text-sm text-slate-500 max-w-sm">
                            Create Zoom meetings, send invitations, and manage your schedule.
                          </p>
                        </div>
                        {!isZoomConfigured && (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted rounded-md px-3 py-2">
                            <AlertCircle className="h-4 w-4 shrink-0" />
                            <span>OAuth credentials not configured. Add Zoom app credentials to enable.</span>
                          </div>
                        )}
                        <Button
                          variant="outline"
                          className="gap-2"
                          onClick={handleZoomConnect}
                          disabled={connectingProvider === "zoom"}
                        >
                          {connectingProvider === "zoom" ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ExternalLink className="h-4 w-4" />
                          )}
                          Connect Zoom
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-4 mt-4">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <div className="flex items-center gap-2">
                            <SiZoom className="h-4 w-4 text-blue-500" />
                            <span className="text-sm font-medium">Zoom</span>
                            <Badge variant="secondary" className="text-xs">Connected</Badge>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs h-7"
                              onClick={() => setShowCreateZoomMeeting(true)}
                            >
                              <Video className="h-3 w-3 mr-1" />
                              Create Meeting
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs h-7"
                              onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/zoom/meetings"] })}
                              disabled={zoomMeetingsLoading}
                            >
                              <RefreshCw className={`h-3 w-3 mr-1 ${zoomMeetingsLoading ? "animate-spin" : ""}`} />
                              Refresh
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs h-7 text-red-500"
                              onClick={handleZoomDisconnect}
                            >
                              <Link2Off className="h-3 w-3 mr-1" />
                              Disconnect
                            </Button>
                          </div>
                        </div>
                        {zoomMeetingsLoading ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                            <span className="ml-2 text-sm text-muted-foreground">Loading meetings...</span>
                          </div>
                        ) : !zoomMeetings || zoomMeetings.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-8 text-center">
                            <Video className="h-8 w-8 text-muted-foreground mb-2" />
                            <p className="text-sm text-muted-foreground mb-3">No meetings yet.</p>
                            <Button size="sm" onClick={() => setShowCreateZoomMeeting(true)}>
                              <Plus className="h-3.5 w-3.5 mr-1" />
                              Create Meeting
                            </Button>
                          </div>
                        ) : (
                          <ScrollArea className="h-auto max-h-[300px] overflow-y-auto">
                            <div className="space-y-2 pr-3">
                              {zoomMeetings.map((meeting) => (
                                <div
                                  key={meeting.id}
                                  className="border rounded-lg p-3 hover:border-blue-200 transition-colors"
                                >
                                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                                    <h4 className="text-sm font-medium truncate">{meeting.subject}</h4>
                                    {getMeetingStatusBadge(meeting.status)}
                                  </div>
                                  <div className="flex items-center gap-3 text-xs text-muted-foreground mb-2 flex-wrap">
                                    <span className="flex items-center gap-1">
                                      <Calendar className="h-3 w-3" />
                                      {format(new Date(meeting.startTime), "MMM d, yyyy")}
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <Clock className="h-3 w-3" />
                                      {format(new Date(meeting.startTime), "h:mm a")}
                                      {meeting.duration && ` (${meeting.duration}min)`}
                                      {" "}{tzAbbr}
                                    </span>
                                    {meeting.attendees && meeting.attendees.length > 0 && (
                                      <Popover>
                                        <PopoverTrigger asChild>
                                          <button className="flex items-center gap-1 hover:text-primary cursor-pointer transition-colors">
                                            <Users className="h-3 w-3" />
                                            {meeting.attendees.length} attendee{meeting.attendees.length !== 1 ? "s" : ""}
                                          </button>
                                        </PopoverTrigger>
                                        <PopoverContent className="w-64 p-3">
                                          <h4 className="text-sm font-medium mb-2">Attendees</h4>
                                          <div className="space-y-1">
                                            {meeting.attendees.map((email, i) => (
                                              <div key={i} className="text-xs text-muted-foreground flex items-center gap-1.5">
                                                <Mail className="h-3 w-3 shrink-0" />
                                                <span className="truncate">{email}</span>
                                              </div>
                                            ))}
                                          </div>
                                        </PopoverContent>
                                      </Popover>
                                    )}
                                  </div>
                                  {meeting.description && (
                                    <p className="text-xs text-muted-foreground mb-2 line-clamp-2">{meeting.description}</p>
                                  )}
                                  {meeting.transcript && (
                                    <div className="bg-slate-50 rounded p-2 text-xs text-muted-foreground max-h-[60px] overflow-hidden mb-2">
                                      {meeting.transcript.substring(0, 150)}...
                                    </div>
                                  )}
                                  <div className="flex items-center gap-1 flex-wrap">
                                    {meeting.joinUrl && (
                                      <a href={meeting.joinUrl} target="_blank" rel="noopener noreferrer">
                                        <Button size="sm" variant="outline" className="h-7 text-xs gap-1">
                                          <ExternalLink className="h-3 w-3" />
                                          Join
                                        </Button>
                                      </a>
                                    )}
                                    {meeting.joinUrl && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 text-xs gap-1"
                                        onClick={() => {
                                          navigator.clipboard.writeText(meeting.joinUrl!);
                                          toast({ title: "Copied", description: "Join link copied to clipboard." });
                                        }}
                                      >
                                        <Copy className="h-3 w-3" />
                                        Copy Link
                                      </Button>
                                    )}
                                    {!meeting.transcript ? (
                                      <>
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="text-xs h-7"
                                          onClick={() => fetchZoomTranscriptMutation.mutate(meeting.id)}
                                          disabled={fetchingZoomTranscriptId === meeting.id}
                                        >
                                          {fetchingZoomTranscriptId === meeting.id ? (
                                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                          ) : (
                                            <FileText className="h-3 w-3 mr-1" />
                                          )}
                                          Fetch Transcript
                                        </Button>
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="text-xs h-7"
                                          onClick={() => {
                                            setSelectedZoomMeeting(meeting);
                                            setShowZoomTranscriptDialog(true);
                                          }}
                                        >
                                          <ClipboardPaste className="h-3 w-3 mr-1" />
                                          Paste
                                        </Button>
                                      </>
                                    ) : (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="text-xs h-7"
                                        onClick={() => {
                                          setSelectedZoomMeeting(meeting);
                                          setShowZoomTranscriptDialog(true);
                                        }}
                                      >
                                        <Eye className="h-3 w-3 mr-1" />
                                        View
                                      </Button>
                                    )}
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 text-xs gap-1"
                                      onClick={() => {
                                        setEditZoomMeeting(meeting);
                                        setEditZoomForm({
                                          subject: meeting.subject,
                                          date: format(new Date(meeting.startTime), "yyyy-MM-dd"),
                                          startTime: format(new Date(meeting.startTime), "HH:mm"),
                                          duration: String(meeting.duration || 60),
                                          attendees: (meeting.attendees || []).join(", "),
                                          description: meeting.description || "",
                                        });
                                      }}
                                    >
                                      <Edit3 className="h-3 w-3" />
                                      Edit
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 text-xs gap-1 text-red-500 hover:text-red-600"
                                      onClick={() => setDeleteZoomMeetingItem(meeting)}
                                    >
                                      <Trash2 className="h-3 w-3" />
                                      Delete
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                        )}
                      </div>
                    )}
                  </TabsContent>
                  <TabsContent value="meet">
                    {!isGoogleMeetConnected ? (
                      <div className="flex flex-col items-center justify-center py-8 text-center space-y-4">
                        <div className="h-14 w-14 rounded-xl bg-green-100 flex items-center justify-center text-green-600">
                          <SiGooglemeet className="h-6 w-6" />
                        </div>
                        <div>
                          <h3 className="text-lg font-semibold text-slate-700 mb-1">
                            Google Meet
                          </h3>
                          <p className="text-sm text-slate-500 max-w-sm">
                            Schedule Google Meet meetings, generate meet links,
                            and fetch transcripts from Google Drive.
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          className="gap-2"
                          onClick={handleGoogleMeetConnect}
                          disabled={connectingProvider === "google_meet"}
                        >
                          {connectingProvider === "google_meet" ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ExternalLink className="h-4 w-4" />
                          )}
                          Connect Google Account
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-4 mt-4">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <div className="flex items-center gap-2">
                            <SiGooglemeet className="h-4 w-4 text-green-600" />
                            <span className="text-sm font-medium">
                              Google Meet
                            </span>
                            <Badge variant="secondary" className="text-xs">
                              Connected
                            </Badge>
                          </div>
                          <div className="flex items-center gap-1 flex-wrap">
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs h-7"
                              onClick={() => setShowCreateGoogleMeeting(true)}
                            >
                              <SiGooglemeet className="h-3 w-3 mr-1" />
                              New Meeting
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs h-7"
                              onClick={() =>
                                importCalendarMeetingsMutation.mutate()
                              }
                              disabled={
                                importCalendarMeetingsMutation.isPending
                              }
                            >
                              {importCalendarMeetingsMutation.isPending ? (
                                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                              ) : (
                                <Calendar className="h-3 w-3 mr-1" />
                              )}
                              Import from Calendar
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs h-7"
                              onClick={() =>
                                queryClient.invalidateQueries({
                                  queryKey: ["/api/google-meet/meetings"],
                                })
                              }
                              disabled={googleMeetLoading}
                            >
                              <RefreshCw
                                className={`h-3 w-3 mr-1 ${googleMeetLoading ? "animate-spin" : ""}`}
                              />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs h-7 text-red-500"
                              onClick={handleGoogleMeetDisconnect}
                            >
                              <Link2Off className="h-3 w-3 mr-1" />
                              Disconnect
                            </Button>
                          </div>
                        </div>
                        {googleMeetLoading ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                            <span className="ml-2 text-sm text-muted-foreground">
                              Loading meetings...
                            </span>
                          </div>
                        ) : !googleMeetMeetings ||
                          googleMeetMeetings.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-8 text-center space-y-3">
                            <SiGooglemeet className="h-8 w-8 text-muted-foreground mb-1" />
                            <p className="text-sm text-muted-foreground">
                              No meetings yet.
                            </p>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setShowCreateGoogleMeeting(true)}
                              >
                                <Plus className="h-3.5 w-3.5 mr-1" />
                                New Meeting
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  importCalendarMeetingsMutation.mutate()
                                }
                                disabled={
                                  importCalendarMeetingsMutation.isPending
                                }
                              >
                                {importCalendarMeetingsMutation.isPending ? (
                                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                                ) : (
                                  <Calendar className="h-3.5 w-3.5 mr-1" />
                                )}
                                Import from Calendar
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <ScrollArea className="h-auto max-h-[300px] overflow-y-auto">
                            <div className="space-y-2 pr-3">
                              {googleMeetMeetings.map((meeting) => (
                                <div
                                  key={meeting.id}
                                  className="border rounded-lg p-3 hover:border-green-200 transition-colors"
                                >
                                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                                    <h4 className="text-sm font-medium truncate">
                                      {meeting.subject}
                                    </h4>
                                    {getMeetingStatusBadge(meeting.status)}
                                  </div>
                                  <div className="flex items-center gap-3 text-xs text-muted-foreground mb-2 flex-wrap">
                                    <span className="flex items-center gap-1">
                                      <Calendar className="h-3 w-3" />
                                      {format(
                                        new Date(meeting.startTime),
                                        "MMM d, yyyy",
                                      )}
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <Clock className="h-3 w-3" />
                                      {format(
                                        new Date(meeting.startTime),
                                        "h:mm a",
                                      )}{" "}
                                      -{" "}
                                      {format(
                                        new Date(meeting.endTime),
                                        "h:mm a",
                                      )}{" "}
                                      {tzAbbr}
                                    </span>
                                    {meeting.attendees &&
                                      meeting.attendees.length > 0 && (
                                        <Popover>
                                          <PopoverTrigger asChild>
                                            <button className="flex items-center gap-1 hover:text-primary cursor-pointer transition-colors">
                                              <Users className="h-3 w-3" />
                                              {meeting.attendees.length} attendee{meeting.attendees.length !== 1 ? "s" : ""}
                                            </button>
                                          </PopoverTrigger>
                                          <PopoverContent className="w-64 p-3" align="start">
                                            <p className="text-xs font-medium mb-2">Attendees ({meeting.attendees.length})</p>
                                            <div className="space-y-1 max-h-[150px] overflow-y-auto">
                                              {meeting.attendees.map((email: string, i: number) => (
                                                <div key={i} className="text-xs text-muted-foreground truncate">{email}</div>
                                              ))}
                                            </div>
                                          </PopoverContent>
                                        </Popover>
                                      )}
                                    {meeting.organizerEmail && (
                                      <span className="text-xs text-muted-foreground truncate max-w-[180px]">
                                        {meeting.organizerEmail}
                                      </span>
                                    )}
                                  </div>
                                  {meeting.transcript && (
                                    <div className="bg-slate-50 rounded p-2 text-xs text-muted-foreground max-h-[60px] overflow-hidden mb-2">
                                      {meeting.transcript.substring(0, 150)}...
                                    </div>
                                  )}
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    {meeting.meetLink && (
                                      <>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="text-xs h-7 bg-green-50 text-green-700 border-green-200"
                                          onClick={() =>
                                            window.open(
                                              meeting.meetLink!,
                                              "_blank",
                                            )
                                          }
                                        >
                                          <ExternalLink className="h-3 w-3 mr-1" />
                                          Join
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="text-xs h-7"
                                          onClick={() =>
                                            copyToClipboard(meeting.meetLink!)
                                          }
                                        >
                                          <Copy className="h-3 w-3 mr-1" />
                                          Copy Link
                                        </Button>
                                      </>
                                    )}
                                    {!meeting.transcript ? (
                                      <>
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="text-xs h-7"
                                          onClick={() =>
                                            fetchGoogleTranscriptMutation.mutate(
                                              meeting.id,
                                            )
                                          }
                                          disabled={
                                            fetchingGoogleTranscriptId === meeting.id
                                          }
                                        >
                                          {fetchingGoogleTranscriptId === meeting.id ? (
                                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                          ) : (
                                            <FileText className="h-3 w-3 mr-1" />
                                          )}
                                          Fetch Transcript
                                        </Button>
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="text-xs h-7"
                                          onClick={() => {
                                            setSelectedGoogleMeeting(meeting);
                                            setShowGoogleTranscriptDialog(true);
                                          }}
                                        >
                                          <ClipboardPaste className="h-3 w-3 mr-1" />
                                          Paste
                                        </Button>
                                      </>
                                    ) : (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="text-xs h-7"
                                        onClick={() => {
                                          setSelectedGoogleMeeting(meeting);
                                          setShowGoogleTranscriptDialog(true);
                                        }}
                                      >
                                        <Eye className="h-3 w-3 mr-1" />
                                        View
                                      </Button>
                                    )}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-xs h-7"
                                      onClick={() =>
                                        openEditGoogleMeeting(meeting)
                                      }
                                    >
                                      <Edit3 className="h-3 w-3 mr-1" />
                                      Edit
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-xs h-7 text-red-500 hover:text-red-700"
                                      onClick={() =>
                                        setDeleteGoogleMeetingItem(meeting)
                                      }
                                    >
                                      <Trash2 className="h-3 w-3 mr-1" />
                                      Delete
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                        )}
                      </div>
                    )}
                  </TabsContent>
                  <TabsContent value="teams">
                    {!isTeamsConnected ? (
                      <div className="flex flex-col items-center justify-center py-8 text-center space-y-4">
                        <div className="h-14 w-14 rounded-xl bg-indigo-100 flex items-center justify-center text-indigo-500">
                          <Video className="h-6 w-6" />
                        </div>
                        <div>
                          <h3 className="text-lg font-semibold text-slate-700 mb-1">
                            Microsoft Teams
                          </h3>
                          <p className="text-sm text-slate-500 max-w-sm">
                            Create Teams meetings, fetch transcripts, and
                            generate AI-powered project plans.
                          </p>
                        </div>
                        {!isTeamsConfigured && (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted rounded-md px-3 py-2">
                            <AlertCircle className="h-4 w-4 shrink-0" />
                            <span>
                              OAuth credentials not configured. Add Microsoft
                              Azure AD app credentials to enable.
                            </span>
                          </div>
                        )}
                        <Button
                          variant="outline"
                          className="gap-2"
                          onClick={handleTeamsConnect}
                          disabled={connectingProvider === "teams"}
                        >
                          {connectingProvider === "teams" ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ExternalLink className="h-4 w-4" />
                          )}
                          Connect Microsoft Teams
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-4 mt-4">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <div className="flex items-center gap-2">
                            <Video className="h-4 w-4 text-blue-600" />
                            <span className="text-sm font-medium">
                              Microsoft Teams
                            </span>
                            <Badge variant="secondary" className="text-xs">
                              Connected
                            </Badge>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs h-7"
                              onClick={() => setShowCreateMeeting(true)}
                            >
                              <Video className="h-3 w-3 mr-1" />
                              Create Meeting
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs h-7"
                              onClick={() =>
                                queryClient.invalidateQueries({
                                  queryKey: ["/api/teams/meetings"],
                                })
                              }
                              disabled={meetingsLoading}
                            >
                              <RefreshCw
                                className={`h-3 w-3 mr-1 ${meetingsLoading ? "animate-spin" : ""}`}
                              />
                              Refresh
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs h-7 text-red-500"
                              onClick={handleTeamsDisconnect}
                            >
                              <Link2Off className="h-3 w-3 mr-1" />
                              Disconnect
                            </Button>
                          </div>
                        </div>
                        {meetingsLoading ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                            <span className="ml-2 text-sm text-muted-foreground">
                              Loading meetings...
                            </span>
                          </div>
                        ) : !teamsMeetings || teamsMeetings.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-8 text-center">
                            <Video className="h-8 w-8 text-muted-foreground mb-2" />
                            <p className="text-sm text-muted-foreground mb-3">
                              No meetings yet.
                            </p>
                            <Button
                              size="sm"
                              onClick={() => setShowCreateMeeting(true)}
                            >
                              <Plus className="h-3.5 w-3.5 mr-1" />
                              Create Meeting
                            </Button>
                          </div>
                        ) : (
                          <ScrollArea className="h-auto max-h-[300px] overflow-y-auto">
                            <div className="space-y-2 pr-3">
                              {teamsMeetings.map((meeting) => (
                                <div
                                  key={meeting.id}
                                  className="border rounded-lg p-3 hover:border-indigo-200 transition-colors"
                                >
                                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                                    <h4 className="text-sm font-medium truncate">
                                      {meeting.subject}
                                    </h4>
                                    {getMeetingStatusBadge(meeting.status)}
                                  </div>
                                  <div className="flex items-center gap-3 text-xs text-muted-foreground mb-2 flex-wrap">
                                    <span className="flex items-center gap-1">
                                      <Calendar className="h-3 w-3" />
                                      {format(
                                        new Date(meeting.startTime),
                                        "MMM d, yyyy",
                                      )}
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <Clock className="h-3 w-3" />
                                      {format(
                                        new Date(meeting.startTime),
                                        "h:mm a",
                                      )}{" "}
                                      -{" "}
                                      {format(
                                        new Date(meeting.endTime),
                                        "h:mm a",
                                      )}{" "}
                                      {tzAbbr}
                                    </span>
                                    {meeting.attendees &&
                                      meeting.attendees.length > 0 && (
                                        <Popover>
                                          <PopoverTrigger asChild>
                                            <button className="flex items-center gap-1 hover:text-primary cursor-pointer transition-colors">
                                              <Users className="h-3 w-3" />
                                              {meeting.attendees.length} attendee{meeting.attendees.length !== 1 ? "s" : ""}
                                            </button>
                                          </PopoverTrigger>
                                          <PopoverContent className="w-64 p-3" align="start">
                                            <p className="text-xs font-medium mb-2">Attendees ({meeting.attendees.length})</p>
                                            <div className="space-y-1 max-h-[150px] overflow-y-auto">
                                              {meeting.attendees.map((email: string, i: number) => (
                                                <div key={i} className="text-xs text-muted-foreground truncate">{email}</div>
                                              ))}
                                            </div>
                                          </PopoverContent>
                                        </Popover>
                                      )}
                                  </div>
                                  {meeting.meetingId?.startsWith("calendar:") &&
                                    !meeting.joinUrl && (
                                      <div className="text-xs text-amber-600 mb-2 flex items-center gap-1">
                                        <AlertCircle className="h-3 w-3" />
                                        Calendar event created (no Teams join
                                        link — requires Microsoft 365 license)
                                      </div>
                                    )}
                                  {meeting.transcript && (
                                    <div className="flex items-center gap-1 text-xs text-green-600 mb-2">
                                      <Check className="h-3 w-3" />
                                      Transcript available
                                    </div>
                                  )}
                                  {meeting.projectPlan && (
                                    <div className="flex items-center gap-1 text-xs text-purple-600 mb-2">
                                      <Sparkles className="h-3 w-3" />
                                      Plan generated
                                    </div>
                                  )}
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    {meeting.joinUrl && (
                                      <>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="text-xs h-7 bg-blue-50 text-blue-700 border-blue-200"
                                          onClick={() =>
                                            window.open(
                                              meeting.joinUrl!,
                                              "_blank",
                                            )
                                          }
                                        >
                                          {meeting.joinUrl.includes(
                                            "outlook.live.com",
                                          ) ||
                                          meeting.joinUrl.includes(
                                            "outlook.office",
                                          ) ? (
                                            <>
                                              <Calendar className="h-3 w-3 mr-1" />
                                              Calendar
                                            </>
                                          ) : (
                                            <>
                                              <Video className="h-3 w-3 mr-1" />
                                              Join
                                            </>
                                          )}
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="text-xs h-7"
                                          onClick={() =>
                                            copyToClipboard(meeting.joinUrl!)
                                          }
                                        >
                                          <Copy className="h-3 w-3 mr-1" />
                                          Copy Link
                                        </Button>
                                      </>
                                    )}
                                    {!meeting.transcript ? (
                                      <>
                                        {meeting.meetingId &&
                                          !meeting.meetingId.startsWith(
                                            "local:",
                                          ) && (
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              className="text-xs h-7"
                                              onClick={() =>
                                                fetchTranscriptMutation.mutate(
                                                  meeting.id,
                                                )
                                              }
                                              disabled={
                                                fetchingTeamsTranscriptId === meeting.id
                                              }
                                            >
                                              {fetchingTeamsTranscriptId === meeting.id ? (
                                                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                              ) : (
                                                <FileText className="h-3 w-3 mr-1" />
                                              )}
                                              Fetch Transcript
                                            </Button>
                                          )}
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="text-xs h-7"
                                          onClick={() => {
                                            setSelectedMeeting(meeting);
                                            setShowTranscriptDialog(true);
                                          }}
                                        >
                                          <ClipboardPaste className="h-3 w-3 mr-1" />
                                          Paste
                                        </Button>
                                      </>
                                    ) : (
                                      <>
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="text-xs h-7"
                                          onClick={() => {
                                            setSelectedMeeting(meeting);
                                            setShowTranscriptDialog(true);
                                          }}
                                        >
                                          <Eye className="h-3 w-3 mr-1" />
                                          View
                                        </Button>
                                        {!meeting.projectPlan ? (
                                          <Button
                                            size="sm"
                                            className="text-xs h-7 bg-gradient-to-r from-purple-600 to-blue-600"
                                            onClick={() =>
                                              generatePlanMutation.mutate(
                                                meeting.id,
                                              )
                                            }
                                            disabled={
                                              generatePlanMutation.isPending
                                            }
                                          >
                                            {generatePlanMutation.isPending ? (
                                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                            ) : (
                                              <Wand2 className="h-3 w-3 mr-1" />
                                            )}
                                            Plan
                                          </Button>
                                        ) : (
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            className="text-xs h-7"
                                            onClick={() => {
                                              setSelectedMeeting(meeting);
                                              setShowPlanDialog(true);
                                            }}
                                          >
                                            <Sparkles className="h-3 w-3 mr-1" />
                                            Plan
                                          </Button>
                                        )}
                                      </>
                                    )}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-xs h-7"
                                      onClick={() =>
                                        handleEditTeamsMeeting(meeting)
                                      }
                                    >
                                      <Edit3 className="h-3 w-3 mr-1" />
                                      Edit
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-xs h-7 text-destructive"
                                      onClick={() =>
                                        setDeleteMeetingItem(meeting)
                                      }
                                    >
                                      <Trash2 className="h-3 w-3 mr-1" />
                                      Delete
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                        )}
                      </div>
                    )}
                  </TabsContent>
                  <TabsContent value="discord" className="mt-4">
                    <DiscordBrowser />
                  </TabsContent>
                  {/* AI Meeting Intelligence — bulk-transcript MOM processor */}
                  <TabsContent value="intelligence">
                    <MeetingIntelligenceTab />
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>

          <div
            className={
              activeTab === "intelligence" ? "hidden" : "lg:col-span-3"
            }
          >
            <Card className="h-full">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base font-semibold flex items-center gap-2">
                    <FileText className="h-4 w-4 text-emerald-600" />
                    Imported Conversations
                  </CardTitle>
                  <Badge variant="outline" className="text-xs">
                    {conversations.length} total
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                  </div>
                ) : conversations.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <MessageSquare className="h-10 w-10 text-slate-300 mb-3" />
                    <h3 className="text-sm font-medium text-slate-600 mb-1">
                      No conversations yet
                    </h3>
                    <p className="text-xs text-slate-400 max-w-sm">
                      Import your first conversation by pasting a transcript,
                      uploading a file, or connecting an integration.
                    </p>
                  </div>
                ) : (
                  <ScrollArea className="h-[500px]">
                    <div className="space-y-3">
                      {conversations.map((conv) => (
                        <div
                          key={conv.id}
                          className="border rounded-lg p-4 hover:border-emerald-200 transition-colors"
                        >
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <SourceIcon source={conv.source} />
                              <h4 className="text-sm font-semibold text-slate-800">
                                {conv.title}
                              </h4>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge
                                variant="outline"
                                className={`text-xs ${sourceBadgeColor(conv.source)}`}
                              >
                                {sourceLabel(conv.source)}
                              </Badge>
                              {!conv.summary && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-xs h-7 text-emerald-600 border-emerald-200 hover:bg-emerald-50"
                                  onClick={() => summarizeMutation.mutate(conv.id)}
                                  disabled={summarizeMutation.isPending}
                                >
                                  {summarizeMutation.isPending ? (
                                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                  ) : (
                                    <Sparkles className="h-3 w-3 mr-1" />
                                  )}
                                  Summarize
                                </Button>
                              )}
                              {(conv.diarizedTranscript || conv.content) && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-xs h-7 text-violet-600 border-violet-200 hover:bg-violet-50"
                                  onClick={() => setRawTranscriptConv(conv)}
                                  data-testid={`button-view-raw-${conv.id}`}
                                >
                                  <FileText className="h-3 w-3 mr-1" />
                                  View raw transcript
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-xs h-7 text-red-500 border-red-200 hover:bg-red-50"
                                onClick={() => setConversationToDelete({ id: conv.id, title: conv.title })}
                                disabled={deleteMutation.isPending}
                              >
                                <Trash2 className="h-3 w-3 mr-1" />
                                Delete
                              </Button>
                            </div>
                          </div>

                          {conv.participantCount && conv.participantCount > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5 mb-2">
                              <Badge
                                variant="outline"
                                className="text-[10px] h-5 bg-violet-50 text-violet-700 border-violet-200"
                              >
                                <Users className="h-2.5 w-2.5 mr-1" />
                                {conv.participantCount} speaker
                                {conv.participantCount !== 1 ? "s" : ""} detected
                              </Badge>
                              {Array.isArray(conv.participants) &&
                                conv.participants.slice(0, 4).map((p) => (
                                  <Badge
                                    key={p}
                                    variant="outline"
                                    className="text-[10px] h-5 bg-slate-50 text-slate-600 border-slate-200"
                                  >
                                    {p}
                                  </Badge>
                                ))}
                            </div>
                          )}

                          {conv.diarizedTranscript &&
                            conv.diarizedTranscript.length > 0 && (
                              <TalkTimeBar
                                utterances={conv.diarizedTranscript}
                                speakerMap={conv.speakerMap}
                              />
                            )}

                          <p className="text-xs text-slate-500 line-clamp-2 mb-3">
                            {conv.content.substring(0, 200)}
                            {conv.content.length > 200 ? "..." : ""}
                          </p>

                          {conv.audioUrl && (
                            <audio
                              controls
                              preload="none"
                              src={`/api/conversations/${conv.id}/audio`}
                              className="w-full h-10 mb-3"
                              data-testid={`audio-conversation-${conv.id}`}
                            />
                          )}

                          {conv.summary && (
                            <div className="bg-emerald-50 border border-emerald-200 rounded-md p-3 mb-3">
                              <div className="flex items-center gap-1 mb-1">
                                <Sparkles className="h-3 w-3 text-emerald-600" />
                                <span className="text-xs font-semibold text-emerald-700">
                                  AI Summary
                                </span>
                              </div>
                              <div className="prose prose-sm prose-emerald max-w-none text-xs text-emerald-900 prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-headings:my-2 prose-headings:text-emerald-800 prose-strong:text-emerald-900 prose-strong:font-semibold prose-a:text-emerald-700">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                  {conv.summary}
                                </ReactMarkdown>
                              </div>
                            </div>
                          )}

                          {conv.summary && (
                            <ActionItemsBlock
                              conversationId={conv.id}
                              conversationTitle={conv.title}
                              items={
                                Array.isArray(conv.actionItems)
                                  ? (conv.actionItems as ConversationActionItem[])
                                  : []
                              }
                            />
                          )}

                          <div className="flex items-center gap-3 text-xs text-slate-400">
                            {conv.participants &&
                              conv.participants.length > 0 && (
                                <span className="flex items-center gap-1">
                                  <Users className="h-3 w-3" />
                                  {conv.participants.length} participant
                                  {conv.participants.length !== 1 ? "s" : ""}
                                </span>
                              )}
                            {conv.createdAt && (
                              <span className="flex items-center gap-1">
                                <Calendar className="h-3 w-3" />
                                {new Date(
                                  conv.createdAt,
                                ).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      <Dialog open={showCreateMeeting} onOpenChange={setShowCreateMeeting}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Video className="h-5 w-5 text-blue-600" />
              Create Teams Meeting
            </DialogTitle>
            <DialogDescription>
              Schedule a new Microsoft Teams meeting. A join link will be
              generated automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="mb-1.5">Meeting Subject</Label>
              <Input
                placeholder="e.g., Project Kickoff, Sprint Planning"
                value={meetingForm.subject}
                onChange={(e) =>
                  setMeetingForm({ ...meetingForm, subject: e.target.value })
                }
              />
            </div>
            <div>
              <Label className="mb-1.5">Date</Label>
              <Input
                type="date"
                value={meetingForm.date}
                onChange={(e) =>
                  setMeetingForm({ ...meetingForm, date: e.target.value })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="mb-1.5">Start Time</Label>
                <Input
                  type="time"
                  value={meetingForm.startTime}
                  onChange={(e) =>
                    setMeetingForm({
                      ...meetingForm,
                      startTime: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <Label className="mb-1.5">End Time</Label>
                <Input
                  type="time"
                  value={meetingForm.endTime}
                  onChange={(e) =>
                    setMeetingForm({ ...meetingForm, endTime: e.target.value })
                  }
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Timezone: {timezoneDisplay}
            </p>
            <div>
              <Label className="mb-1.5">Attendees (optional)</Label>
              <Textarea
                placeholder={
                  "Add attendee email addresses, one per line or separated by commas:\njohn@company.com\njane@company.com"
                }
                value={meetingForm.attendees}
                onChange={(e) =>
                  setMeetingForm({ ...meetingForm, attendees: e.target.value })
                }
                className="min-h-[60px]"
                data-testid="textarea-attendees"
              />
              <AttendeeSuggestions
                currentValue={meetingForm.attendees}
                onChange={(next) =>
                  setMeetingForm({ ...meetingForm, attendees: next })
                }
              />
              <p className="text-xs text-muted-foreground mt-1">
                Each attendee will receive a calendar invitation with the
                meeting link.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCreateMeeting(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateMeeting}
              disabled={createMeetingMutation.isPending}
            >
              {createMeetingMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Video className="h-4 w-4 mr-2" />
              )}
              Create Meeting
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showTranscriptDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowTranscriptDialog(false);
            setPasteTranscript("");
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>{selectedMeeting?.subject} - Transcript</DialogTitle>
            <DialogDescription>
              {selectedMeeting?.transcript
                ? "View the meeting transcript below."
                : "Paste the meeting transcript below."}
            </DialogDescription>
          </DialogHeader>
          {selectedMeeting?.transcript ? (
            <ScrollArea className="h-96 rounded-md border p-4">
              <pre className="text-sm whitespace-pre-wrap font-sans">
                {selectedMeeting.transcript}
              </pre>
            </ScrollArea>
          ) : (
            <div className="space-y-3">
              <Textarea
                placeholder="Paste your meeting transcript here..."
                value={pasteTranscript}
                onChange={(e) => setPasteTranscript(e.target.value)}
                className="min-h-[250px]"
              />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowTranscriptDialog(false);
                setPasteTranscript("");
              }}
            >
              Close
            </Button>
            {!selectedMeeting?.transcript && (
              <Button
                onClick={() => {
                  if (selectedMeeting && pasteTranscript.trim()) {
                    saveTranscriptMutation.mutate({
                      meetingId: selectedMeeting.id,
                      transcript: pasteTranscript,
                    });
                  }
                }}
                disabled={
                  saveTranscriptMutation.isPending || !pasteTranscript.trim()
                }
              >
                {saveTranscriptMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                Save Transcript
              </Button>
            )}
            {selectedMeeting?.transcript && !selectedMeeting?.projectPlan && (
              <Button
                onClick={() => {
                  if (selectedMeeting) {
                    setShowTranscriptDialog(false);
                    generatePlanMutation.mutate(selectedMeeting.id);
                  }
                }}
                disabled={generatePlanMutation.isPending}
                className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
              >
                {generatePlanMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Wand2 className="h-4 w-4 mr-2" />
                )}
                Generate Project Plan
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPlanDialog} onOpenChange={setShowPlanDialog}>
        <DialogContent className="sm:max-w-3xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-purple-600" />
              AI-Generated Project Plan
            </DialogTitle>
            <DialogDescription>
              Generated from the transcript of "{selectedMeeting?.subject}"
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="h-[60vh] pr-4">
            {renderPlanContent(selectedMeeting?.projectPlan)}
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPlanDialog(false)}>
              Close
            </Button>
            <Button
              onClick={() => {
                if (selectedMeeting?.projectPlan) {
                  const plan = selectedMeeting.projectPlan as any;
                  navigate(
                    `/create-project?name=${encodeURIComponent(plan.name || "")}&description=${encodeURIComponent(plan.description || "")}`,
                  );
                }
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Project from Plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteMeetingItem}
        onOpenChange={(open) => !open && setDeleteMeetingItem(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete meeting?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove "{deleteMeetingItem?.subject}" and
              its transcript and project plan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteMeetingItem) {
                  deleteMeetingMutation.mutate(deleteMeetingItem.id);
                  setDeleteMeetingItem(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!conversationToDelete}
        onOpenChange={(open) => !open && setConversationToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove "{conversationToDelete?.title}". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (conversationToDelete) {
                  deleteMutation.mutate(conversationToDelete.id);
                  setConversationToDelete(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={showCreateGoogleMeeting}
        onOpenChange={setShowCreateGoogleMeeting}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SiGooglemeet className="h-5 w-5 text-green-600" />
              Create Google Meet
            </DialogTitle>
            <DialogDescription>
              Schedule a meeting with an auto-generated Google Meet link. The
              event will be added to your Google Calendar.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="mb-1.5">Meeting Subject</Label>
              <Input
                placeholder="e.g., Product Review, Sprint Planning"
                value={googleMeetForm.subject}
                onChange={(e) =>
                  setGoogleMeetForm({
                    ...googleMeetForm,
                    subject: e.target.value,
                  })
                }
              />
            </div>
            <div>
              <Label className="mb-1.5">Date</Label>
              <Input
                type="date"
                value={googleMeetForm.date}
                onChange={(e) =>
                  setGoogleMeetForm({ ...googleMeetForm, date: e.target.value })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="mb-1.5">Start Time</Label>
                <Input
                  type="time"
                  value={googleMeetForm.startTime}
                  onChange={(e) =>
                    setGoogleMeetForm({
                      ...googleMeetForm,
                      startTime: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <Label className="mb-1.5">End Time</Label>
                <Input
                  type="time"
                  value={googleMeetForm.endTime}
                  onChange={(e) =>
                    setGoogleMeetForm({
                      ...googleMeetForm,
                      endTime: e.target.value,
                    })
                  }
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Timezone: {timezoneDisplay}
            </p>
            <div>
              <Label className="mb-1.5">Attendees (optional)</Label>
              <Textarea
                placeholder={
                  "Add attendee email addresses, one per line or separated by commas:\njohn@company.com\njane@company.com"
                }
                value={googleMeetForm.attendees}
                onChange={(e) =>
                  setGoogleMeetForm({
                    ...googleMeetForm,
                    attendees: e.target.value,
                  })
                }
                className="min-h-[60px]"
              />
              <AttendeeSuggestions
                currentValue={googleMeetForm.attendees}
                onChange={(next) =>
                  setGoogleMeetForm({ ...googleMeetForm, attendees: next })
                }
              />
              <p className="text-xs text-muted-foreground mt-1">
                Each attendee will receive a Google Calendar invitation with the
                Meet link.
              </p>
            </div>
            <div>
              <Label className="mb-1.5">Description (optional)</Label>
              <Textarea
                placeholder="Meeting agenda or notes..."
                value={googleMeetForm.description}
                onChange={(e) =>
                  setGoogleMeetForm({
                    ...googleMeetForm,
                    description: e.target.value,
                  })
                }
                className="min-h-[60px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCreateGoogleMeeting(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateGoogleMeeting}
              disabled={
                createGoogleMeetingMutation.isPending || !googleMeetForm.subject
              }
            >
              {createGoogleMeetingMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <SiGooglemeet className="h-4 w-4 mr-2" />
              )}
              Create Meeting
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showGoogleTranscriptDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowGoogleTranscriptDialog(false);
            setGooglePasteTranscript("");
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>
              {selectedGoogleMeeting?.subject} - Transcript
            </DialogTitle>
            <DialogDescription>
              {selectedGoogleMeeting?.transcript
                ? "View the meeting transcript below."
                : "Paste the meeting transcript below."}
            </DialogDescription>
          </DialogHeader>
          {selectedGoogleMeeting?.transcript ? (
            <ScrollArea className="h-96 rounded-md border p-4">
              <pre className="text-sm whitespace-pre-wrap font-sans">
                {selectedGoogleMeeting.transcript}
              </pre>
            </ScrollArea>
          ) : (
            <div className="space-y-3">
              <Textarea
                placeholder="Paste your meeting transcript here..."
                value={googlePasteTranscript}
                onChange={(e) => setGooglePasteTranscript(e.target.value)}
                className="min-h-[250px]"
              />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowGoogleTranscriptDialog(false);
                setGooglePasteTranscript("");
              }}
            >
              Close
            </Button>
            {!selectedGoogleMeeting?.transcript && (
              <Button
                onClick={() => {
                  if (selectedGoogleMeeting && googlePasteTranscript.trim()) {
                    saveGoogleTranscriptMutation.mutate({
                      meetingId: selectedGoogleMeeting.id,
                      transcript: googlePasteTranscript,
                    });
                  }
                }}
                disabled={
                  saveGoogleTranscriptMutation.isPending ||
                  !googlePasteTranscript.trim()
                }
              >
                {saveGoogleTranscriptMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                Save Transcript
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteGoogleMeetingItem}
        onOpenChange={(open) => !open && setDeleteGoogleMeetingItem(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Google Meet meeting?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove "{deleteGoogleMeetingItem?.subject}"
              and also delete the associated Google Calendar event.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteGoogleMeetingItem) {
                  deleteGoogleMeetingMutation.mutate(
                    deleteGoogleMeetingItem.id,
                  );
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={!!editGoogleMeeting}
        onOpenChange={(open) => !open && setEditGoogleMeeting(null)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit3 className="h-5 w-5" />
              Edit Meeting
            </DialogTitle>
            <DialogDescription>
              Update the meeting details. Changes will also update the Google
              Calendar event and notify attendees.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="mb-1.5">Meeting Subject</Label>
              <Input
                value={editGoogleMeetForm.subject}
                onChange={(e) =>
                  setEditGoogleMeetForm({
                    ...editGoogleMeetForm,
                    subject: e.target.value,
                  })
                }
              />
            </div>
            <div>
              <Label className="mb-1.5">Date</Label>
              <Input
                type="date"
                value={editGoogleMeetForm.date}
                onChange={(e) =>
                  setEditGoogleMeetForm({
                    ...editGoogleMeetForm,
                    date: e.target.value,
                  })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="mb-1.5">Start Time</Label>
                <Input
                  type="time"
                  value={editGoogleMeetForm.startTime}
                  onChange={(e) =>
                    setEditGoogleMeetForm({
                      ...editGoogleMeetForm,
                      startTime: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <Label className="mb-1.5">End Time</Label>
                <Input
                  type="time"
                  value={editGoogleMeetForm.endTime}
                  onChange={(e) =>
                    setEditGoogleMeetForm({
                      ...editGoogleMeetForm,
                      endTime: e.target.value,
                    })
                  }
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Timezone: {timezoneDisplay}
            </p>
            <div>
              <Label className="mb-1.5">Attendees</Label>
              <Textarea
                placeholder={
                  "Add attendee email addresses, one per line or separated by commas:\njohn@company.com\njane@company.com"
                }
                value={editGoogleMeetForm.attendees}
                onChange={(e) =>
                  setEditGoogleMeetForm({
                    ...editGoogleMeetForm,
                    attendees: e.target.value,
                  })
                }
                className="min-h-[60px]"
              />
              <AttendeeSuggestions
                currentValue={editGoogleMeetForm.attendees}
                onChange={(next) =>
                  setEditGoogleMeetForm({ ...editGoogleMeetForm, attendees: next })
                }
              />
              <p className="text-xs text-muted-foreground mt-1">
                Updated attendees will receive calendar notification.
              </p>
            </div>
            <div>
              <Label className="mb-1.5">Description (optional)</Label>
              <Textarea
                placeholder="Meeting agenda or notes..."
                value={editGoogleMeetForm.description}
                onChange={(e) =>
                  setEditGoogleMeetForm({
                    ...editGoogleMeetForm,
                    description: e.target.value,
                  })
                }
                className="min-h-[60px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditGoogleMeeting(null)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleUpdateGoogleMeeting}
              disabled={
                updateGoogleMeetingMutation.isPending ||
                !editGoogleMeetForm.subject
              }
            >
              {updateGoogleMeetingMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editTeamsMeeting}
        onOpenChange={(open) => !open && setEditTeamsMeeting(null)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit3 className="h-5 w-5" />
              Edit Teams Meeting
            </DialogTitle>
            <DialogDescription>
              Update the meeting details. Changes will also update the calendar
              event and notify attendees.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="mb-1.5">Meeting Subject</Label>
              <Input
                value={editTeamsForm.subject}
                onChange={(e) =>
                  setEditTeamsForm({
                    ...editTeamsForm,
                    subject: e.target.value,
                  })
                }
              />
            </div>
            <div>
              <Label className="mb-1.5">Date</Label>
              <Input
                type="date"
                value={editTeamsForm.date}
                onChange={(e) =>
                  setEditTeamsForm({ ...editTeamsForm, date: e.target.value })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="mb-1.5">Start Time</Label>
                <Input
                  type="time"
                  value={editTeamsForm.startTime}
                  onChange={(e) =>
                    setEditTeamsForm({
                      ...editTeamsForm,
                      startTime: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <Label className="mb-1.5">End Time</Label>
                <Input
                  type="time"
                  value={editTeamsForm.endTime}
                  onChange={(e) =>
                    setEditTeamsForm({
                      ...editTeamsForm,
                      endTime: e.target.value,
                    })
                  }
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Timezone: {timezoneDisplay}
            </p>
            <div>
              <Label className="mb-1.5">Attendees</Label>
              <Textarea
                placeholder={
                  "Add attendee email addresses, one per line or separated by commas:\njohn@company.com\njane@company.com"
                }
                value={editTeamsForm.attendees}
                onChange={(e) =>
                  setEditTeamsForm({
                    ...editTeamsForm,
                    attendees: e.target.value,
                  })
                }
                className="min-h-[60px]"
              />
              <AttendeeSuggestions
                currentValue={editTeamsForm.attendees}
                onChange={(next) =>
                  setEditTeamsForm({ ...editTeamsForm, attendees: next })
                }
              />
              <p className="text-xs text-muted-foreground mt-1">
                Updated attendees will receive calendar notification.
              </p>
            </div>
            <div>
              <Label className="mb-1.5">Description (optional)</Label>
              <Textarea
                placeholder="Meeting agenda or notes..."
                value={editTeamsForm.description}
                onChange={(e) =>
                  setEditTeamsForm({
                    ...editTeamsForm,
                    description: e.target.value,
                  })
                }
                className="min-h-[60px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTeamsMeeting(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleUpdateTeamsMeeting}
              disabled={
                updateTeamsMeetingMutation.isPending || !editTeamsForm.subject
              }
            >
              {updateTeamsMeetingMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateZoomMeeting} onOpenChange={setShowCreateZoomMeeting}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SiZoom className="h-5 w-5 text-blue-500" />
              Create Zoom Meeting
            </DialogTitle>
            <DialogDescription>
              Schedule a new Zoom meeting. Attendees will receive email invitations.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="mb-1.5">Meeting Subject</Label>
              <Input
                placeholder="e.g., Product Review, Sprint Planning"
                value={zoomMeetingForm.subject}
                onChange={(e) => setZoomMeetingForm({ ...zoomMeetingForm, subject: e.target.value })}
              />
            </div>
            <div>
              <Label className="mb-1.5">Date</Label>
              <Input
                type="date"
                value={zoomMeetingForm.date}
                onChange={(e) => setZoomMeetingForm({ ...zoomMeetingForm, date: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="mb-1.5">Start Time</Label>
                <Input
                  type="time"
                  value={zoomMeetingForm.startTime}
                  onChange={(e) => setZoomMeetingForm({ ...zoomMeetingForm, startTime: e.target.value })}
                />
              </div>
              <div>
                <Label className="mb-1.5">Duration (minutes)</Label>
                <Input
                  type="number"
                  min="15"
                  max="480"
                  value={zoomMeetingForm.duration}
                  onChange={(e) => setZoomMeetingForm({ ...zoomMeetingForm, duration: e.target.value })}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Timezone: {timezoneDisplay}
            </p>
            <div>
              <Label className="mb-1.5">Description (optional)</Label>
              <Textarea
                placeholder="Meeting agenda or notes..."
                value={zoomMeetingForm.description}
                onChange={(e) => setZoomMeetingForm({ ...zoomMeetingForm, description: e.target.value })}
                className="min-h-[60px]"
              />
            </div>
            <div>
              <Label className="mb-1.5">Attendees (optional)</Label>
              <Textarea
                placeholder={"Add attendee email addresses, one per line or separated by commas:\njohn@company.com\njane@company.com"}
                value={zoomMeetingForm.attendees}
                onChange={(e) => setZoomMeetingForm({ ...zoomMeetingForm, attendees: e.target.value })}
                className="min-h-[60px]"
              />
              <AttendeeSuggestions
                currentValue={zoomMeetingForm.attendees}
                onChange={(next) =>
                  setZoomMeetingForm({ ...zoomMeetingForm, attendees: next })
                }
              />
              <p className="text-xs text-muted-foreground mt-1">
                Each attendee will receive an email invitation with the Zoom meeting link.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateZoomMeeting(false)}>Cancel</Button>
            <Button onClick={handleCreateZoomMeeting} disabled={createZoomMeetingMutation.isPending}>
              {createZoomMeetingMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <SiZoom className="h-4 w-4 mr-2" />
              )}
              Create Meeting
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editZoomMeeting}
        onOpenChange={(open) => { if (!open) setEditZoomMeeting(null); }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SiZoom className="h-5 w-5 text-blue-500" />
              Edit Zoom Meeting
            </DialogTitle>
            <DialogDescription>Update the meeting details.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="mb-1.5">Meeting Subject</Label>
              <Input
                value={editZoomForm.subject}
                onChange={(e) => setEditZoomForm({ ...editZoomForm, subject: e.target.value })}
              />
            </div>
            <div>
              <Label className="mb-1.5">Date</Label>
              <Input
                type="date"
                value={editZoomForm.date}
                onChange={(e) => setEditZoomForm({ ...editZoomForm, date: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="mb-1.5">Start Time</Label>
                <Input
                  type="time"
                  value={editZoomForm.startTime}
                  onChange={(e) => setEditZoomForm({ ...editZoomForm, startTime: e.target.value })}
                />
              </div>
              <div>
                <Label className="mb-1.5">Duration (minutes)</Label>
                <Input
                  type="number"
                  min="15"
                  max="480"
                  value={editZoomForm.duration}
                  onChange={(e) => setEditZoomForm({ ...editZoomForm, duration: e.target.value })}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Timezone: {timezoneDisplay}
            </p>
            <div>
              <Label className="mb-1.5">Description</Label>
              <Textarea
                value={editZoomForm.description}
                onChange={(e) => setEditZoomForm({ ...editZoomForm, description: e.target.value })}
                className="min-h-[60px]"
              />
            </div>
            <div>
              <Label className="mb-1.5">Attendees</Label>
              <Textarea
                value={editZoomForm.attendees}
                onChange={(e) => setEditZoomForm({ ...editZoomForm, attendees: e.target.value })}
                className="min-h-[60px]"
              />
              <AttendeeSuggestions
                currentValue={editZoomForm.attendees}
                onChange={(next) =>
                  setEditZoomForm({ ...editZoomForm, attendees: next })
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditZoomMeeting(null)}>Cancel</Button>
            <Button onClick={handleEditZoomMeeting} disabled={updateZoomMeetingMutation.isPending}>
              {updateZoomMeetingMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteZoomMeetingItem}
        onOpenChange={(open) => { if (!open) setDeleteZoomMeetingItem(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Zoom meeting?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete "{deleteZoomMeetingItem?.subject}" from both Zoom and Requisor.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (deleteZoomMeetingItem) {
                  deleteZoomMeetingMutation.mutate(deleteZoomMeetingItem.id);
                }
              }}
              disabled={deleteZoomMeetingMutation.isPending}
            >
              {deleteZoomMeetingMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={showZoomTranscriptDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowZoomTranscriptDialog(false);
            setZoomPasteTranscript("");
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>{selectedZoomMeeting?.subject} - Transcript</DialogTitle>
            <DialogDescription>
              {selectedZoomMeeting?.transcript
                ? "View the meeting transcript below."
                : "Paste the meeting transcript below."}
            </DialogDescription>
          </DialogHeader>
          {selectedZoomMeeting?.transcript ? (
            <ScrollArea className="h-96 rounded-md border p-4">
              <pre className="text-sm whitespace-pre-wrap font-sans">
                {selectedZoomMeeting.transcript}
              </pre>
            </ScrollArea>
          ) : (
            <div className="space-y-3">
              <Textarea
                placeholder="Paste your Zoom meeting transcript here..."
                value={zoomPasteTranscript}
                onChange={(e) => setZoomPasteTranscript(e.target.value)}
                className="min-h-[250px]"
              />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowZoomTranscriptDialog(false);
                setZoomPasteTranscript("");
              }}
            >
              Close
            </Button>
            {!selectedZoomMeeting?.transcript && (
              <Button
                onClick={() => {
                  if (selectedZoomMeeting && zoomPasteTranscript.trim()) {
                    saveZoomTranscriptMutation.mutate({
                      meetingId: selectedZoomMeeting.id,
                      transcript: zoomPasteTranscript,
                    });
                  }
                }}
                disabled={saveZoomTranscriptMutation.isPending || !zoomPasteTranscript.trim()}
              >
                {saveZoomTranscriptMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                Save Transcript
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!rawTranscriptConv}
        onOpenChange={(open) => !open && setRawTranscriptConv(null)}
      >
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-violet-600" />
              Raw transcript — {rawTranscriptConv?.title}
            </DialogTitle>
            <DialogDescription>
              {Array.isArray(rawTranscriptConv?.diarizedTranscript) &&
              rawTranscriptConv!.diarizedTranscript!.length > 0
                ? `${rawTranscriptConv?.participantCount || rawTranscriptConv!.diarizedTranscript!.length} speaker(s) detected. Click copy to export.`
                : "Full text transcript. Click copy to export."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 -mt-1 mb-1">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-8 text-xs"
              onClick={() => {
                if (!rawTranscriptConv) return;
                const utts: DiarizedUtterance[] | null | undefined =
                  rawTranscriptConv.diarizedTranscript;
                const text = Array.isArray(utts) && utts.length > 0
                  ? utts.map((u) => `${u.speaker}: ${u.text}`).join("\n")
                  : rawTranscriptConv.content || "";
                navigator.clipboard.writeText(text).then(
                  () => toast({ title: "Copied", description: "Transcript copied to clipboard." }),
                  () => toast({ title: "Copy failed", variant: "destructive" }),
                );
              }}
              data-testid="button-copy-raw-transcript"
            >
              <Copy className="h-3.5 w-3.5" /> Copy
            </Button>
          </div>

          {rawTranscriptConv?.audioUrl && (
            <div className="mb-2 rounded-md border border-slate-200 bg-white p-2">
              <audio
                ref={transcriptAudioRef}
                controls
                preload="metadata"
                src={`/api/conversations/${rawTranscriptConv.id}/audio`}
                className="w-full h-9"
                data-testid="audio-raw-transcript"
                onTimeUpdate={(e) => {
                  const el = e.currentTarget;
                  setTranscriptAudioTime(el.currentTime * 1000);
                  if (
                    transcriptPlayingRange &&
                    el.currentTime * 1000 >= transcriptPlayingRange.end
                  ) {
                    el.pause();
                    setTranscriptPlayingRange(null);
                  }
                }}
                onPause={() => setTranscriptPlayingRange(null)}
              />
              <p className="mt-1 text-[10px] text-slate-500">
                Click any line below to jump to that moment in the recording.
              </p>
            </div>
          )}

          <ScrollArea className="flex-1 min-h-0 border rounded-md p-3 bg-slate-50">
            {(() => {
              const utts: DiarizedUtterance[] | null | undefined =
                rawTranscriptConv?.diarizedTranscript;
              if (Array.isArray(utts) && utts.length > 0) {
                const fmt = (ms: number) => {
                  const s = Math.floor(ms / 1000);
                  const m = Math.floor(s / 60);
                  const ss = (s % 60).toString().padStart(2, "0");
                  return `${m}:${ss}`;
                };
                const colors = [
                  "bg-emerald-100 text-emerald-700 border-emerald-200",
                  "bg-violet-100 text-violet-700 border-violet-200",
                  "bg-amber-100 text-amber-700 border-amber-200",
                  "bg-sky-100 text-sky-700 border-sky-200",
                  "bg-rose-100 text-rose-700 border-rose-200",
                  "bg-indigo-100 text-indigo-700 border-indigo-200",
                ];
                const speakerColor = new Map<string, string>();
                utts.forEach((u) => {
                  if (!speakerColor.has(u.speaker)) {
                    speakerColor.set(
                      u.speaker,
                      colors[speakerColor.size % colors.length],
                    );
                  }
                });
                const speakerMap: SpeakerMap | null | undefined =
                  rawTranscriptConv?.speakerMap;
                const uniqueLabels = Array.from(speakerColor.keys());
                return (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-1.5 pb-2 border-b border-slate-200">
                      <span className="text-[10px] text-slate-500 uppercase tracking-wide mr-1">
                        Speakers:
                      </span>
                      {uniqueLabels.map((label) => {
                        const mapped = speakerMap?.[label];
                        const displayName = mapped?.name || label;
                        const isEditing = confirmSpeakerLabel === label;
                        if (isEditing) {
                          return (
                            <div
                              key={label}
                              className="flex items-center gap-1 bg-white border border-violet-300 rounded-md px-1 py-0.5"
                            >
                              <Input
                                autoFocus
                                value={confirmSpeakerName}
                                onChange={(e) => setConfirmSpeakerName(e.target.value)}
                                placeholder={`Name for ${label}`}
                                className="h-6 text-xs w-36"
                                data-testid={`input-confirm-speaker-${label}`}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && confirmSpeakerName.trim() && rawTranscriptConv) {
                                    confirmSpeakerMutation.mutate({
                                      conversationId: rawTranscriptConv.id,
                                      speakerLabel: label,
                                      name: confirmSpeakerName.trim(),
                                    });
                                  } else if (e.key === "Escape") {
                                    setConfirmSpeakerLabel(null);
                                    setConfirmSpeakerName("");
                                  }
                                }}
                              />
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-xs text-emerald-700"
                                disabled={!confirmSpeakerName.trim() || confirmSpeakerMutation.isPending}
                                onClick={() => {
                                  if (!rawTranscriptConv || !confirmSpeakerName.trim()) return;
                                  confirmSpeakerMutation.mutate({
                                    conversationId: rawTranscriptConv.id,
                                    speakerLabel: label,
                                    name: confirmSpeakerName.trim(),
                                  });
                                }}
                                data-testid={`button-save-speaker-${label}`}
                              >
                                Save
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-1 text-xs text-slate-500"
                                onClick={() => {
                                  setConfirmSpeakerLabel(null);
                                  setConfirmSpeakerName("");
                                }}
                              >
                                ×
                              </Button>
                            </div>
                          );
                        }
                        return (
                          <button
                            key={label}
                            type="button"
                            className="group flex items-center gap-1"
                            onClick={() => {
                              setConfirmSpeakerLabel(label);
                              setConfirmSpeakerName(mapped?.name || "");
                            }}
                            title={
                              mapped
                                ? `Click to correct (currently ${Math.round((mapped.confidence || 0) * 100)}% confidence)`
                                : `Click to identify ${label}`
                            }
                            data-testid={`button-confirm-speaker-${label}`}
                          >
                            <Badge
                              variant="outline"
                              className={`h-5 text-[10px] ${speakerColor.get(label)} group-hover:ring-1 group-hover:ring-violet-400`}
                            >
                              {displayName}
                            </Badge>
                            <span className="text-[10px] text-violet-600 opacity-60 group-hover:opacity-100">
                              {mapped ? "edit" : "name"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {utts.map((u, i) => {
                      const labelKey = u.speaker;
                      const mapped = speakerMap?.[labelKey];
                      const displayName = mapped?.name || labelKey;
                      const tooltip = mapped
                        ? `Mapped from ${labelKey} (confidence ${Math.round((mapped.confidence || 0) * 100)}%)`
                        : undefined;
                      const start = u.start || 0;
                      const end = u.end || start;
                      const hasAudio = !!rawTranscriptConv?.audioUrl;
                      const isActive =
                        hasAudio &&
                        transcriptAudioTime >= start &&
                        transcriptAudioTime < (end || start + 1);
                      return (
                        <div
                          key={i}
                          className={`group flex gap-2 text-xs rounded px-1 py-0.5 -mx-1 transition-colors ${
                            isActive
                              ? "bg-violet-100 ring-1 ring-violet-300"
                              : hasAudio
                                ? "hover:bg-white cursor-pointer"
                                : ""
                          }`}
                          onClick={
                            hasAudio
                              ? () => seekAndPlay(start, end)
                              : undefined
                          }
                          title={
                            hasAudio
                              ? `Play from ${fmt(start)}`
                              : tooltip
                          }
                          data-testid={`utterance-row-${i}`}
                        >
                          <span className="text-slate-400 mt-0.5 w-12 flex-shrink-0 tabular-nums flex items-center gap-1">
                            {hasAudio && (
                              <Play
                                className={`h-3 w-3 flex-shrink-0 ${
                                  isActive
                                    ? "text-violet-600"
                                    : "text-slate-300 group-hover:text-violet-500"
                                }`}
                              />
                            )}
                            {fmt(start)}
                          </span>
                          <Badge
                            variant="outline"
                            className={`flex-shrink-0 h-5 text-[10px] ${speakerColor.get(labelKey)}`}
                            title={tooltip}
                          >
                            {displayName}
                          </Badge>
                          <span className="text-slate-800 leading-relaxed flex-1">
                            {u.text}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              }
              return (
                <pre className="text-xs text-slate-800 whitespace-pre-wrap font-sans leading-relaxed">
                  {rawTranscriptConv?.content || ""}
                </pre>
              );
            })()}
          </ScrollArea>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRawTranscriptConv(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface AttendeeSuggestion {
  email: string;
  count: number;
}

function AttendeeSuggestions({
  currentValue,
  onChange,
  onAdd,
}: {
  currentValue: string;
  onChange?: (newValue: string) => void;
  onAdd?: (email: string) => void;
}) {
  const commitEmail = (email: string) => {
    if (onChange) {
      const linesRaw = currentValue.split(/(\r?\n|,)/);
      const segments: string[] = [];
      let buffer = "";
      for (const part of linesRaw) {
        if (part === "," || /^\r?\n$/.test(part)) {
          segments.push(buffer);
          segments.push(part);
          buffer = "";
        } else {
          buffer += part;
        }
      }
      segments.push(buffer);
      let lastIdx = -1;
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i] !== "," && !/^\r?\n$/.test(segments[i])) {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx >= 0) segments[lastIdx] = email;
      else segments.push(email);
      let next = segments.join("");
      if (!/[,\n]\s*$/.test(next)) next += ", ";
      onChange(next);
    } else if (onAdd) {
      onAdd(email);
    }
  };
  const { data, isLoading } = useQuery<{ suggestions: AttendeeSuggestion[] }>({
    queryKey: ["/api/meetings/attendee-suggestions"],
  });

  const suggestions = data?.suggestions || [];

  const lines = currentValue.split(/[\n,]+/).map((s) => s.trim().toLowerCase());
  const lastFragment = lines[lines.length - 1] || "";
  const alreadyAdded = new Set(lines.filter(Boolean));

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const isTypingValidEmail =
    lastFragment.length > 0 &&
    EMAIL_RE.test(lastFragment) &&
    !alreadyAdded.has(lastFragment);
  const isTypingPartial =
    lastFragment.length > 0 && !EMAIL_RE.test(lastFragment);

  const ranked = suggestions
    .map((s) => {
      const isAdded = alreadyAdded.has(s.email);
      const isMatch = lastFragment.length > 0 && s.email.includes(lastFragment);
      return { ...s, isAdded, isMatch };
    })
    .sort((a, b) => {
      if (a.isMatch !== b.isMatch) return a.isMatch ? -1 : 1;
      if (a.isAdded !== b.isAdded) return a.isAdded ? 1 : -1;
      return b.count - a.count;
    })
    .slice(0, 12);

  const hasMatch = ranked.some((s) => s.isMatch && !s.isAdded);
  const isTyping = lastFragment.length > 0;
  const showPanel = !isLoading && isTyping;

  if (!showPanel) return null;

  const matchingSuggestions = ranked.filter((s) => s.isMatch);

  return (
    <div className="mt-2 space-y-2">
      {(isTypingValidEmail || (isTypingPartial && !hasMatch)) && (
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            Currently typing
          </span>
          <button
            type="button"
            onClick={() => isTypingValidEmail && commitEmail(lastFragment)}
            disabled={!isTypingValidEmail}
            className={`text-[11px] px-2 py-1 rounded-md border transition-all ${
              isTypingValidEmail
                ? "bg-emerald-50 border-emerald-400 text-emerald-800 font-semibold ring-1 ring-emerald-300 hover:bg-emerald-100 cursor-pointer"
                : "bg-amber-50 border-amber-300 text-amber-800 cursor-default"
            }`}
            title={
              isTypingValidEmail
                ? "Click to add this email"
                : "Keep typing — not a complete email yet"
            }
            data-testid="typing-email-chip"
          >
            {isTypingValidEmail ? "✓ " : ""}
            {lastFragment}
            {!isTypingValidEmail && (
              <span className="ml-1 text-[10px] opacity-70">incomplete</span>
            )}
          </button>
        </div>
      )}

      {matchingSuggestions.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
              Matching attendees
            </span>
            <span className="text-[10px] text-muted-foreground">
              (click to add)
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {matchingSuggestions.map((s) => (
              <button
                key={s.email}
                type="button"
                onClick={() => !s.isAdded && commitEmail(s.email)}
                disabled={s.isAdded}
                data-testid={`suggestion-${s.email}`}
                className={`text-[11px] px-2 py-1 rounded-md border transition-all ${
                  s.isAdded
                    ? "bg-emerald-50 border-emerald-300 text-emerald-700 cursor-default"
                    : s.isMatch
                      ? "bg-amber-100 border-amber-500 text-amber-900 font-semibold ring-2 ring-amber-300 hover:bg-amber-200 scale-105"
                      : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100 hover:border-slate-300"
                }`}
                title={`Used ${s.count}x`}
              >
                {s.isAdded && "✓ "}
                {s.email}
                {s.count > 1 && (
                  <span className="ml-1 text-[10px] opacity-60">×{s.count}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
