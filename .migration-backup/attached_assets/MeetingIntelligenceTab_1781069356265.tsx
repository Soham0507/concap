/**
 * Meeting Intelligence Tab — UI for the enterprise meeting intelligence
 * system. Drives the `POST /api/meetings/intelligence/process` endpoint.
 *
 * MVP scope shipped here:
 *  - Paste-or-upload a single transcript with metadata (project, dept,
 *    source, date, participants)
 *  - Run the processor — server applies the system prompt the user
 *    authored, returns both structured JSON and a Markdown MOM
 *  - Render the two outputs side-by-side with copy/download
 *  - List previously processed documents for this user
 *
 * Out of scope here (designed for follow-up):
 *  - Bulk processing of 2000+ transcripts (needs background-queue worker)
 *  - External connectors (Zoom/Teams/Meet/Slack/Discord/Email APIs)
 *  - Audio/video transcription (handled by file-processor service today;
 *    can be wired through later)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDropzone } from "react-dropzone";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Brain,
  Sparkles,
  Loader2,
  Copy,
  Download,
  FileText,
  Upload,
  AlertCircle,
  CheckCircle,
  Layers,
  Zap,
  ChevronRight,
  ChevronDown,
  RotateCw,
  RefreshCw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  IntelligenceDocumentView,
  SourceTranscriptPane,
} from "./IntelligenceDocumentView";
import { BatchSummaryView, type BatchSummary } from "./BatchSummaryView";

interface IntelligenceDocument {
  id: number;
  batchId: number | null;
  transcriptId: string;
  projectName: string | null;
  department: string | null;
  meetingSource: string;
  meetingDate: string | null;
  meetingTitle: string | null;
  participants: string[] | null;
  /** Original transcript text — used by the structured viewer to scroll
   *  to the source line when an evidence link is clicked. */
  transcriptText: string;
  documentJson: any;
  documentMarkdown: string;
  confidenceScore: number | null;
  status: "queued" | "processing" | "completed" | "failed";
  errorMessage: string | null;
  createdAt: string;
  /** Updated each time the worker writes to the row — used by the UI to
   *  detect when the active doc has been refreshed by polling. */
  updatedAt?: string;
}

interface IntelligenceBatch {
  id: number;
  label: string | null;
  status: "queued" | "running" | "completed" | "failed";
  totalCount: number;
  completedCount: number;
  failedCount: number;
  createdAt: string;
  completedAt: string | null;
}

interface EnqueueResult {
  batch: IntelligenceBatch;
  enqueued: number;
  skipped: number;
}

const MEETING_SOURCES = [
  "Zoom",
  "Microsoft Teams",
  "Google Meet",
  "Slack",
  "Discord",
  "Email",
  "Audio/Video",
  "PDF/DOCX/TXT",
  "Other",
] as const;

/**
 * Best-effort heuristic to infer a transcript's source platform from its
 * filename and the first kilobyte of content. Used when the user bulk-uploads
 * mixed files so they don't have to set the source for every one by hand.
 * Falls back to the caller-supplied default when nothing matches.
 *
 *  - VTT and SRT files: vendor-agnostic captions. We only mark them as a
 *    specific platform when the filename gives it away.
 *  - JSON / JSONL: if the file parses as JSON it's likely a structured
 *    export — leave the source to the default unless the filename hints.
 */
function detectSource(
  filename: string,
  text: string,
  fallback: string,
): string {
  const name = (filename || "").toLowerCase();
  const head = (text || "").slice(0, 1024).toLowerCase();

  if (/\bzoom\b/.test(name) || /zoom\.us|zoom meeting/.test(head)) return "Zoom";
  if (/\bteams\b|microsoft/.test(name) || /microsoft teams|teams\.microsoft/.test(head))
    return "Microsoft Teams";
  if (/\bmeet\b|google[-_]?meet|gmeet/.test(name) || /google meet|meet\.google\.com/.test(head))
    return "Google Meet";
  if (/\bslack\b/.test(name) || /slack\.com/.test(head)) return "Slack";
  if (/\bdiscord\b/.test(name) || /discord\.com/.test(head)) return "Discord";
  if (/\.eml$|email|outlook|gmail/.test(name) || /^from:.*\nto:/im.test(head))
    return "Email";
  if (/\.(srt|vtt|mp3|mp4|m4a|wav|webm)$/.test(name)) return "Audio/Video";
  if (/\.(pdf|docx|doc)$/.test(name)) return "PDF/DOCX/TXT";
  return fallback;
}

export function MeetingIntelligenceTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Form state
  const [transcriptText, setTranscriptText] = useState("");
  const [projectName, setProjectName] = useState("");
  const [department, setDepartment] = useState("");
  const [meetingSource, setMeetingSource] = useState<string>("Zoom");
  const [meetingDate, setMeetingDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [participants, setParticipants] = useState("");

  // Result of the most recent processing run
  const [activeResult, setActiveResult] = useState<IntelligenceDocument | null>(
    null,
  );

  // ── Bulk state ─────────────────────────────────────────────────────
  const [bulkLabel, setBulkLabel] = useState("");
  const [bulkRaw, setBulkRaw] = useState(""); // JSON array OR JSONL pasted by user
  const [bulkDefaultSource, setBulkDefaultSource] = useState<string>("Zoom");
  // Per-line file uploads: each attached file becomes one transcript and
  // can carry its own meeting_source. Source is auto-detected on add and
  // overridable per row in the UI.
  const [bulkFiles, setBulkFiles] = useState<
    Array<{ name: string; text: string; source: string }>
  >([]);
  // While any batch is in non-terminal state, poll the batches endpoint to
  // animate progress bars without a websocket.
  const [shouldPollBatches, setShouldPollBatches] = useState(false);
  // Which batch row is expanded to show its document-level details.
  const [expandedBatchId, setExpandedBatchId] = useState<number | null>(null);

  // Ref on the output card so we can scroll it into view when the user
  // selects a doc from far down the page (batch panel or history list).
  // Without this the panel updates silently above-the-fold and looks empty.
  const outputCardRef = useRef<HTMLDivElement | null>(null);

  // Which output sub-tab is visible (Structured MOM / JSON / Source).
  // Clicking an evidence quote flips this to "transcript" so the user
  // sees the highlight in context.
  const [outputTab, setOutputTab] = useState<"mom" | "json" | "transcript">("mom");
  // The quote text the source-pane should locate + highlight.
  const [jumpQuote, setJumpQuote] = useState<string | null>(null);

  /** Invoked from inside the rich view whenever an evidence quote is clicked. */
  const handleJumpToTranscript = useCallback((quote: string) => {
    setJumpQuote(quote);
    setOutputTab("transcript");
  }, []);

  // Active batch summary view (mutually exclusive with activeResult).
  // When non-null, the output card renders the batch-summary instead of a
  // single doc.
  const [activeBatchSummaryId, setActiveBatchSummaryId] = useState<number | null>(null);

  // Fetched batch summary payload. Lazy + uses an explicit queryFn to hit
  // the right URL (the default queryFn just fetches queryKey[0]).
  const { data: batchSummaryData, isFetching: batchSummaryFetching } =
    useQuery<BatchSummary>({
      queryKey: [
        "/api/meetings/intelligence/batches/summary",
        activeBatchSummaryId,
      ],
      enabled: activeBatchSummaryId !== null,
      queryFn: async () => {
        const r = await fetch(
          `/api/meetings/intelligence/batches/${activeBatchSummaryId}/summary`,
          { credentials: "include" },
        );
        if (!r.ok) {
          throw new Error(`Failed to load batch summary (HTTP ${r.status})`);
        }
        return r.json();
      },
    });

  /** Load a doc into the active result and scroll the output card into view. */
  const selectDocument = useCallback((doc: IntelligenceDocument) => {
    setActiveResult(doc);
    // Reset the tab + jump-quote + clear any active batch summary so we
    // never carry a highlight or aggregated view from a previous click
    // into a freshly opened doc.
    setOutputTab("mom");
    setJumpQuote(null);
    setActiveBatchSummaryId(null);
    // Defer the scroll one frame so the panel re-renders first.
    requestAnimationFrame(() => {
      outputCardRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }, []);

  /** Open the aggregated MOM view for a batch in the output card. */
  const viewBatchSummary = useCallback((batchId: number) => {
    setActiveBatchSummaryId(batchId);
    setActiveResult(null);
    setJumpQuote(null);
    setOutputTab("mom");
    requestAnimationFrame(() => {
      outputCardRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }, []);

  /**
   * Click handler for a citation inside the batch-summary view. Fetches
   * the source document, swaps the output card into single-doc mode,
   * and (if a quote was supplied) opens the Raw Transcript tab with
   * the line highlighted.
   */
  const openSourceFromSummary = useCallback(
    async (docId: number, quote: string | null) => {
      try {
        const doc = (await apiRequest(
          `/api/meetings/intelligence/documents/${docId}`,
          { method: "GET" },
        )) as IntelligenceDocument;
        setActiveBatchSummaryId(null);
        setActiveResult(doc);
        setOutputTab(quote ? "transcript" : "mom");
        setJumpQuote(quote);
        requestAnimationFrame(() => {
          outputCardRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        });
      } catch (err: any) {
        toast({
          title: "Could not open source",
          description: err?.message || "Failed to load the source document.",
          variant: "destructive",
        });
      }
    },
    [toast],
  );

  // List of past documents for this user
  const {
    data: documents = [],
    isLoading: isLoadingHistory,
  } = useQuery<IntelligenceDocument[]>({
    queryKey: ["/api/meetings/intelligence/documents"],
    // While a batch is running, doc rows transition queued → processing →
    // completed in the background. Poll so users see them appear.
    refetchInterval: shouldPollBatches ? 4000 : false,
  });

  // List of batches for this user, with auto-polling while anything is
  // running. Once everything settles to completed/failed, polling pauses.
  const { data: batches = [] } = useQuery<IntelligenceBatch[]>({
    queryKey: ["/api/meetings/intelligence/batches"],
    refetchInterval: shouldPollBatches ? 4000 : false,
  });

  // Derive polling-state from active work in either dimension:
  //   • Any batch in queued/running (bulk submission still draining)
  //   • Any document in queued/processing (individual re-extract in flight)
  // Once everything settles, polling stops to save bandwidth.
  useEffect(() => {
    const batchActive = batches.some(
      (b) => b.status === "queued" || b.status === "running",
    );
    const docActive = documents.some(
      (d) => d.status === "queued" || d.status === "processing",
    );
    setShouldPollBatches(batchActive || docActive);
  }, [batches, documents]);

  // When the active doc is being re-extracted, the documents-list poll
  // returns fresh data. Sync the activeResult so the user sees status
  // tick from queued → processing → completed, and the MOM rebuilds with
  // the new EVIDENCE blocks as soon as the worker finishes.
  useEffect(() => {
    if (!activeResult) return;
    const fresh = documents.find((d) => d.id === activeResult.id);
    if (fresh && fresh.updatedAt !== (activeResult as any).updatedAt) {
      setActiveResult(fresh);
    }
  }, [documents, activeResult]);

  // Detail view of one expanded batch (lazy — only fetched when a row is
  // expanded). Also polls if the batch is still active.
  //
  // We supply an explicit queryFn because the global default just does
  // fetch(queryKey[0]); naively passing the id as queryKey[1] would still
  // hit the list endpoint. We need /batches/:id, which returns
  // { batch, documents }.
  const { data: expandedBatchDetail } = useQuery<{
    batch: IntelligenceBatch;
    documents: IntelligenceDocument[];
  }>({
    queryKey: [
      "/api/meetings/intelligence/batches/detail",
      expandedBatchId,
    ],
    enabled: expandedBatchId !== null,
    queryFn: async () => {
      const r = await fetch(
        `/api/meetings/intelligence/batches/${expandedBatchId}`,
        { credentials: "include" },
      );
      if (!r.ok) {
        throw new Error(`Failed to load batch detail (HTTP ${r.status})`);
      }
      return r.json();
    },
    refetchInterval: shouldPollBatches ? 4000 : false,
  });

  /**
   * Re-extract a single completed/failed document. Used to backfill
   * citations on documents that were processed before `evidence_quotes`
   * landed — no re-upload, the transcript_text is already stored.
   *
   * The endpoint is idempotent: clicking while a re-extract is already
   * in flight returns 200 with `alreadyQueued: true`. The UI shows a
   * neutral toast in that case rather than a destructive error.
   */
  const reprocessMutation = useMutation<
    {
      requeued: boolean;
      alreadyQueued?: boolean;
      documentId: number;
      status?: string;
    },
    Error,
    number
  >({
    mutationFn: async (documentId: number) => {
      return (await apiRequest(
        `/api/meetings/intelligence/documents/${documentId}/reprocess`,
        { method: "POST" },
      )) as any;
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/meetings/intelligence/documents"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/meetings/intelligence/batches"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/meetings/intelligence/batches/detail"],
      });
      setShouldPollBatches(true);
      if (r.requeued) {
        toast({
          title: "Re-extract queued",
          description: `Document #${r.documentId} will be re-processed shortly with the current extraction prompt (citations enabled).`,
        });
      } else if (r.alreadyQueued) {
        toast({
          title: "Already re-extracting",
          description: `Document #${r.documentId} is currently ${r.status ?? "queued"} from an earlier click. The worker will finish it within a few seconds.`,
        });
      } else {
        toast({
          title: "Nothing to re-extract",
          description:
            "The document is no longer in a re-processable state. Refresh and try again.",
        });
      }
    },
    onError: (err) => {
      toast({
        title: "Re-extract failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Block the button when the active doc is anything other than
  // completed/failed — the endpoint will just no-op anyway, but disabling
  // up front avoids the user clicking 5 times and stacking toasts.
  const activeDocReprocessable =
    !!activeResult &&
    (activeResult.status === "completed" || activeResult.status === "failed");

  /** True when the active document was processed before evidence_quotes
   *  was added. Drives the "missing citations" banner + a CTA. */
  const activeMissesCitations = (() => {
    const j = activeResult?.documentJson;
    if (!j) return false;
    if (activeResult?.status !== "completed") return false;
    const eq = j.evidence_quotes;
    const actions: any[] = Array.isArray(j.action_items) ? j.action_items : [];
    const anyParallel =
      eq &&
      typeof eq === "object" &&
      ((eq.discussion_points?.some?.((q: string) => q && q.trim())) ||
        (eq.decisions_taken?.some?.((q: string) => q && q.trim())) ||
        (eq.risks?.some?.((q: string) => q && q.trim())) ||
        (eq.pending_clarifications?.some?.((q: string) => q && q.trim())) ||
        (eq.next_steps?.some?.((q: string) => q && q.trim())));
    const anyActionQuote = actions.some(
      (a) => a && typeof a.source_quote === "string" && a.source_quote.trim(),
    );
    return !(anyParallel || anyActionQuote);
  })();

  // Retry all failed docs in a batch. Used after fixing an env-level
  // problem (e.g. setting a real OpenAI key) so the user doesn't have to
  // re-upload the files.
  const retryMutation = useMutation<{ requeued: number }, Error, number>({
    mutationFn: async (batchId: number) => {
      return (await apiRequest(
        `/api/meetings/intelligence/batches/${batchId}/retry`,
        { method: "POST" },
      )) as { requeued: number };
    },
    onSuccess: (r, batchId) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/meetings/intelligence/batches"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/meetings/intelligence/documents"],
      });
      setShouldPollBatches(true);
      toast({
        title: r.requeued === 0 ? "Nothing to retry" : "Retry queued",
        description:
          r.requeued === 0
            ? "All documents in this batch are at the retry cap or already complete."
            : `Re-queued ${r.requeued} failed document${r.requeued === 1 ? "" : "s"} in batch #${batchId}.`,
      });
    },
    onError: (err) => {
      toast({
        title: "Retry failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const processMutation = useMutation<IntelligenceDocument, Error, void>({
    mutationFn: async () => {
      const trimmed = transcriptText.trim();
      if (trimmed.length < 20) {
        throw new Error("Transcript is too short. Paste at least a few sentences.");
      }
      const result = (await apiRequest(
        "/api/meetings/intelligence/process",
        {
          method: "POST",
          body: JSON.stringify({
            transcript_text: trimmed,
            project_name: projectName.trim() || null,
            department: department.trim() || null,
            meeting_source: meetingSource,
            meeting_date: meetingDate,
            participants: participants
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean),
          }),
        },
      )) as IntelligenceDocument;
      return result;
    },
    onSuccess: (doc) => {
      setActiveResult(doc);
      queryClient.invalidateQueries({
        queryKey: ["/api/meetings/intelligence/documents"],
      });
      toast({
        title: "Transcript processed",
        description: `Generated MOM "${doc.meetingTitle ?? doc.transcriptId}".`,
      });
    },
    onError: (err) => {
      toast({
        title: "Processing failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // ── Bulk: build payload + submit ────────────────────────────────────
  /**
   * Build the array of transcripts the API expects from one or more user
   * input shapes:
   *   - JSON array pasted into the textarea
   *   - JSONL (one transcript object per line)
   *   - Files attached via the multi-file input (each becomes a transcript)
   */
  const buildBulkPayload = (): Array<Record<string, any>> => {
    const fromFiles = bulkFiles.map((f) => ({
      transcript_text: f.text,
      // Per-file source — auto-detected on attach, user-editable in the
      // file list. Falls back to the batch default if unset.
      meeting_source: f.source || bulkDefaultSource,
      // Use filename minus extension as a transcript_id hint for traceability.
      transcript_id: f.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 80),
    }));

    if (!bulkRaw.trim()) return fromFiles;

    // Try strict JSON array first.
    try {
      const parsed = JSON.parse(bulkRaw);
      if (Array.isArray(parsed)) return [...fromFiles, ...parsed];
      if (parsed && typeof parsed === "object" && "transcripts" in parsed) {
        return [...fromFiles, ...(parsed as any).transcripts];
      }
    } catch {
      // Fall through to JSONL.
    }
    // JSONL: parse each line as JSON, ignore blanks/comments.
    const lines = bulkRaw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("#"));
    const fromJsonl: any[] = [];
    for (const line of lines) {
      try {
        fromJsonl.push(JSON.parse(line));
      } catch {
        /* skip malformed lines */
      }
    }
    return [...fromFiles, ...fromJsonl];
  };

  const bulkMutation = useMutation<EnqueueResult, Error, void>({
    mutationFn: async () => {
      const transcripts = buildBulkPayload();
      if (transcripts.length === 0) {
        throw new Error(
          "No transcripts found. Paste a JSON array, JSONL, or attach files.",
        );
      }
      return (await apiRequest("/api/meetings/intelligence/batches", {
        method: "POST",
        body: JSON.stringify({
          label: bulkLabel.trim() || undefined,
          defaultMeetingSource: bulkDefaultSource,
          transcripts,
        }),
      })) as EnqueueResult;
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/meetings/intelligence/batches"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/meetings/intelligence/documents"],
      });
      setBulkRaw("");
      setBulkFiles([]);
      setBulkLabel("");
      setShouldPollBatches(true);
      toast({
        title: "Batch enqueued",
        description: `Queued ${r.enqueued} transcript${r.enqueued === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} skipped)` : ""}. Worker is draining the queue in the background.`,
      });
    },
    onError: (err) => {
      toast({
        title: "Bulk enqueue failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  /**
   * Accepts either a FileList (from the legacy <input type="file"> handler)
   * or a File[] (what react-dropzone delivers). Normalises both, filters by
   * extension/MIME, reads text, runs source detection per file, and appends
   * to the staged list.
   */
  const handleBulkFilesPicked = async (
    files: FileList | File[] | null | undefined,
  ) => {
    if (!files) return;
    const arr = Array.isArray(files) ? files : Array.from(files);
    if (arr.length === 0) return;
    const accepted: Array<{ name: string; text: string; source: string }> = [];
    const rejected: string[] = [];
    const MAX_PER_FILE = 200_000; // 200 KB chars/file — server auto-chunks past this anyway
    for (const f of arr) {
      const okExt = /\.(txt|md|vtt|srt|json|jsonl)$/i.test(f.name);
      const okMime = (f.type || "").startsWith("text/");
      if (!okExt && !okMime) {
        rejected.push(f.name);
        continue;
      }
      const text = await f.text();
      const trimmed = text.slice(0, MAX_PER_FILE);
      const source = detectSource(f.name, trimmed, bulkDefaultSource);
      accepted.push({ name: f.name, text: trimmed, source });
    }
    if (accepted.length) {
      setBulkFiles((prev) => [...prev, ...accepted]);
      const total = bulkFiles.length + accepted.length;
      const distinct = new Set(
        [...bulkFiles, ...accepted].map((f) => f.source),
      ).size;
      toast({
        title: `Loaded ${accepted.length} file${accepted.length === 1 ? "" : "s"}`,
        description: `Total queued: ${total}. Sources detected: ${distinct}. Override any below.`,
      });
    }
    if (rejected.length) {
      toast({
        title: `Skipped ${rejected.length} unsupported file${rejected.length === 1 ? "" : "s"}`,
        description: rejected.slice(0, 5).join(", ") +
          (rejected.length > 5 ? `, +${rejected.length - 5} more` : ""),
        variant: "destructive",
      });
    }
  };

  // Stable callback for react-dropzone (avoid recreating on every render so
  // dropzone doesn't re-wire its handlers each pass).
  const onDrop = useCallback(
    (files: File[]) => {
      handleBulkFilesPicked(files);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bulkDefaultSource, bulkFiles.length],
  );

  const {
    getRootProps: getBulkRootProps,
    getInputProps: getBulkInputProps,
    isDragActive: isBulkDragActive,
    open: openBulkPicker,
  } = useDropzone({
    onDrop,
    multiple: true,
    noClick: true, // open via the button — keeps the drop surface from triggering on accidental clicks
    noKeyboard: false,
    accept: {
      "text/plain": [".txt", ".md", ".vtt", ".srt"],
      "application/json": [".json", ".jsonl"],
    },
  });

  /** Update a single staged file's source (the per-row dropdown). */
  const setBulkFileSource = (index: number, source: string) => {
    setBulkFiles((prev) =>
      prev.map((f, i) => (i === index ? { ...f, source } : f)),
    );
  };

  /** Remove a single staged file before submission. */
  const removeBulkFile = (index: number) => {
    setBulkFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleFileUpload = async (file: File) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Use files smaller than 5 MB for inline transcript paste.",
        variant: "destructive",
      });
      return;
    }
    // For MVP, support text-based files inline. Audio/video/PDF go through
    // the upload-and-transcribe path (out of scope here; see the
    // file-processor service for that flow).
    if (
      !/\.(txt|md|vtt|srt)$/i.test(file.name) &&
      !file.type.startsWith("text/")
    ) {
      toast({
        title: "Unsupported file type for inline paste",
        description:
          "Use .txt / .md / .vtt / .srt here. PDF/DOCX/audio uploads are handled by the bulk processor (coming soon).",
        variant: "destructive",
      });
      return;
    }
    const text = await file.text();
    setTranscriptText(text);
    toast({
      title: "Transcript loaded",
      description: `Loaded ${file.name} (${text.length.toLocaleString()} chars). Click Process to run the analyzer.`,
    });
  };

  const handleCopyJson = async () => {
    if (!activeResult) return;
    await navigator.clipboard.writeText(
      JSON.stringify(activeResult.documentJson, null, 2),
    );
    toast({ title: "JSON copied to clipboard" });
  };

  const handleCopyMarkdown = async () => {
    if (!activeResult) return;
    await navigator.clipboard.writeText(activeResult.documentMarkdown);
    toast({ title: "MOM copied to clipboard" });
  };

  const handleDownload = (kind: "json" | "md") => {
    if (!activeResult) return;
    const blob =
      kind === "json"
        ? new Blob([JSON.stringify(activeResult.documentJson, null, 2)], {
            type: "application/json",
          })
        : new Blob([activeResult.documentMarkdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeResult.transcriptId}.${kind === "json" ? "json" : "md"}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mt-4 grid gap-4 xl:grid-cols-2">
      {/* ── Input panel ──────────────────────────────────────────── */}
      <Card data-testid="card-intelligence-input">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Brain className="h-4 w-4 text-emerald-600" />
            AI Meeting Intelligence
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Paste a transcript or upload a text file. The processor cleans it,
            detects business context, extracts decisions / actions / risks, and
            returns a structured MOM in JSON + Markdown.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Metadata grid — single column on mobile, 2 cols at sm+, 4 at md+
              so labels never get clipped. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label htmlFor="mi-project" className="text-xs">
                Project
              </Label>
              <Input
                id="mi-project"
                placeholder="e.g. Jaiban ERP"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                className="h-9 text-sm"
                data-testid="input-project-name"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="mi-dept" className="text-xs">
                Department
              </Label>
              <Input
                id="mi-dept"
                placeholder="e.g. Production"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className="h-9 text-sm"
                data-testid="input-department"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="mi-source" className="text-xs">
                Source
              </Label>
              <select
                id="mi-source"
                value={meetingSource}
                onChange={(e) => setMeetingSource(e.target.value)}
                // min-w-0 so the dropdown shrinks with its container instead of
                // forcing the parent grid to overflow; truncate cuts long
                // labels with an ellipsis rather than chopping mid-letter.
                className="h-9 w-full min-w-0 truncate rounded-md border border-input bg-background px-2 text-sm"
                data-testid="select-source"
              >
                {MEETING_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="mi-date" className="text-xs">
                Date
              </Label>
              <Input
                id="mi-date"
                type="date"
                value={meetingDate}
                onChange={(e) => setMeetingDate(e.target.value)}
                className="h-9 text-sm"
                data-testid="input-meeting-date"
              />
            </div>
            <div className="space-y-1 sm:col-span-2 md:col-span-4">
              <Label htmlFor="mi-participants" className="text-xs">
                Participants (comma-separated)
              </Label>
              <Input
                id="mi-participants"
                placeholder="Naveen, Snehal, Amit"
                value={participants}
                onChange={(e) => setParticipants(e.target.value)}
                className="h-9 text-sm"
                data-testid="input-participants"
              />
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Transcript</Label>
              <label className="cursor-pointer text-xs text-emerald-600 hover:underline inline-flex items-center gap-1">
                <Upload className="h-3 w-3" />
                Upload .txt / .md / .vtt / .srt
                <input
                  type="file"
                  accept=".txt,.md,.vtt,.srt,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFileUpload(f);
                    e.currentTarget.value = "";
                  }}
                  data-testid="input-transcript-file"
                />
              </label>
            </div>
            <Textarea
              placeholder="Paste the raw transcript here. Multi-speaker, timestamps, filler words — all fine; the processor normalises."
              value={transcriptText}
              onChange={(e) => setTranscriptText(e.target.value)}
              rows={14}
              className="text-sm font-mono leading-relaxed"
              data-testid="textarea-transcript"
            />
            <p className="text-xs text-muted-foreground">
              {transcriptText.length.toLocaleString()} characters
              {transcriptText.length > 50000 && (
                <span className="text-amber-600 ml-2">
                  ⚠ Large transcripts auto-chunk on the server.
                </span>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={() => processMutation.mutate()}
              disabled={
                processMutation.isPending || transcriptText.trim().length < 20
              }
              className="flex-1"
              data-testid="button-process"
            >
              {processMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Processing…
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Process transcript
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setTranscriptText("");
                setActiveResult(null);
              }}
              disabled={processMutation.isPending}
              data-testid="button-clear"
            >
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Output panel ─────────────────────────────────────────── */}
      <Card data-testid="card-intelligence-output" ref={outputCardRef as any}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-emerald-600" />
              Generated MOM
            </span>
            {activeResult && (
              <div className="flex items-center gap-1.5">
                <Badge
                  variant={
                    activeResult.status === "completed"
                      ? "default"
                      : activeResult.status === "failed"
                        ? "destructive"
                        : "secondary"
                  }
                  className="text-xs"
                >
                  {activeResult.status === "completed" ? (
                    <CheckCircle className="h-3 w-3 mr-1" />
                  ) : (
                    <AlertCircle className="h-3 w-3 mr-1" />
                  )}
                  {activeResult.status}
                </Badge>
                {typeof activeResult.confidenceScore === "number" && (
                  <Badge variant="outline" className="text-xs">
                    conf {activeResult.confidenceScore.toFixed(2)}
                  </Badge>
                )}
              </div>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {activeBatchSummaryId !== null ? (
            /* Aggregated batch MOM. Mutually exclusive with single-doc view. */
            <div data-testid="batch-summary-container">
              <div className="flex items-center justify-between mb-2 gap-2">
                <Badge variant="outline" className="text-xs">
                  Batch aggregated view
                </Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => setActiveBatchSummaryId(null)}
                  data-testid="button-close-batch-summary"
                >
                  Close
                </Button>
              </div>
              {batchSummaryFetching && !batchSummaryData ? (
                <div className="text-center py-12 text-sm text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
                  Aggregating transcripts…
                </div>
              ) : batchSummaryData ? (
                <BatchSummaryView
                  data={batchSummaryData}
                  onOpenSource={openSourceFromSummary}
                />
              ) : (
                <div className="text-sm text-muted-foreground italic p-3">
                  Could not load batch summary.
                </div>
              )}
            </div>
          ) : !activeResult ? (
            <div className="text-center py-12 text-sm text-muted-foreground">
              <Brain className="h-10 w-10 mx-auto mb-2 opacity-30" />
              Run a transcript through the processor to see the structured JSON
              and Minutes of Meeting here.
            </div>
          ) : (
            <>
              {/* When the active doc was processed before evidence_quotes
                  was added, the EVIDENCE blocks have nothing to render —
                  surface this clearly with a one-click re-extract. */}
              {activeMissesCitations && (
                <div
                  className="mb-3 p-3 rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 flex items-start gap-3"
                  data-testid="banner-missing-citations"
                >
                  <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      No evidence citations in this MOM
                    </div>
                    <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
                      This document was extracted before the EVIDENCE feature
                      was added. Re-extract to backfill verbatim source
                      quotes — the raw transcript is already stored, no
                      re-upload required.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => reprocessMutation.mutate(activeResult.id)}
                    // Disable when the doc is queued/processing (work is
                    // already in flight) OR while our mutation is round-
                    // tripping. Avoids stacking duplicate re-extract calls
                    // that the server would just no-op anyway.
                    disabled={
                      reprocessMutation.isPending || !activeDocReprocessable
                    }
                    className="shrink-0"
                    data-testid="button-reextract"
                    title={
                      activeDocReprocessable
                        ? "Re-run extraction with the current prompt"
                        : "Document is already being re-processed"
                    }
                  >
                    {reprocessMutation.isPending ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                        Queuing…
                      </>
                    ) : !activeDocReprocessable ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                        Re-extracting…
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-3.5 w-3.5 mr-1" />
                        Re-extract with citations
                      </>
                    )}
                  </Button>
                </div>
              )}
            <Tabs
              value={outputTab}
              onValueChange={(v) => setOutputTab(v as any)}
              className="w-full"
            >
              <TabsList className="grid grid-cols-3 h-9">
                <TabsTrigger value="mom" className="text-xs">
                  Minutes of Meeting
                </TabsTrigger>
                <TabsTrigger value="json" className="text-xs">
                  Structured JSON
                </TabsTrigger>
                <TabsTrigger
                  value="transcript"
                  className="text-xs"
                  data-testid="tab-source-transcript"
                >
                  Raw Transcript
                </TabsTrigger>
              </TabsList>
              <TabsContent value="mom" className="mt-2 space-y-3">
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleCopyMarkdown}
                    data-testid="button-copy-md"
                    disabled={!activeResult.documentMarkdown}
                  >
                    <Copy className="h-3 w-3 mr-1" /> Copy Markdown
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleDownload("md")}
                    data-testid="button-download-md"
                    disabled={!activeResult.documentMarkdown}
                  >
                    <Download className="h-3 w-3 mr-1" /> .md
                  </Button>
                </div>
                {/* Rich, interactive MOM. Each extracted item shows its
                    source quote when present; clicking the quote routes
                    to the Source Transcript tab and highlights the line. */}
                {activeResult.documentJson ? (
                  <IntelligenceDocumentView
                    doc={activeResult.documentJson}
                    transcriptText={activeResult.transcriptText}
                    onJumpToTranscript={handleJumpToTranscript}
                  />
                ) : (
                  <div className="text-xs text-muted-foreground p-3 rounded border bg-card">
                    No structured extraction is attached to this document.
                  </div>
                )}
              </TabsContent>
              <TabsContent value="json" className="mt-2">
                <div className="flex items-center gap-2 mb-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleCopyJson}
                    data-testid="button-copy-json"
                  >
                    <Copy className="h-3 w-3 mr-1" /> Copy
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleDownload("json")}
                    data-testid="button-download-json"
                  >
                    <Download className="h-3 w-3 mr-1" /> .json
                  </Button>
                </div>
                {activeResult.documentJson ? (
                  <pre
                    className="text-xs font-mono bg-card text-foreground p-3 rounded border max-h-[480px] overflow-auto"
                    data-testid="output-json"
                  >
                    {(() => {
                      try {
                        return JSON.stringify(activeResult.documentJson, null, 2);
                      } catch {
                        // Defensive: cyclic / non-serialisable payloads
                        // shouldn't crash the page.
                        return "(Unable to render JSON — value contains cyclic or non-serialisable data.)";
                      }
                    })()}
                  </pre>
                ) : (
                  <div className="text-xs text-muted-foreground p-3 rounded border bg-card">
                    No structured extraction is attached to this document.
                  </div>
                )}
              </TabsContent>
              <TabsContent value="transcript" className="mt-2 space-y-2">
                {jumpQuote && (
                  <div className="text-xs text-muted-foreground flex items-center justify-between gap-2 bg-muted/40 p-2 rounded">
                    <span className="truncate">
                      Jumping to: <span className="italic">"{jumpQuote.slice(0, 120)}{jumpQuote.length > 120 ? "…" : ""}"</span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs shrink-0"
                      onClick={() => setJumpQuote(null)}
                      data-testid="button-clear-jump"
                    >
                      Clear highlight
                    </Button>
                  </div>
                )}
                <SourceTranscriptPane
                  transcriptText={activeResult.transcriptText || ""}
                  jumpToQuote={jumpQuote}
                />
              </TabsContent>
            </Tabs>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Bulk processing panel ────────────────────────────────── */}
      <Card className="lg:col-span-2" data-testid="card-intelligence-bulk">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Layers className="h-4 w-4 text-emerald-600" />
            Bulk processing
            <Badge variant="outline" className="text-xs ml-2">
              up to 2,500 / batch
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Submit many transcripts at once — Zoom, Teams, Meet, Slack and
            others can be mixed in the same batch. The server enqueues them
            and a background worker drains the queue with a concurrency cap
            so OpenAI rate limits are respected. Watch progress below.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="mi-bulk-label" className="text-xs">
                Batch label (optional)
              </Label>
              <Input
                id="mi-bulk-label"
                placeholder="e.g. Q3 board reviews export"
                value={bulkLabel}
                onChange={(e) => setBulkLabel(e.target.value)}
                className="h-9 text-sm"
                data-testid="input-bulk-label"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="mi-bulk-source" className="text-xs">
                Default source
                <span className="ml-1 text-muted-foreground font-normal">
                  (per-file override below)
                </span>
              </Label>
              <select
                id="mi-bulk-source"
                value={bulkDefaultSource}
                onChange={(e) => setBulkDefaultSource(e.target.value)}
                className="h-9 w-full min-w-0 truncate rounded-md border border-input bg-background px-2 text-sm"
                data-testid="select-bulk-source"
              >
                {MEETING_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">JSON array / JSONL</Label>
                <span className="text-xs text-muted-foreground">
                  one transcript per line, or a single JSON array
                </span>
              </div>
              <Textarea
                placeholder={`[\n  { "transcript_text": "...", "project_name": "Jaiban ERP", "participants": ["Naveen", "Snehal"] },\n  { "transcript_text": "..." }\n]`}
                value={bulkRaw}
                onChange={(e) => setBulkRaw(e.target.value)}
                rows={8}
                className="text-xs font-mono"
                data-testid="textarea-bulk-raw"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                Or attach files (.txt / .md / .vtt / .srt / .json / .jsonl)
              </Label>
              {/* Drag-and-drop zone. Hidden <input multiple> is rendered by
                  react-dropzone via getInputProps(); clicking the button
                  opens the OS file picker with multi-select enabled.
                  Dragging a folder selection from the OS also works. */}
              <div
                {...getBulkRootProps({
                  className: `border-2 border-dashed rounded-md p-4 transition-colors ${
                    isBulkDragActive
                      ? "border-emerald-500 bg-emerald-50"
                      : "border-input bg-background hover:border-emerald-300"
                  }`,
                })}
                data-testid="dropzone-bulk-files"
              >
                <input
                  {...getBulkInputProps({ "data-testid": "input-bulk-files" } as any)}
                />
                <div className="text-center">
                  <Upload
                    className={`h-6 w-6 mx-auto mb-2 ${
                      isBulkDragActive ? "text-emerald-600" : "text-muted-foreground"
                    }`}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    onClick={openBulkPicker}
                    data-testid="button-open-bulk-picker"
                  >
                    <Upload className="h-3.5 w-3.5 mr-1" />
                    Select files
                  </Button>
                  <p className="text-xs text-muted-foreground mt-2">
                    {isBulkDragActive ? (
                      <span className="text-emerald-700 font-medium">
                        Drop to add files
                      </span>
                    ) : (
                      <>
                        Drag &amp; drop here, or click the button. Hold{" "}
                        <kbd className="px-1 py-0.5 border rounded text-[10px] bg-muted">
                          Ctrl
                        </kbd>{" "}
                        /{" "}
                        <kbd className="px-1 py-0.5 border rounded text-[10px] bg-muted">
                          ⌘
                        </kbd>{" "}
                        in the picker to select multiple files at once.
                      </>
                    )}
                  </p>
                  {bulkFiles.length === 0 && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Each file becomes one transcript with its own source.
                      Filenames give a starting guess (e.g.{" "}
                      <code className="text-xs">zoom-q3-review.txt</code> →
                      Zoom). Override per file below.
                    </p>
                  )}
                </div>

                {bulkFiles.length > 0 && (
                  <>
                    {/* Source-mix summary so the user can see at a glance how
                        many of each platform they've staged. */}
                    <div className="mt-3 mb-2 flex flex-wrap items-center gap-1">
                      <span className="text-xs text-muted-foreground mr-1">
                        Mix:
                      </span>
                      {Object.entries(
                        bulkFiles.reduce<Record<string, number>>((acc, f) => {
                          acc[f.source] = (acc[f.source] ?? 0) + 1;
                          return acc;
                        }, {}),
                      ).map(([src, count]) => (
                        <Badge
                          key={src}
                          variant="outline"
                          className="text-xs"
                          data-testid={`badge-source-${src}`}
                        >
                          {src} · {count}
                        </Badge>
                      ))}
                    </div>

                    {/* Per-file rows: name + size + source dropdown + remove */}
                    <div className="max-h-60 overflow-auto divide-y border rounded">
                      {bulkFiles.map((f, i) => (
                        <div
                          key={`${f.name}-${i}`}
                          className="flex items-center gap-2 px-2 py-1.5 text-xs"
                          data-testid={`row-bulk-file-${i}`}
                        >
                          <span className="truncate flex-1 min-w-0" title={f.name}>
                            {f.name}
                          </span>
                          <span className="text-muted-foreground shrink-0 tabular-nums">
                            {f.text.length.toLocaleString()} ch
                          </span>
                          <select
                            value={f.source}
                            onChange={(e) =>
                              setBulkFileSource(i, e.target.value)
                            }
                            className="h-7 rounded border border-input bg-background px-1 text-xs min-w-[7.5rem]"
                            data-testid={`select-bulk-file-source-${i}`}
                          >
                            {MEETING_SOURCES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => removeBulkFile(i)}
                            className="text-muted-foreground hover:text-destructive shrink-0"
                            data-testid={`button-remove-bulk-file-${i}`}
                            aria-label={`Remove ${f.name}`}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={() => bulkMutation.mutate()}
              disabled={
                bulkMutation.isPending ||
                (!bulkRaw.trim() && bulkFiles.length === 0)
              }
              data-testid="button-bulk-submit"
            >
              {bulkMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Enqueuing…
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4 mr-2" />
                  Enqueue batch
                </>
              )}
            </Button>
            {(bulkRaw.trim() || bulkFiles.length > 0) && (
              <Button
                variant="outline"
                onClick={() => {
                  setBulkRaw("");
                  setBulkFiles([]);
                }}
                disabled={bulkMutation.isPending}
                data-testid="button-bulk-clear"
              >
                Clear
              </Button>
            )}
          </div>

          {batches.length > 0 && (
            <div className="pt-2 border-t space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Recent batches</span>
                {shouldPollBatches && (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> polling
                  </span>
                )}
              </div>
              {batches.slice(0, 8).map((b) => {
                const pct =
                  b.totalCount > 0
                    ? Math.round(
                        ((b.completedCount + b.failedCount) / b.totalCount) *
                          100,
                      )
                    : 0;
                const isExpanded = expandedBatchId === b.id;
                const hasFailures = b.failedCount > 0;
                const toggle = () =>
                  setExpandedBatchId(isExpanded ? null : b.id);
                return (
                  <div
                    key={b.id}
                    className="border rounded"
                    data-testid={`row-batch-${b.id}`}
                  >
                    {/* Whole header row is a button now so clicking anywhere
                        (not just the chevron) toggles expansion. The action
                        buttons inside use e.stopPropagation() so they don't
                        bubble up to this handler. */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={toggle}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggle();
                        }
                      }}
                      className="p-2 cursor-pointer hover:bg-muted/40 transition-colors"
                      data-testid={`button-toggle-batch-${b.id}`}
                      aria-label={
                        isExpanded ? "Collapse batch" : "Expand batch"
                      }
                      aria-expanded={isExpanded}
                    >
                      <div className="flex items-center gap-2 text-sm">
                        <span className="shrink-0 text-muted-foreground">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">
                            {b.label || `Batch #${b.id}`}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {b.completedCount} done · {b.failedCount} failed ·{" "}
                            {b.totalCount - b.completedCount - b.failedCount}{" "}
                            pending · total {b.totalCount}
                          </div>
                        </div>
                        {b.completedCount > 0 && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs shrink-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              viewBatchSummary(b.id);
                            }}
                            data-testid={`button-summary-batch-${b.id}`}
                            title="Open an aggregated MOM rolling up every completed transcript in this batch"
                          >
                            <Layers className="h-3 w-3 mr-1" />
                            Summary
                          </Button>
                        )}
                        {hasFailures && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs shrink-0"
                            disabled={retryMutation.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              retryMutation.mutate(b.id);
                            }}
                            data-testid={`button-retry-batch-${b.id}`}
                          >
                            {retryMutation.isPending &&
                            retryMutation.variables === b.id ? (
                              <Loader2 className="h-3 w-3 animate-spin mr-1" />
                            ) : (
                              <RotateCw className="h-3 w-3 mr-1" />
                            )}
                            Retry failed
                          </Button>
                        )}
                        <Badge
                          variant={
                            b.status === "completed"
                              ? "default"
                              : b.status === "failed"
                                ? "destructive"
                                : "secondary"
                          }
                          className="text-xs shrink-0"
                        >
                          {b.status}
                        </Badge>
                      </div>
                      <Progress value={pct} className="h-1.5 mt-1.5" />
                    </div>

                    {/* Expanded: per-document detail with error messages so
                        the user can see WHY rows failed (most common case:
                        missing OPENAI_API_KEY → 401 from OpenAI).
                        All accesses use optional chaining so a malformed
                        payload renders an empty state instead of crashing
                        the page. */}
                    {isExpanded && (
                      <div className="border-t bg-muted/40 dark:bg-muted/20 p-2 space-y-1.5">
                        {!expandedBatchDetail ||
                        expandedBatchDetail.batch?.id !== b.id ? (
                          <div className="text-xs text-muted-foreground text-center py-2">
                            <Loader2 className="h-3 w-3 animate-spin inline mr-1" />
                            Loading documents…
                          </div>
                        ) : !expandedBatchDetail.documents ||
                          expandedBatchDetail.documents.length === 0 ? (
                          <div className="text-xs text-muted-foreground text-center py-2">
                            No documents in this batch yet. If the batch was
                            just enqueued, give the worker a moment to claim
                            the rows.
                          </div>
                        ) : (
                          expandedBatchDetail.documents.map((doc) => {
                            const isCompleted = doc.status === "completed";
                            // Body markup is shared between clickable and
                            // non-clickable rows. Two explicit JSX branches
                            // (rather than a dynamic element type) so React
                            // never has to reconcile a button↔div swap.
                            const body = (
                              <>
                                <div className="flex items-center justify-between gap-2">
                                  <div className="min-w-0 flex-1 font-mono truncate">
                                    {doc.transcriptId}
                                  </div>
                                  <Badge
                                    variant={
                                      doc.status === "completed"
                                        ? "default"
                                        : doc.status === "failed"
                                          ? "destructive"
                                          : "secondary"
                                    }
                                    className="text-xs shrink-0"
                                  >
                                    {doc.status}
                                  </Badge>
                                </div>
                                {doc.errorMessage && (
                                  <div className="mt-1 text-destructive break-words">
                                    <AlertCircle className="h-3 w-3 inline mr-1 -mt-0.5" />
                                    {doc.errorMessage}
                                  </div>
                                )}
                                {isCompleted && (
                                  <div className="mt-1 text-muted-foreground truncate">
                                    {doc.meetingTitle || "Click to view MOM"}
                                    <span className="text-emerald-600 ml-1">
                                      → View
                                    </span>
                                  </div>
                                )}
                              </>
                            );
                            return isCompleted ? (
                              <button
                                key={doc.id}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  selectDocument(doc);
                                }}
                                className="w-full text-left text-xs border rounded p-2 bg-background hover:bg-muted/40 hover:border-emerald-300 transition-colors cursor-pointer"
                                data-testid={`row-batch-doc-${doc.id}`}
                                title="View MOM + JSON"
                              >
                                {body}
                              </button>
                            ) : (
                              <div
                                key={doc.id}
                                className="text-xs border rounded p-2 bg-background"
                                data-testid={`row-batch-doc-${doc.id}`}
                              >
                                {body}
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── History panel ────────────────────────────────────────── */}
      <Card className="lg:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-emerald-600" />
            Recent processed transcripts
            <Badge variant="outline" className="text-xs ml-2">
              {documents.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingHistory ? (
            <div className="text-center py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
              Loading…
            </div>
          ) : documents.length === 0 ? (
            <div className="text-center py-6 text-sm text-muted-foreground">
              No transcripts processed yet.
            </div>
          ) : (
            <div className="space-y-1.5">
              {documents.slice(0, 20).map((doc) => (
                <button
                  key={doc.id}
                  onClick={() => selectDocument(doc)}
                  className="w-full text-left px-3 py-2 rounded border hover:bg-muted/40 hover:border-emerald-300 transition-colors"
                  data-testid={`row-document-${doc.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">
                        {doc.meetingTitle ?? doc.transcriptId}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {[doc.projectName, doc.department, doc.meetingSource]
                          .filter(Boolean)
                          .join(" · ")}{" "}
                        {doc.meetingDate && `· ${doc.meetingDate}`}
                      </div>
                    </div>
                    <Badge
                      variant={
                        doc.status === "completed" ? "outline" : "destructive"
                      }
                      className="text-xs shrink-0"
                    >
                      {doc.status}
                    </Badge>
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
