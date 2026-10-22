import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  MessagesSquare,
  MessageSquare,
  Hash,
  Mail,
  Plus,
  Trash2,
  Loader2,
  ExternalLink,
  Upload,
  Send,
  Sparkles,
  Folder,
  FolderPlus,
  CheckCircle,
  ArrowRight,
  Search,
  ListChecks,
  Brain,
  Library,
  Copy,
  Download,
  Paperclip,
  Pencil,
  X,
  Tag as TagIcon,
  Check,
} from "lucide-react";
import type {
  Conversation,
  Project,
  ConversationActionItem,
} from "@shared/schema";

type ConversationKind = "plain" | "slack" | "discord" | "email";

interface SlackChannel {
  id: string;
  name: string;
  isPrivate?: boolean;
  numMembers?: number;
}

interface DiscordChannel {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
}

interface ConnectionStatuses {
  slack: { connected: boolean; workspaceName?: string };
  discord: { connected: boolean; botName?: string };
}

const KIND_META: Record<
  ConversationKind,
  { label: string; icon: any; sourceTag: string; description: string }
> = {
  plain: {
    label: "Manual paste",
    icon: MessageSquare,
    sourceTag: "manual",
    description:
      "Paste any conversation text — meeting notes, a group chat, anything.",
  },
  slack: {
    label: "Slack",
    icon: Hash,
    sourceTag: "slack",
    description:
      "Paste a Slack channel JSON export, or import directly from a connected workspace.",
  },
  discord: {
    label: "Discord",
    icon: MessagesSquare,
    sourceTag: "discord",
    description:
      "Paste a DiscordChatExporter JSON export, or connect a Discord bot to pull channels live.",
  },
  email: {
    label: "Email",
    icon: Mail,
    sourceTag: "email",
    description: "Paste a forwarded email, or upload an .eml / .mbox file.",
  },
};

function sourceBadge(source: string) {
  const s = (source || "").toLowerCase();
  if (s === "slack") return "bg-purple-50 text-purple-700 border-purple-200";
  if (s === "discord") return "bg-indigo-50 text-indigo-700 border-indigo-200";
  if (s === "email" || s === "gmail")
    return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-slate-50 text-slate-700 border-slate-200";
}

function SourceIcon({ source }: { source: string }) {
  const s = (source || "").toLowerCase();
  const cls = "h-4 w-4";
  if (s === "slack") return <Hash className={cls} />;
  if (s === "discord") return <MessagesSquare className={cls} />;
  if (s === "email" || s === "gmail") return <Mail className={cls} />;
  return <MessageSquare className={cls} />;
}

// Gmail-imported messages have source="gmail"; include them in the visible
// list and source-filter dropdown alongside manually pasted email.
const CONVERSATION_SOURCES = ["manual", "slack", "discord", "email", "gmail"];

function detectKindFromFile(file: File): ConversationKind {
  const name = file.name.toLowerCase();
  if (name.endsWith(".eml") || name.endsWith(".mbox")) return "email";
  if (name.endsWith(".json")) return "slack"; // tentative — refined by sniffJsonKind
  return "plain";
}

// Sniff a JSON blob to tell DiscordChatExporter exports apart from Slack
// channel exports. DiscordChatExporter writes a top-level object with a
// `channel` *and* `guild` field plus a `messages` array whose items have
// `author.discriminator`/`author.username`. Slack channel JSON is either
// an array of message objects or `{messages:[...]}` whose items have
// `user_profile`/`ts` fields.
function sniffJsonKind(text: string): ConversationKind | null {
  try {
    const parsed = JSON.parse(text);
    const sample = Array.isArray(parsed)
      ? parsed[0]
      : parsed?.messages && Array.isArray(parsed.messages)
        ? parsed.messages[0]
        : null;
    if (parsed && !Array.isArray(parsed)) {
      if (
        parsed.guild ||
        (parsed.channel && parsed.messages && sample?.author?.username)
      ) {
        return "discord";
      }
    }
    if (sample) {
      if (sample.user_profile || typeof sample.ts !== "undefined")
        return "slack";
      if (
        sample.author &&
        (sample.author.username || sample.author.discriminator)
      ) {
        return "discord";
      }
    }
  } catch {
    // not valid json — let the server-side normalizer fall through to plain
  }
  return null;
}

export default function ConversationsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<ConversationKind>("plain");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteKind, setPasteKind] = useState<ConversationKind>("plain");
  const [previewConv, setPreviewConv] = useState<Conversation | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [discordToken, setDiscordToken] = useState("");
  const [showDiscordConnect, setShowDiscordConnect] = useState(false);
  const [listSearch, setListSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<
    "all" | "manual" | "slack" | "discord" | "email" | "gmail"
  >("all");

  // Gmail picker dialog state.
  const [gmailPickerOpen, setGmailPickerOpen] = useState(false);
  const [gmailQuery, setGmailQuery] = useState(
    "in:inbox -category:promotions -category:social",
  );
  const [gmailSelectedLabel, setGmailSelectedLabel] = useState<string>("");
  const [gmailSelectedIds, setGmailSelectedIds] = useState<string[]>([]);
  const [gmailProjectId, setGmailProjectId] = useState<string>("");

  // Form state
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // ---- Queries ----
  const { data: conversations = [], isLoading } = useQuery<Conversation[]>({
    queryKey: ["/api/conversations"],
  });

  const { data: allProjects = [] } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const { data: statuses } = useQuery<ConnectionStatuses>({
    queryKey: ["/api/conversations/integrations/status"],
  });
  const slackStatus = statuses?.slack;
  const discordStatus = statuses?.discord;

  // Gmail status lives at a separate endpoint (it isn't a chat platform like
  // Slack/Discord — it's a Google integration). Connect / Disconnect / Import
  // are wired below in the Email tab.
  const { data: gmailStatus } = useQuery<{
    connected: boolean;
    email?: string;
    lastSynced?: string;
  }>({ queryKey: ["/api/integrations/gmail/status"] });

  const connectGmail = async () => {
    try {
      const res = await apiRequest("/api/integrations/gmail/auth-url");
      if (res?.authUrl) window.location.href = res.authUrl;
    } catch (e: any) {
      toast({
        title: "Gmail connect failed",
        description: e?.message || "Could not start Google OAuth",
        variant: "destructive",
      });
    }
  };

  const disconnectGmail = useMutation({
    mutationFn: () =>
      apiRequest("/api/integrations/gmail/disconnect", { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Gmail disconnected" });
      queryClient.invalidateQueries({
        queryKey: ["/api/integrations/gmail/status"],
      });
    },
  });

  // Gmail picker data — only fetched while the dialog is open.
  const { data: gmailLabelsData } = useQuery<{
    labels: { id: string; name: string; type?: string }[];
  }>({
    queryKey: ["/api/integrations/gmail/labels"],
    enabled: gmailPickerOpen && !!gmailStatus?.connected,
  });
  const gmailMessagesUrl = useMemo(() => {
    const sp = new URLSearchParams({ max: "50" });
    if (gmailQuery) sp.set("q", gmailQuery);
    if (gmailSelectedLabel) sp.set("labelIds", gmailSelectedLabel);
    return `/api/integrations/gmail/messages?${sp.toString()}`;
  }, [gmailQuery, gmailSelectedLabel]);
  const { data: gmailMessagesData, isFetching: gmailMessagesFetching } =
    useQuery<{
      messages: {
        id: string;
        threadId: string | null;
        from: string;
        subject: string;
        snippet: string;
        date: string | null;
        hasAttachments: boolean;
      }[];
    }>({
      queryKey: [gmailMessagesUrl],
      enabled: gmailPickerOpen && !!gmailStatus?.connected,
    });

  const importGmail = useMutation({
    mutationFn: (payload: {
      max?: number;
      query?: string;
      messageIds?: string[];
      projectId?: number;
    }) =>
      apiRequest("/api/integrations/gmail/import", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (data: any) => {
      toast({
        title: "Gmail imported",
        description: `Imported ${data?.imported ?? 0} new email${(data?.imported ?? 0) === 1 ? "" : "s"}${data?.skipped ? ` (skipped ${data.skipped} already-imported)` : ""}.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({
        queryKey: ["/api/integrations/gmail/status"],
      });
    },
    onError: (e: any) => {
      toast({
        title: "Gmail import failed",
        description: e?.message || "Could not import from Gmail",
        variant: "destructive",
      });
    },
  });

  const { data: slackChannels = [], isLoading: slackChannelsLoading } =
    useQuery<SlackChannel[]>({
      queryKey: ["/api/conversations/slack/channels"],
      enabled: !!slackStatus?.connected,
      retry: false,
    });

  const { data: discordChannels = [], isLoading: discordChannelsLoading } =
    useQuery<DiscordChannel[]>({
      queryKey: ["/api/conversations/discord/channels"],
      enabled: !!discordStatus?.connected,
      retry: false,
    });

  // Re-fetch latest version of the previewed conversation so summarize +
  // action items mutations refresh inline without closing the dialog. The
  // default queryFn only fetches `queryKey[0]`, so we provide an explicit
  // queryFn that hits the per-id endpoint.
  const { data: liveConv } = useQuery<Conversation>({
    queryKey: ["/api/conversations", previewConv?.id],
    queryFn: () => apiRequest(`/api/conversations/${previewConv!.id}`),
    enabled: !!previewConv,
  });
  const previewLive: Conversation | null = liveConv || previewConv;

  const filteredConversations = useMemo(() => {
    const q = listSearch.trim().toLowerCase();
    return conversations
      .filter((c) =>
        CONVERSATION_SOURCES.includes((c.source || "manual").toLowerCase()),
      )
      .filter((c) =>
        sourceFilter === "all"
          ? true
          : (c.source || "manual").toLowerCase() === sourceFilter,
      )
      .filter((c) => {
        if (!q) return true;
        const hay = [
          c.title,
          c.source,
          c.channelName || "",
          (c.participants || []).join(" "),
          (c.summary || "").slice(0, 500),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bt - at;
      });
  }, [conversations, listSearch, sourceFilter]);

  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: 0,
      manual: 0,
      slack: 0,
      discord: 0,
      email: 0,
    };
    for (const c of conversations) {
      const s = (c.source || "manual").toLowerCase();
      if (!CONVERSATION_SOURCES.includes(s)) continue;
      counts.all += 1;
      counts[s] = (counts[s] || 0) + 1;
    }
    return counts;
  }, [conversations]);

  // ---- Mutations ----
  const deleteConv = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest(`/api/conversations/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      toast({ title: "Deleted" });
    },
    onError: (err: any) =>
      toast({
        title: "Delete failed",
        description: err?.message || "Could not delete",
        variant: "destructive",
      }),
  });

  const importSlackChannel = useMutation({
    mutationFn: async (channel: SlackChannel) =>
      apiRequest("/api/conversations/slack/import-channel", {
        method: "POST",
        body: JSON.stringify({
          channelId: channel.id,
          channelName: channel.name,
          limit: 200,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      toast({ title: "Slack channel imported" });
    },
    onError: (err: any) =>
      toast({
        title: "Slack import failed",
        description: err?.message || "Could not fetch channel history",
        variant: "destructive",
      }),
  });

  const importDiscordChannel = useMutation({
    mutationFn: async (channel: DiscordChannel) =>
      apiRequest("/api/conversations/discord/import-channel", {
        method: "POST",
        body: JSON.stringify({
          channelId: channel.id,
          channelName: channel.name,
          guildName: channel.guildName,
          limit: 200,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      toast({ title: "Discord channel imported" });
    },
    onError: (err: any) =>
      toast({
        title: "Discord import failed",
        description: err?.message || "Could not fetch channel history",
        variant: "destructive",
      }),
  });

  const connectDiscord = useMutation({
    mutationFn: async (botToken: string) =>
      apiRequest("/api/conversations/discord/connect", {
        method: "POST",
        body: JSON.stringify({ botToken }),
      }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/conversations/integrations/status"],
      });
      setShowDiscordConnect(false);
      setDiscordToken("");
      toast({
        title: "Discord connected",
        description: data?.botName
          ? `Bot ${data.botName} ready to import channels.`
          : "Bot ready to import channels.",
      });
    },
    onError: (err: any) =>
      toast({
        title: "Connect failed",
        description: err?.message || "Discord rejected the token",
        variant: "destructive",
      }),
  });

  const disconnectDiscord = useMutation({
    mutationFn: async () =>
      apiRequest("/api/conversations/discord/disconnect", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/conversations/integrations/status"],
      });
      toast({ title: "Discord disconnected" });
    },
  });

  const summarize = useMutation({
    mutationFn: async (id: number) =>
      apiRequest(`/api/conversations/${id}/summarize`, { method: "PATCH" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      if (previewConv) {
        queryClient.invalidateQueries({
          queryKey: ["/api/conversations", previewConv.id],
        });
      }
      toast({
        title: "Summary ready",
        description: "AI summary and action items extracted.",
      });
    },
    onError: (err: any) =>
      toast({
        title: "Summarize failed",
        description: err?.message || "Could not summarize",
        variant: "destructive",
      }),
  });

  const updateConv = useMutation({
    mutationFn: async (vars: {
      id: number;
      updates: { title?: string; tags?: string[]; projectId?: number | null };
    }) =>
      apiRequest(`/api/conversations/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify(vars.updates),
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({
        queryKey: ["/api/conversations", vars.id],
      });
    },
    onError: (err: any) =>
      toast({
        title: "Update failed",
        description: err?.message || "Could not save changes",
        variant: "destructive",
      }),
  });

  const handleCopyTranscript = async (conv: Conversation) => {
    try {
      await navigator.clipboard.writeText(conv.content || "");
      toast({
        title: "Copied transcript",
        description: "Raw text copied to clipboard.",
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Your browser blocked clipboard access.",
        variant: "destructive",
      });
    }
  };

  const handleDownloadTranscript = (conv: Conversation) => {
    const a = document.createElement("a");
    a.href = `/api/conversations/${conv.id}/raw`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleSaveTitle = () => {
    if (!previewLive) return;
    const next = titleDraft.trim();
    if (!next || next === previewLive.title) {
      setEditingTitle(false);
      return;
    }
    updateConv.mutate(
      { id: previewLive.id, updates: { title: next } },
      {
        onSuccess: () => {
          setEditingTitle(false);
          toast({ title: "Renamed" });
        },
      },
    );
  };

  const handleAddTag = () => {
    if (!previewLive) return;
    const tag = tagDraft.trim().replace(/^#/, "");
    if (!tag) return;
    const existing = previewLive.tags || [];
    if (existing.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      setTagDraft("");
      return;
    }
    updateConv.mutate(
      { id: previewLive.id, updates: { tags: [...existing, tag] } },
      { onSuccess: () => setTagDraft("") },
    );
  };

  const handleRemoveTag = (tag: string) => {
    if (!previewLive) return;
    const next = (previewLive.tags || []).filter((t) => t !== tag);
    updateConv.mutate({ id: previewLive.id, updates: { tags: next } });
  };

  const handleAssignProject = (projectId: number | null) => {
    if (!previewLive) return;
    updateConv.mutate(
      { id: previewLive.id, updates: { projectId } },
      {
        onSuccess: () =>
          toast({
            title:
              projectId === null ? "Removed from project" : "Project assigned",
          }),
      },
    );
  };

  const sendToBrain = useMutation({
    mutationFn: async (conv: Conversation) => {
      // Preserve the conversation's actual origin so downstream Evidence
      // and Past Discoveries keep `source = slack|discord|email|manual`.
      const rawSource = (conv.source || "manual").toLowerCase();
      const allowed = new Set([
        "slack",
        "discord",
        "email",
        "manual",
        "meeting",
        "chatgpt",
        "claude",
        "other",
      ]);
      const source = allowed.has(rawSource) ? rawSource : "manual";
      return apiRequest("/api/context/parse", {
        method: "POST",
        body: JSON.stringify({
          text: conv.summary || conv.content,
          source,
        }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/evidence"] });
      toast({
        title: "Sent to Context Brain",
        description: "Insights extracted.",
      });
    },
    onError: (err: any) =>
      toast({
        title: "Could not send",
        description: err?.message || "Try again",
        variant: "destructive",
      }),
  });

  // ---- Handlers ----
  const openPaste = (kind: ConversationKind) => {
    setPasteKind(kind);
    setTitle("");
    setContent("");
    setPasteOpen(true);
  };

  const handleSubmit = async () => {
    if (!content.trim()) {
      toast({
        title: "Content required",
        description: "Paste some conversation content first.",
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest("/api/conversations/import-paste", {
        method: "POST",
        body: JSON.stringify({
          kind: pasteKind,
          title: title.trim() || undefined,
          content,
        }),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      toast({ title: "Conversation saved" });
      setPasteOpen(false);
      setTitle("");
      setContent("");
    } catch (err: any) {
      toast({
        title: "Save failed",
        description: err?.message || "Could not save conversation",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  // Generic file upload — accepts .txt, .md, .json, .eml, .mbox.
  // Detects kind by extension and passes raw content to the import-paste
  // route; the server-side normalizer handles JSON-vs-plaintext fallback.
  const handleFileUpload = async (
    file: File,
    explicitKind?: ConversationKind,
  ) => {
    setSubmitting(true);
    try {
      const text = await file.text();
      let kind = explicitKind || detectKindFromFile(file);
      // Refine .json detection by sniffing the actual content so a
      // DiscordChatExporter export uploaded via the unified button is
      // tagged correctly instead of being routed to the Slack normalizer.
      if (!explicitKind && file.name.toLowerCase().endsWith(".json")) {
        const sniffed = sniffJsonKind(text);
        if (sniffed) kind = sniffed;
      }
      await apiRequest("/api/conversations/import-paste", {
        method: "POST",
        body: JSON.stringify({
          kind,
          title: file.name,
          content: text,
        }),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      toast({ title: `Imported ${file.name}` });
    } catch (err: any) {
      toast({
        title: "Import failed",
        description: err?.message || "Could not parse file",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Bulk upload state + handler ----
  // Capable of ingesting hundreds-to-thousands of transcripts. We:
  //   1. Read each file's text in parallel (limited concurrency).
  //   2. Group items into batches of 25 and POST to /bulk-import.
  //   3. Show per-batch progress so the user can see it's not frozen.
  // Auto-summarization is intentionally skipped on the server in bulk mode
  // to avoid melting OpenAI rate limits and the user's token budget.
  const [bulkProgress, setBulkProgress] = useState<{
    total: number;
    done: number;
    inserted: number;
    failed: number;
  } | null>(null);

  const handleBulkUpload = async (files: File[]) => {
    if (files.length === 0) return;
    if (files.length === 1) {
      // Single-file fast path keeps the existing UX (toast w/ filename).
      await handleFileUpload(files[0]);
      return;
    }

    // Pre-flight: skip files that are clearly not transcripts.
    const MAX_BYTES = 5 * 1024 * 1024; // 5MB per file
    const valid: File[] = [];
    let skipped = 0;
    for (const f of files) {
      if (f.size === 0 || f.size > MAX_BYTES) {
        skipped++;
        continue;
      }
      valid.push(f);
    }
    if (valid.length === 0) {
      toast({
        title: "Nothing to import",
        description: "All selected files were empty or larger than 5MB.",
        variant: "destructive",
      });
      return;
    }

    setBulkProgress({ total: valid.length, done: 0, inserted: 0, failed: 0 });

    // Streaming pipeline: read a small window of files, accumulate into a
    // batch up to a byte budget (well under the server's 50MB JSON body
    // limit), POST it, drop the references, then repeat. This means we
    // never hold all 2000 file contents in memory at once.
    type Item = { kind: ConversationKind; title: string; content: string };
    const MAX_BATCH_ITEMS = 50; // server cap
    const MAX_BATCH_BYTES = 30 * 1024 * 1024; // 30 MB JSON payload budget
    const POST_CONCURRENCY = 2;

    let inserted = 0;
    let failed = skipped;
    let done = 0;
    let nextFileIdx = 0;
    let pending: Promise<void>[] = [];
    let activePosts = 0;

    const flushBatch = async (batch: Item[]) => {
      try {
        const res = await apiRequest("/api/conversations/bulk-import", {
          method: "POST",
          body: JSON.stringify({ items: batch }),
        });
        inserted += res?.inserted || 0;
        failed += Array.isArray(res?.errors) ? res.errors.length : 0;
      } catch {
        failed += batch.length;
      } finally {
        done += batch.length;
        setBulkProgress({ total: valid.length, done, inserted, failed });
      }
    };

    // Build batches sequentially (so we can free memory between them) but
    // allow up to POST_CONCURRENCY in-flight POSTs at any time.
    while (nextFileIdx < valid.length) {
      const batch: Item[] = [];
      let batchBytes = 0;
      while (
        nextFileIdx < valid.length &&
        batch.length < MAX_BATCH_ITEMS &&
        batchBytes < MAX_BATCH_BYTES
      ) {
        const f = valid[nextFileIdx++];
        try {
          const text = await f.text();
          let kind = detectKindFromFile(f);
          if (f.name.toLowerCase().endsWith(".json")) {
            const sniffed = sniffJsonKind(text);
            if (sniffed) kind = sniffed;
          }
          // Approximate JSON byte size: title + content + small overhead.
          // Skip mid-batch if a single oversized file would blow the budget;
          // start a fresh batch for it on the next loop iteration.
          const approxBytes = text.length + f.name.length + 64;
          if (batch.length > 0 && batchBytes + approxBytes > MAX_BATCH_BYTES) {
            nextFileIdx--; // re-process this file next batch
            break;
          }
          batch.push({ kind, title: f.name, content: text });
          batchBytes += approxBytes;
        } catch {
          failed += 1;
          done += 1;
          setBulkProgress({ total: valid.length, done, inserted, failed });
        }
      }
      if (batch.length === 0) continue;

      // Throttle in-flight POSTs.
      while (activePosts >= POST_CONCURRENCY) {
        await Promise.race(pending);
        pending = pending.filter((p) => (p as any).__done !== true);
      }
      activePosts++;
      const p = flushBatch(batch).finally(() => {
        activePosts--;
        (p as any).__done = true;
      });
      pending.push(p);
    }
    await Promise.all(pending);

    queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    toast({
      title: `Imported ${inserted} of ${valid.length}`,
      description:
        failed > 0
          ? `${failed} failed${skipped ? ` (${skipped} skipped: empty or >5MB)` : ""}.`
          : skipped
            ? `${skipped} skipped (empty or >5MB).`
            : "All transcripts saved. Summaries are skipped in bulk mode — open a conversation and click Summarize to generate one.",
    });
    setTimeout(() => setBulkProgress(null), 4000);
  };

  const connectSlack = async () => {
    try {
      const data = await apiRequest(
        "/api/integrations/meetings/slack/auth-url",
      );
      if (data?.authUrl) window.location.href = data.authUrl;
    } catch (err: any) {
      toast({
        title: "Slack connect failed",
        description: err?.message || "Try again later",
        variant: "destructive",
      });
    }
  };

  return (
    <div
      className="container mx-auto px-4 py-6 max-w-7xl"
      data-testid="page-conversations"
    >
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MessagesSquare className="h-6 w-6 text-indigo-600" />
            Conversations
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Pull team chats, threads and emails into your context library.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <FileUploadButton
            onFile={handleFileUpload}
            onFiles={handleBulkUpload}
            disabled={submitting || !!bulkProgress}
          />
          {bulkProgress && (
            <div
              className="text-xs text-muted-foreground"
              data-testid="bulk-progress"
            >
              Uploading {bulkProgress.done} / {bulkProgress.total} —{" "}
              {bulkProgress.inserted} saved
              {bulkProgress.failed > 0 ? `, ${bulkProgress.failed} failed` : ""}
            </div>
          )}
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as ConversationKind)}
        className="mb-6"
      >
        <TabsList className="grid grid-cols-4 w-full max-w-2xl">
          {(Object.keys(KIND_META) as ConversationKind[]).map((k) => {
            const meta = KIND_META[k];
            const Icon = meta.icon;
            return (
              <TabsTrigger
                key={k}
                value={k}
                className="text-xs gap-1"
                data-testid={`tab-${k}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {meta.label}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {/* Manual paste */}
        <TabsContent value="plain" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Manual paste</CardTitle>
              <CardDescription>{KIND_META.plain.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => openPaste("plain")}
                data-testid="button-paste-manual"
              >
                <Plus className="h-4 w-4 mr-2" /> Paste conversation
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Slack */}
        <TabsContent value="slack" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Hash className="h-4 w-4" /> Slack
                {slackStatus?.connected && (
                  <Badge
                    variant="outline"
                    className="ml-2 text-emerald-700 border-emerald-200 bg-emerald-50"
                  >
                    Connected
                    {slackStatus.workspaceName
                      ? `: ${slackStatus.workspaceName}`
                      : ""}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>{KIND_META.slack.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => openPaste("slack")}
                  variant="outline"
                  data-testid="button-paste-slack"
                >
                  <Plus className="h-4 w-4 mr-2" /> Paste Slack export JSON
                </Button>
                {!slackStatus?.connected && (
                  <Button
                    onClick={connectSlack}
                    data-testid="button-connect-slack"
                  >
                    <ExternalLink className="h-4 w-4 mr-2" /> Connect Slack
                  </Button>
                )}
              </div>

              {slackStatus?.connected && (
                <ChannelGrid
                  channels={slackChannels.map((c) => ({
                    id: c.id,
                    label: c.name,
                  }))}
                  loading={slackChannelsLoading}
                  pending={importSlackChannel.isPending}
                  onImport={(c) =>
                    importSlackChannel.mutate({ id: c.id, name: c.label })
                  }
                  testIdPrefix="slack-channel"
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Discord */}
        <TabsContent value="discord" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <MessagesSquare className="h-4 w-4" /> Discord
                {discordStatus?.connected && (
                  <Badge
                    variant="outline"
                    className="ml-2 text-emerald-700 border-emerald-200 bg-emerald-50"
                  >
                    Connected
                    {discordStatus.botName ? `: ${discordStatus.botName}` : ""}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>{KIND_META.discord.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => openPaste("discord")}
                  variant="outline"
                  data-testid="button-paste-discord"
                >
                  <Plus className="h-4 w-4 mr-2" /> Paste Discord export JSON
                </Button>
                {!discordStatus?.connected ? (
                  <Button
                    onClick={() => setShowDiscordConnect(true)}
                    data-testid="button-connect-discord"
                  >
                    <ExternalLink className="h-4 w-4 mr-2" /> Connect Discord
                    bot
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => disconnectDiscord.mutate()}
                    disabled={disconnectDiscord.isPending}
                    data-testid="button-disconnect-discord"
                  >
                    Disconnect
                  </Button>
                )}
              </div>

              {discordStatus?.connected && (
                <ChannelGrid
                  channels={discordChannels.map((c) => ({
                    id: c.id,
                    label: `${c.guildName} / #${c.name}`,
                    extra: { name: c.name, guildName: c.guildName },
                  }))}
                  loading={discordChannelsLoading}
                  pending={importDiscordChannel.isPending}
                  onImport={(c) =>
                    importDiscordChannel.mutate({
                      id: c.id,
                      name: c.extra?.name || c.label,
                      guildId: "",
                      guildName: c.extra?.guildName || "",
                    })
                  }
                  testIdPrefix="discord-channel"
                />
              )}

              {!discordStatus?.connected && (
                <p className="text-xs text-muted-foreground">
                  Or use{" "}
                  <a
                    href="https://github.com/Tyrrrz/DiscordChatExporter"
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    DiscordChatExporter
                  </a>{" "}
                  to export a channel as <code>JSON</code> and paste it above.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Email */}
        <TabsContent value="email" className="mt-4 space-y-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Mail className="h-4 w-4" /> Email
              </CardTitle>
              <CardDescription>{KIND_META.email.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => openPaste("email")}
                  variant="outline"
                  data-testid="button-paste-email"
                >
                  <Plus className="h-4 w-4 mr-2" /> Paste email
                </Button>
                <FileUploadButton
                  onFile={(f) => handleFileUpload(f, "email")}
                  accept=".eml,.mbox,message/rfc822,text/plain"
                  label="Upload .eml / .mbox"
                  disabled={submitting}
                />
              </div>
            </CardContent>
          </Card>

          {/* Gmail (Task #84) — OAuth + bulk import. Sits inside the Email tab
              because gmail messages are normalized into source=gmail
              conversations and surface in the same list/filters. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Mail className="h-4 w-4" /> Gmail
              </CardTitle>
              <CardDescription>
                Connect your Google account to pull recent emails (with
                attachments) into the Conversations Hub. Messages skip
                Promotions and Social automatically; re-imports dedupe by
                message id.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {gmailStatus?.connected ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                      <span className="font-medium">Connected</span>
                      {gmailStatus.email && (
                        <span className="text-slate-500">
                          as {gmailStatus.email}
                        </span>
                      )}
                    </div>
                    {gmailStatus.lastSynced && (
                      <div className="text-xs text-slate-500 mt-1">
                        Last synced{" "}
                        {new Date(gmailStatus.lastSynced).toLocaleString()}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => {
                        setGmailSelectedIds([]);
                        setGmailPickerOpen(true);
                      }}
                      data-testid="button-open-gmail-picker"
                    >
                      <Plus className="h-4 w-4 mr-2" /> Pick emails…
                    </Button>
                    <Button
                      onClick={() => importGmail.mutate({ max: 25 })}
                      disabled={importGmail.isPending}
                      variant="outline"
                      data-testid="button-import-gmail"
                    >
                      {importGmail.isPending ? (
                        <>Importing…</>
                      ) : (
                        <>Quick import last 25</>
                      )}
                    </Button>
                    <Button
                      onClick={() => disconnectGmail.mutate()}
                      variant="outline"
                      disabled={disconnectGmail.isPending}
                      data-testid="button-disconnect-gmail"
                    >
                      Disconnect
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  onClick={connectGmail}
                  data-testid="button-connect-gmail"
                >
                  <ExternalLink className="h-4 w-4 mr-2" /> Connect Gmail
                </Button>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Gmail picker dialog (Task #84) — search by query + label, multi-select
          messages, optionally assign to a project on import. */}
      <Dialog open={gmailPickerOpen} onOpenChange={setGmailPickerOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4" /> Pick Gmail messages to import
            </DialogTitle>
            <DialogDescription>
              Search your mailbox, pick the messages you want, and optionally
              assign them to a project on import.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 flex-1 min-h-0 flex flex-col">
            <div className="flex flex-col sm:flex-row gap-2 shrink-0">
              <Input
                value={gmailQuery}
                onChange={(e) => setGmailQuery(e.target.value)}
                placeholder="Gmail search (e.g. from:jane@acme.com newer_than:7d)"
                className="text-sm"
                data-testid="input-gmail-search"
              />
              <select
                value={gmailSelectedLabel}
                onChange={(e) => setGmailSelectedLabel(e.target.value)}
                className="text-sm border rounded-md px-2 h-9"
                data-testid="select-gmail-label"
              >
                <option value="">All labels</option>
                {(gmailLabelsData?.labels || [])
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
              <select
                value={gmailProjectId}
                onChange={(e) => setGmailProjectId(e.target.value)}
                className="text-sm border rounded-md px-2 h-9"
                data-testid="select-gmail-project"
              >
                <option value="">No project</option>
                {allProjects.map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.title}
                  </option>
                ))}
              </select>
            </div>

            <ScrollArea className="flex-1 min-h-[160px] border rounded-md">
              {gmailMessagesFetching ? (
                <div className="flex items-center justify-center py-12 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading
                  messages…
                </div>
              ) : (gmailMessagesData?.messages || []).length === 0 ? (
                <div className="text-center text-sm text-slate-500 py-12">
                  No messages match this search.
                </div>
              ) : (
                <ul className="divide-y">
                  {(gmailMessagesData?.messages || []).map((m) => {
                    const checked = gmailSelectedIds.includes(m.id);
                    return (
                      <li
                        key={m.id}
                        className="flex items-start gap-3 p-3 hover:bg-slate-50 cursor-pointer"
                        onClick={() =>
                          setGmailSelectedIds((prev) =>
                            checked
                              ? prev.filter((x) => x !== m.id)
                              : [...prev, m.id],
                          )
                        }
                        data-testid={`gmail-message-${m.id}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {}}
                          className="mt-1"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-sm font-medium truncate">
                              {m.subject}
                            </div>
                            {m.date && (
                              <div className="text-[11px] text-slate-500 whitespace-nowrap">
                                {new Date(m.date).toLocaleDateString()}
                              </div>
                            )}
                          </div>
                          <div className="text-xs text-slate-600 truncate">
                            {m.from}
                          </div>
                          <div className="text-xs text-slate-500 line-clamp-2 mt-1">
                            {m.snippet}
                          </div>
                          {m.hasAttachments && (
                            <Badge
                              variant="outline"
                              className="mt-1 text-[10px] h-4 px-1"
                            >
                              has attachments
                            </Badge>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </ScrollArea>

            <div className="flex items-center justify-between text-xs text-slate-500 shrink-0">
              <span>{gmailSelectedIds.length} selected</span>
              <button
                type="button"
                className="text-blue-600 hover:underline"
                onClick={() =>
                  setGmailSelectedIds(
                    (gmailMessagesData?.messages || []).map((m) => m.id),
                  )
                }
              >
                Select all on this page
              </button>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setGmailPickerOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={gmailSelectedIds.length === 0 || importGmail.isPending}
              onClick={() => {
                const projectIdNum = gmailProjectId
                  ? parseInt(gmailProjectId, 10)
                  : undefined;
                importGmail.mutate(
                  {
                    messageIds: gmailSelectedIds,
                    projectId: projectIdNum,
                  },
                  {
                    onSuccess: () => {
                      setGmailPickerOpen(false);
                      setGmailSelectedIds([]);
                    },
                  },
                );
              }}
              data-testid="button-gmail-import-selected"
            >
              {importGmail.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Importing…
                </>
              ) : (
                <>Import {gmailSelectedIds.length || ""} selected</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent conversations</CardTitle>
          <CardDescription>
            Open any conversation to summarize, route action items to a project,
            or send it to the Context Brain.
          </CardDescription>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mt-3">
            <div className="relative max-w-sm w-full">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <Input
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
                placeholder="Search title, channel, participants…"
                className="text-xs h-8 pl-7"
                data-testid="input-conversations-search"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {(["all", "manual", "slack", "discord", "email"] as const).map(
                (src) => (
                  <Button
                    key={src}
                    size="sm"
                    variant={sourceFilter === src ? "default" : "outline"}
                    className="h-7 text-xs px-2"
                    onClick={() => setSourceFilter(src)}
                    data-testid={`filter-source-${src}`}
                  >
                    {src === "all"
                      ? "All"
                      : src.charAt(0).toUpperCase() + src.slice(1)}
                    <Badge
                      variant="outline"
                      className="ml-1 px-1 h-4 text-[10px] bg-white/60 border-current"
                    >
                      {sourceCounts[src] || 0}
                    </Badge>
                  </Button>
                ),
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
            </div>
          ) : filteredConversations.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <MessagesSquare className="h-10 w-10 mx-auto mb-3 text-slate-300" />
              <p className="text-sm">
                No conversations yet. Paste your first one above.
              </p>
            </div>
          ) : (
            <ScrollArea className="max-h-[600px] pr-2">
              <div className="space-y-2">
                {filteredConversations.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-start justify-between border rounded-md px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-900/50 cursor-pointer"
                    onClick={() => setPreviewConv(c)}
                    data-testid={`conversation-${c.id}`}
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <div
                        className={`mt-0.5 inline-flex items-center justify-center h-7 w-7 rounded border ${sourceBadge(
                          c.source,
                        )}`}
                      >
                        <SourceIcon source={c.source} />
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">
                          {c.title}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                          <Badge
                            variant="outline"
                            className={`text-[10px] py-0 px-1 ${sourceBadge(
                              c.source,
                            )}`}
                          >
                            {c.source}
                          </Badge>
                          {c.channelName && <span>#{c.channelName}</span>}
                          {c.participants && c.participants.length > 0 && (
                            <span>{c.participants.length} participant(s)</span>
                          )}
                          {c.summary && (
                            <Badge
                              variant="outline"
                              className="text-[10px] py-0 px-1 bg-emerald-50 text-emerald-700 border-emerald-200"
                            >
                              <Sparkles className="h-2.5 w-2.5 mr-1" />{" "}
                              Summarized
                            </Badge>
                          )}
                          {c.projectId && (
                            <Badge
                              variant="outline"
                              className="text-[10px] py-0 px-1 bg-emerald-50 text-emerald-700 border-emerald-200"
                            >
                              <Folder className="h-2.5 w-2.5 mr-1" />
                              {allProjects.find((p) => p.id === c.projectId)
                                ?.name || "Project"}
                            </Badge>
                          )}
                          {c.createdAt && (
                            <span>
                              {new Date(c.createdAt).toLocaleString()}
                            </span>
                          )}
                        </div>
                        {c.tags && c.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {c.tags.slice(0, 5).map((t) => (
                              <Badge
                                key={t}
                                variant="outline"
                                className="text-[10px] py-0 px-1 bg-sky-50 text-sky-700 border-sky-200"
                              >
                                <TagIcon className="h-2 w-2 mr-0.5" />
                                {t}
                              </Badge>
                            ))}
                            {c.tags.length > 5 && (
                              <span className="text-[10px] text-slate-400">
                                +{c.tags.length - 5}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-600 hover:text-red-700"
                      disabled={deleteConv.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete "${c.title}"?`)) {
                          deleteConv.mutate(c.id);
                        }
                      }}
                      data-testid={`button-delete-${c.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Preview dialog with summarize + action items + send-to-brain */}
      <Dialog
        open={!!previewConv}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewConv(null);
            setEditingTitle(false);
            setTagDraft("");
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {previewLive && <SourceIcon source={previewLive.source} />}
              {editingTitle ? (
                <div className="flex items-center gap-1 flex-1">
                  <Input
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveTitle();
                      if (e.key === "Escape") setEditingTitle(false);
                    }}
                    className="h-8 text-base"
                    data-testid="input-rename-conversation"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleSaveTitle}
                    disabled={updateConv.isPending}
                    data-testid="button-save-rename"
                  >
                    <Check className="h-4 w-4 text-emerald-600" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditingTitle(false)}
                  >
                    <X className="h-4 w-4 text-slate-500" />
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (!previewLive) return;
                    setTitleDraft(previewLive.title);
                    setEditingTitle(true);
                  }}
                  className="flex items-center gap-1.5 group text-left"
                  data-testid="button-rename-conversation"
                >
                  <span>{previewLive?.title}</span>
                  <Pencil className="h-3.5 w-3.5 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              )}
            </DialogTitle>
            <DialogDescription className="flex items-center gap-2 text-xs flex-wrap">
              <Badge
                variant="outline"
                className={`text-[10px] py-0 px-1 ${sourceBadge(
                  previewLive?.source || "",
                )}`}
              >
                {previewLive?.source}
              </Badge>
              {previewLive?.channelName && (
                <span>#{previewLive.channelName}</span>
              )}
              {previewLive?.participants &&
                previewLive.participants.length > 0 && (
                  <span>{previewLive.participants.length} participants</span>
                )}
            </DialogDescription>
          </DialogHeader>

          {/* Project + Tags row */}
          {previewLive && (
            <div className="flex flex-wrap items-center gap-2 -mt-1 mb-1 text-xs">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 text-xs"
                    data-testid="button-assign-project"
                  >
                    <Folder className="h-3.5 w-3.5" />
                    {previewLive.projectId
                      ? allProjects.find((p) => p.id === previewLive.projectId)
                          ?.name || "Project"
                      : "Assign project"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-64 p-2" align="start">
                  <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1 px-1">
                    Project
                  </div>
                  <ScrollArea className="max-h-56">
                    <div className="space-y-0.5">
                      {previewLive.projectId && (
                        <button
                          onClick={() => handleAssignProject(null)}
                          className="w-full text-left px-2 py-1.5 rounded text-xs text-red-600 hover:bg-red-50 flex items-center gap-1.5"
                          data-testid="button-unassign-project"
                        >
                          <X className="h-3 w-3" /> Remove from project
                        </button>
                      )}
                      {allProjects.length === 0 ? (
                        <div className="px-2 py-2 text-xs text-slate-400">
                          No projects yet.
                        </div>
                      ) : (
                        allProjects.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => handleAssignProject(p.id)}
                            className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-emerald-50 flex items-center justify-between ${
                              previewLive.projectId === p.id
                                ? "bg-emerald-50 text-emerald-700"
                                : "text-slate-700"
                            }`}
                            data-testid={`button-project-${p.id}`}
                          >
                            <span className="truncate">{p.name}</span>
                            {previewLive.projectId === p.id && (
                              <Check className="h-3 w-3" />
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </PopoverContent>
              </Popover>

              <div className="flex items-center gap-1 flex-wrap">
                {(previewLive.tags || []).map((t) => (
                  <Badge
                    key={t}
                    variant="outline"
                    className="text-[10px] gap-1 pl-1.5 pr-1 py-0 bg-sky-50 text-sky-700 border-sky-200"
                  >
                    <TagIcon className="h-2.5 w-2.5" />
                    {t}
                    <button
                      onClick={() => handleRemoveTag(t)}
                      className="hover:bg-sky-100 rounded p-0.5"
                      data-testid={`button-remove-tag-${t}`}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </Badge>
                ))}
                <div className="flex items-center gap-1">
                  <Input
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddTag();
                      }
                    }}
                    placeholder="Add tag…"
                    className="h-6 text-xs px-2 w-24"
                    data-testid="input-add-tag"
                  />
                  {tagDraft.trim() && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleAddTag}
                      disabled={updateConv.isPending}
                      className="h-6 px-1.5"
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 mb-2">
            <Button
              size="sm"
              onClick={() => previewLive && summarize.mutate(previewLive.id)}
              disabled={summarize.isPending || !previewLive}
              data-testid="button-summarize"
            >
              {summarize.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 mr-1" />
              )}
              {previewLive?.summary ? "Re-summarize" : "Summarize with AI"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => previewLive && sendToBrain.mutate(previewLive)}
              disabled={sendToBrain.isPending || !previewLive}
              data-testid="button-send-brain"
            >
              {sendToBrain.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Brain className="h-3.5 w-3.5 mr-1" />
              )}
              Send to Context Brain
            </Button>
            <a
              href="/evidence"
              className="inline-flex items-center text-xs text-slate-600 hover:text-slate-900 px-2 py-1"
            >
              <Library className="h-3.5 w-3.5 mr-1" /> Open Evidence Library
            </a>
          </div>

          <ScrollArea className="max-h-[460px] pr-2">
            {previewLive && (
              <ConversationAttachments conversationId={previewLive.id} />
            )}
            {previewLive?.summary && (
              <div className="border rounded-md p-3 bg-emerald-50/40 mb-3">
                <div className="text-xs font-semibold text-emerald-900 flex items-center gap-1 mb-2">
                  <Sparkles className="h-3 w-3" /> AI summary
                </div>
                <div className="prose prose-sm max-w-none text-slate-800">
                  <ReactMarkdown>{previewLive.summary}</ReactMarkdown>
                </div>
              </div>
            )}

            {previewLive && (
              <ConversationActionItems
                conversation={previewLive}
                onChanged={() => {
                  queryClient.invalidateQueries({
                    queryKey: ["/api/conversations"],
                  });
                  queryClient.invalidateQueries({
                    queryKey: ["/api/conversations", previewLive.id],
                  });
                }}
              />
            )}

            <details className="border rounded-md p-2 mt-2" open>
              <summary className="text-xs font-medium cursor-pointer text-slate-600 flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  Raw transcript
                  {previewLive?.content && (
                    <Badge
                      variant="outline"
                      className="text-[10px] py-0 px-1.5"
                    >
                      {previewLive.content.length.toLocaleString()} chars
                    </Badge>
                  )}
                </span>
                <span className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={(e) => {
                      e.preventDefault();
                      if (previewLive) handleCopyTranscript(previewLive);
                    }}
                    data-testid="button-copy-transcript"
                  >
                    <Copy className="h-3 w-3 mr-1" /> Copy
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={(e) => {
                      e.preventDefault();
                      if (previewLive) handleDownloadTranscript(previewLive);
                    }}
                    data-testid="button-download-transcript"
                  >
                    <Download className="h-3 w-3 mr-1" /> Download .txt
                  </Button>
                </span>
              </summary>
              <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed mt-2 max-h-72 overflow-y-auto bg-slate-50/60 rounded p-2 border border-slate-100">
                {previewLive?.content || ""}
              </pre>
            </details>
          </ScrollArea>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setPreviewConv(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Paste dialog */}
      <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{KIND_META[pasteKind].label}</DialogTitle>
            <DialogDescription>
              {KIND_META[pasteKind].description}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label htmlFor="conv-title">Title (optional)</Label>
              <Input
                id="conv-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. #product-feedback Tuesday standup"
                data-testid="input-conv-title"
              />
            </div>
            <div>
              <Label htmlFor="conv-content">Content</Label>
              <Textarea
                id="conv-content"
                rows={14}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={
                  pasteKind === "slack"
                    ? '[\n  {"user_profile":{"real_name":"Ada"},"ts":"1700000000.0","text":"Hi"}\n]'
                    : pasteKind === "discord"
                      ? '{\n  "channel": {"name": "general"},\n  "messages": [...]\n}'
                      : pasteKind === "email"
                        ? "Subject: Feedback on dashboard\nFrom: alice@example.com\n\nHi team, ..."
                        : "Paste any chat / notes here..."
                }
                className="font-mono text-xs"
                data-testid="textarea-conv-content"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPasteOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting || !content.trim()}
              data-testid="button-submit-conv"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              Save conversation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Discord connect dialog */}
      <Dialog open={showDiscordConnect} onOpenChange={setShowDiscordConnect}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Discord bot</DialogTitle>
            <DialogDescription>
              Create a bot under your Discord application, invite it to your
              server with <code>Read Messages</code> +{" "}
              <code>Read Message History</code> permissions, and paste the bot
              token here.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="discord-token">Bot token</Label>
            <Input
              id="discord-token"
              type="password"
              value={discordToken}
              onChange={(e) => setDiscordToken(e.target.value)}
              placeholder="MTEx... (kept private, used only to read channels)"
              data-testid="input-discord-token"
            />
            <p className="text-xs text-muted-foreground">
              Tokens never leave your account. Disconnect any time to revoke
              access from Requisor.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setShowDiscordConnect(false)}
              disabled={connectDiscord.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => connectDiscord.mutate(discordToken.trim())}
              disabled={
                connectDiscord.isPending || discordToken.trim().length < 20
              }
              data-testid="button-confirm-connect-discord"
            >
              {connectDiscord.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- Reusable bits ----

function FileUploadButton({
  onFile,
  onFiles,
  accept = ".txt,.md,.json,.eml,.mbox,text/plain,application/json,message/rfc822",
  label = "Upload file(s)",
  disabled,
}: {
  onFile: (file: File) => void;
  // When provided, the input switches to multi-select and routes through
  // onFiles (which can implement bulk batching). For backwards compat the
  // single-file onFile handler is still required.
  onFiles?: (files: File[]) => void;
  accept?: string;
  label?: string;
  disabled?: boolean;
}) {
  const multi = !!onFiles;
  return (
    <label className="inline-flex">
      <input
        type="file"
        accept={accept}
        multiple={multi}
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (files.length === 0) return;
          if (onFiles) onFiles(files);
          else onFile(files[0]);
          e.target.value = "";
        }}
        data-testid="input-conversation-file"
      />
      <Button asChild variant="outline" disabled={disabled}>
        <span>
          <Upload className="h-4 w-4 mr-2" /> {label}
        </span>
      </Button>
    </label>
  );
}

function ChannelGrid({
  channels,
  loading,
  pending,
  onImport,
  testIdPrefix,
}: {
  channels: Array<{ id: string; label: string; extra?: any }>;
  loading: boolean;
  pending: boolean;
  onImport: (c: { id: string; label: string; extra?: any }) => void;
  testIdPrefix: string;
}) {
  if (loading) {
    return (
      <div className="flex items-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading channels…
      </div>
    );
  }
  if (channels.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No channels visible — make sure the bot/app is invited to a server with
        the right permissions.
      </p>
    );
  }
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
      {channels.map((ch) => (
        <div
          key={ch.id}
          className="flex items-center justify-between border rounded-md px-3 py-2 text-sm"
          data-testid={`${testIdPrefix}-${ch.id}`}
        >
          <span className="flex items-center gap-1 truncate">
            <Hash className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="truncate">{ch.label}</span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => onImport(ch)}
            data-testid={`button-import-${testIdPrefix}-${ch.id}`}
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      ))}
    </div>
  );
}

interface AttachmentRow {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
  objectPath: string | null;
}

function ConversationAttachments({
  conversationId,
}: {
  conversationId: number;
}) {
  const { data, isLoading } = useQuery<
    { attachments: AttachmentRow[] } | AttachmentRow[]
  >({
    queryKey: ["/api/conversations", conversationId, "attachments"],
    queryFn: () =>
      apiRequest(`/api/conversations/${conversationId}/attachments`),
  });
  const rows: AttachmentRow[] = Array.isArray(data)
    ? data
    : (data?.attachments ?? []);
  if (isLoading || rows.length === 0) return null;
  const fmt = (n: number) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };
  return (
    <div
      className="border rounded-md p-3 bg-slate-50/60 mb-3"
      data-testid="conv-attachments"
    >
      <div className="text-xs font-semibold text-slate-700 flex items-center gap-1 mb-2">
        <Paperclip className="h-3 w-3" /> Attachments ({rows.length})
      </div>
      <div className="space-y-1.5">
        {rows.map((a) => {
          const downloadable = !!a.objectPath;
          return (
            <div
              key={a.id}
              className="flex items-center justify-between gap-2 text-xs bg-white rounded border px-2 py-1.5"
              data-testid={`attachment-${a.id}`}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Paperclip className="h-3 w-3 text-slate-400 shrink-0" />
                <span className="truncate font-medium text-slate-800">
                  {a.filename}
                </span>
                <span className="text-slate-500 shrink-0">{fmt(a.size)}</span>
              </div>
              {downloadable ? (
                <a
                  href={`/api/conversations/${conversationId}/attachments/${a.id}/download`}
                  className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 text-xs font-medium shrink-0"
                  data-testid={`download-attachment-${a.id}`}
                >
                  <Download className="h-3 w-3" /> Download
                </a>
              ) : (
                <span className="text-[10px] text-slate-400 shrink-0">
                  metadata only
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Lightweight inline action-items routing — mirrors the Meetings page
// (ActionItemsBlock there) but keeps the surface small for v1: route to an
// existing project or create a brand new one. Re-routing/unrouting/delete
// remain available on the Meetings page.
function ConversationActionItems({
  conversation,
  onChanged,
}: {
  conversation: Conversation;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const items: ConversationActionItem[] = conversation.actionItems ?? [];
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [createFor, setCreateFor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const route = useMutation({
    mutationFn: async (vars: {
      itemId: string;
      body:
        | { projectId: number }
        | { newProject: { name: string; description?: string } };
    }) =>
      apiRequest(
        `/api/conversations/${conversation.id}/action-items/${vars.itemId}/route`,
        { method: "POST", body: JSON.stringify(vars.body) },
      ),
    onSuccess: () => {
      onChanged();
      setPickerFor(null);
      setCreateFor(null);
      setQuery("");
      setNewName("");
      setNewDesc("");
      toast({ title: "Routed to project" });
    },
    onError: (err: any) =>
      toast({
        title: "Could not route",
        description: err?.message || "Try again",
        variant: "destructive",
      }),
  });

  if (!items || items.length === 0) {
    return (
      <div className="border rounded-md p-3 mb-2 text-xs text-slate-500 flex items-center gap-2">
        <ListChecks className="h-3.5 w-3.5" />
        No action items yet. Hit{" "}
        <span className="font-semibold">Summarize with AI</span> to extract any.
      </div>
    );
  }

  const filtered = query.trim()
    ? projects.filter((p) =>
        p.name.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : projects;

  return (
    <div className="border rounded-md p-3 mb-2 bg-white">
      <div className="flex items-center gap-1 mb-2">
        <ListChecks className="h-3.5 w-3.5 text-slate-600" />
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
                <p className="text-xs text-slate-800 break-words">
                  {item.text}
                </p>
                {(item.owner || item.dueHint) && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {item.owner && (
                      <Badge
                        variant="outline"
                        className="text-[10px] h-4 px-1.5 bg-slate-50 text-slate-600 border-slate-200"
                      >
                        {item.owner}
                      </Badge>
                    )}
                    {item.dueHint && (
                      <Badge
                        variant="outline"
                        className="text-[10px] h-4 px-1.5 bg-slate-50 text-slate-600 border-slate-200"
                      >
                        {item.dueHint}
                      </Badge>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 sm:ml-2 shrink-0">
                {routed ? (
                  <a
                    href={`/projects/${item.routedProjectId}`}
                    className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-800"
                    data-testid={`action-item-routed-${item.id}`}
                  >
                    <CheckCircle className="h-3.5 w-3.5" />
                    <span className="truncate max-w-[160px]">
                      {item.routedProjectName || "Project"}
                    </span>
                    <ArrowRight className="h-3 w-3" />
                  </a>
                ) : (
                  <>
                    <Popover
                      open={pickerFor === item.id}
                      onOpenChange={(open) => {
                        setPickerFor(open ? item.id : null);
                        if (!open) setQuery("");
                      }}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs h-7 px-2"
                          disabled={route.isPending}
                          data-testid={`button-add-to-project-${item.id}`}
                        >
                          <Folder className="h-3 w-3 mr-1" /> Add to project
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="p-0 w-72">
                        <div className="p-2 border-b border-slate-100">
                          <div className="relative">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                            <Input
                              autoFocus
                              value={query}
                              onChange={(e) => setQuery(e.target.value)}
                              placeholder="Search projects..."
                              className="text-xs h-8 pl-7"
                            />
                          </div>
                        </div>
                        <ScrollArea className="max-h-56">
                          {filtered.length === 0 ? (
                            <div className="p-3 text-center text-xs text-slate-500">
                              No matching projects.
                            </div>
                          ) : (
                            <div className="py-1">
                              {filtered.map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  onClick={() =>
                                    route.mutate({
                                      itemId: item.id,
                                      body: { projectId: p.id },
                                    })
                                  }
                                  disabled={route.isPending}
                                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-100 flex items-center gap-2 disabled:opacity-50"
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
                      disabled={route.isPending}
                      onClick={() => {
                        setNewName(item.text.slice(0, 60));
                        setNewDesc(
                          `Created from action item in: ${conversation.title}`,
                        );
                        setCreateFor(item.id);
                      }}
                      data-testid={`button-create-project-${item.id}`}
                    >
                      <FolderPlus className="h-3 w-3 mr-1" /> New project
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <Dialog
        open={createFor !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreateFor(null);
            setNewName("");
            setNewDesc("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create project from action item</DialogTitle>
            <DialogDescription>
              We'll create a new project and add this action item as its first
              task.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="new-project-name" className="text-xs">
                Project name
              </Label>
              <Input
                id="new-project-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="new-project-desc" className="text-xs">
                Description (optional)
              </Label>
              <Textarea
                id="new-project-desc"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCreateFor(null)}
              disabled={route.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!createFor || !newName.trim()) return;
                route.mutate({
                  itemId: createFor,
                  body: {
                    newProject: {
                      name: newName.trim(),
                      description: newDesc.trim() || undefined,
                    },
                  },
                });
              }}
              disabled={route.isPending || !newName.trim()}
            >
              {route.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <FolderPlus className="h-3.5 w-3.5 mr-1" />
              )}
              Create project & add task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
