/**
 * IntelligenceDocumentView — rich structured render of a single processed
 * transcript document.
 *
 * Replaces the previous raw-Markdown `<pre>` block with a fully
 * interactive view in which every extracted item carries its source
 * quote from the transcript. Clicking the source link auto-switches to
 * the "Source Transcript" tab and scrolls the matching line into view,
 * with a highlight pulse so the user can see exactly where the
 * extraction came from.
 *
 * Backward compatible: documents without `evidence_quotes` (older docs,
 * or models that didn't comply) render with the items only — no broken
 * links, no empty source rows.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  FileText,
  Quote,
  ListChecks,
  AlertTriangle,
  HelpCircle,
  ArrowRight,
  Users,
  Calendar,
  CheckCircle2,
  Lightbulb,
  ScrollText,
  ExternalLink,
} from "lucide-react";

interface ActionItem {
  task: string;
  owner: string;
  deadline: string;
  status: string;
  source_quote?: string;
}

interface ExtractedDocument {
  meeting_title?: string;
  project_name?: string;
  meeting_type?: string;
  meeting_date?: string;
  participants?: string[];
  executive_summary?: string;
  discussion_points?: string[];
  decisions_taken?: string[];
  action_items?: ActionItem[];
  risks?: string[];
  pending_clarifications?: string[];
  next_steps?: string[];
  evidence_quotes?: {
    discussion_points?: string[];
    decisions_taken?: string[];
    risks?: string[];
    pending_clarifications?: string[];
    next_steps?: string[];
  };
  confidence_score?: number;
}

interface Props {
  doc: ExtractedDocument;
  transcriptText?: string;
  /**
   * When the user clicks an evidence link the parent tab-controller
   * (`MeetingIntelligenceTab`) flips the visible tab to "transcript"
   * and lets us position the scroll. We expose this via a callback so
   * the parent stays in control of the tab state.
   */
  onJumpToTranscript?: (quote: string) => void;
}

/**
 * A single item row with an optional source-quote citation underneath.
 *
 * The citation is rendered as a labelled "EVIDENCE" block (similar to
 * the Build-mode FeatureCandidateCard pattern) so the user knows the
 * italic text is the verbatim source. The "View in raw transcript →"
 * affordance is always visible — not hover-only — because hover hints
 * are easy to miss and we want users to know the link exists.
 */
function ItemRow({
  text,
  quote,
  onJump,
  iconColor,
  testIdPrefix,
  index,
}: {
  text: string;
  quote?: string;
  onJump?: (quote: string) => void;
  iconColor: string;
  testIdPrefix: string;
  index: number;
}) {
  const hasQuote = !!quote && quote.trim().length > 0;
  return (
    <li
      className="flex items-start gap-2 text-sm"
      data-testid={`${testIdPrefix}-${index}`}
    >
      <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${iconColor}`} />
      <div className="min-w-0 flex-1">
        <div>{text}</div>
        {hasQuote && (
          <div
            className="mt-1.5 pl-2 border-l-2 border-emerald-400 dark:border-emerald-700"
            data-testid={`${testIdPrefix}-${index}-evidence`}
          >
            <div className="text-[10px] font-semibold tracking-widest text-emerald-700 dark:text-emerald-400 uppercase">
              Evidence
            </div>
            <div className="text-xs italic text-emerald-900 dark:text-emerald-200 mt-0.5">
              <Quote className="h-3 w-3 inline mr-1 -mt-0.5 text-emerald-600" />
              "{quote!.length > 240 ? quote!.slice(0, 240) + "…" : quote}"
            </div>
            <button
              type="button"
              onClick={() => onJump?.(quote!)}
              className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-400 hover:underline inline-flex items-center gap-1"
              data-testid={`${testIdPrefix}-${index}-source`}
              title="Open the raw uploaded transcript and highlight this line"
            >
              <ExternalLink className="h-3 w-3" />
              View in raw transcript
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function Section({
  title,
  icon,
  testId,
  children,
  count,
}: {
  title: string;
  icon: React.ReactNode;
  testId: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) {
    return (
      <section className="space-y-1" data-testid={testId}>
        <div className="flex items-center gap-2 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
          {icon} {title}
        </div>
        <div className="text-xs text-muted-foreground italic">None.</div>
      </section>
    );
  }
  return (
    <section className="space-y-1" data-testid={testId}>
      <div className="flex items-center gap-2 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
        {icon} {title}
        <Badge variant="outline" className="text-[10px] ml-1">
          {count}
        </Badge>
      </div>
      <ul className="space-y-1.5 pl-1">{children}</ul>
    </section>
  );
}

export function IntelligenceDocumentView({
  doc,
  transcriptText,
  onJumpToTranscript,
}: Props) {
  if (!doc) {
    return (
      <div className="text-xs text-muted-foreground p-3 border rounded bg-card">
        No structured extraction is attached to this document.
      </div>
    );
  }

  const conf = typeof doc.confidence_score === "number" ? doc.confidence_score : null;
  const dp = doc.discussion_points ?? [];
  const dt = doc.decisions_taken ?? [];
  const rk = doc.risks ?? [];
  const pc = doc.pending_clarifications ?? [];
  const ns = doc.next_steps ?? [];
  const ai = doc.action_items ?? [];
  const eq = doc.evidence_quotes ?? {};

  // Count how many citations are present — surface this as a metric so
  // the user can see at a glance whether the model produced traceable
  // evidence or just unverified bullets.
  const citationCount = useMemo(() => {
    let n = 0;
    const countNonEmpty = (xs: string[] | undefined) =>
      (xs ?? []).filter((q) => q && q.trim()).length;
    n += countNonEmpty(eq.discussion_points);
    n += countNonEmpty(eq.decisions_taken);
    n += countNonEmpty(eq.risks);
    n += countNonEmpty(eq.pending_clarifications);
    n += countNonEmpty(eq.next_steps);
    n += ai.filter((a) => a.source_quote && a.source_quote.trim()).length;
    return n;
  }, [eq, ai]);

  return (
    <div className="space-y-4" data-testid="intelligence-doc-view">
      {/* Header strip — title, project / type / date / participants */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-base font-semibold truncate">
                {doc.meeting_title || "Untitled Meeting"}
              </h3>
              <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                {doc.project_name && (
                  <span>
                    <strong>Project:</strong> {doc.project_name}
                  </span>
                )}
                {doc.meeting_type && (
                  <span>
                    <strong>Type:</strong> {doc.meeting_type}
                  </span>
                )}
                {doc.meeting_date && (
                  <span className="inline-flex items-center gap-1">
                    <Calendar className="h-3 w-3" /> {doc.meeting_date}
                  </span>
                )}
              </div>
              {(doc.participants?.length ?? 0) > 0 && (
                <div className="text-xs text-muted-foreground mt-0.5 inline-flex items-center gap-1">
                  <Users className="h-3 w-3" /> {doc.participants!.join(", ")}
                </div>
              )}
            </div>
            <div className="shrink-0 flex flex-col items-end gap-1">
              {conf !== null && (
                <Badge variant="outline" className="text-xs">
                  Confidence {(conf * 100).toFixed(0)}%
                </Badge>
              )}
              <Badge variant="outline" className="text-xs">
                {citationCount} cited
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Executive Summary */}
      {doc.executive_summary && (
        <section data-testid="section-summary">
          <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">
            Executive summary
          </div>
          <p className="text-sm leading-relaxed">{doc.executive_summary}</p>
        </section>
      )}

      <Section
        title="Discussion points"
        icon={<ScrollText className="h-3 w-3" />}
        testId="section-discussion"
        count={dp.length}
      >
        {dp.map((t, i) => (
          <ItemRow
            key={i}
            text={t}
            quote={eq.discussion_points?.[i]}
            onJump={onJumpToTranscript}
            iconColor="bg-blue-400"
            testIdPrefix="row-discussion"
            index={i}
          />
        ))}
      </Section>

      <Section
        title="Decisions"
        icon={<CheckCircle2 className="h-3 w-3" />}
        testId="section-decisions"
        count={dt.length}
      >
        {dt.map((t, i) => (
          <ItemRow
            key={i}
            text={t}
            quote={eq.decisions_taken?.[i]}
            onJump={onJumpToTranscript}
            iconColor="bg-emerald-500"
            testIdPrefix="row-decision"
            index={i}
          />
        ))}
      </Section>

      {/* Action Items — table-style with citation row underneath each */}
      <section className="space-y-1" data-testid="section-actions">
        <div className="flex items-center gap-2 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
          <ListChecks className="h-3 w-3" /> Action items
          <Badge variant="outline" className="text-[10px] ml-1">
            {ai.length}
          </Badge>
        </div>
        {ai.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">None.</div>
        ) : (
          <div className="overflow-hidden rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs">
                <tr>
                  <th className="text-left p-2 font-medium">Task</th>
                  <th className="text-left p-2 font-medium">Owner</th>
                  <th className="text-left p-2 font-medium">Deadline</th>
                  <th className="text-left p-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {ai.map((a, i) => (
                  <FragmentRows
                    key={i}
                    a={a}
                    index={i}
                    onJump={onJumpToTranscript}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Section
        title="Risks"
        icon={<AlertTriangle className="h-3 w-3" />}
        testId="section-risks"
        count={rk.length}
      >
        {rk.map((t, i) => (
          <ItemRow
            key={i}
            text={t}
            quote={eq.risks?.[i]}
            onJump={onJumpToTranscript}
            iconColor="bg-red-500"
            testIdPrefix="row-risk"
            index={i}
          />
        ))}
      </Section>

      <Section
        title="Pending clarifications"
        icon={<HelpCircle className="h-3 w-3" />}
        testId="section-clarifications"
        count={pc.length}
      >
        {pc.map((t, i) => (
          <ItemRow
            key={i}
            text={t}
            quote={eq.pending_clarifications?.[i]}
            onJump={onJumpToTranscript}
            iconColor="bg-amber-500"
            testIdPrefix="row-clarification"
            index={i}
          />
        ))}
      </Section>

      <Section
        title="Next steps"
        icon={<ArrowRight className="h-3 w-3" />}
        testId="section-next"
        count={ns.length}
      >
        {ns.map((t, i) => (
          <ItemRow
            key={i}
            text={t}
            quote={eq.next_steps?.[i]}
            onJump={onJumpToTranscript}
            iconColor="bg-indigo-500"
            testIdPrefix="row-next"
            index={i}
          />
        ))}
      </Section>

      {citationCount === 0 && (transcriptText?.length ?? 0) > 0 && (
        <div className="text-xs text-muted-foreground border-l-2 border-amber-400 bg-amber-50/40 dark:bg-amber-950/20 pl-2 py-1.5">
          <Lightbulb className="h-3 w-3 inline mr-1 -mt-0.5" />
          No source quotes were emitted by the model for this transcript.
          Re-processing the transcript may produce citations on the next run.
        </div>
      )}
    </div>
  );
}

/** Action-item row + its citation row under it (so the table stays tidy). */
function FragmentRows({
  a,
  index,
  onJump,
}: {
  a: ActionItem;
  index: number;
  onJump?: (quote: string) => void;
}) {
  const hasQuote = !!a.source_quote && a.source_quote.trim().length > 0;
  return (
    <>
      <tr className="border-t" data-testid={`row-action-${index}`}>
        <td className="p-2">{a.task}</td>
        <td className="p-2 text-xs">{a.owner}</td>
        <td className="p-2 text-xs">{a.deadline}</td>
        <td className="p-2">
          <Badge variant="outline" className="text-[10px]">
            {a.status}
          </Badge>
        </td>
      </tr>
      {hasQuote && (
        <tr className="bg-muted/20 border-t">
          <td colSpan={4} className="p-2">
            <div
              className="pl-2 border-l-2 border-emerald-400 dark:border-emerald-700"
              data-testid={`row-action-${index}-evidence`}
            >
              <div className="text-[10px] font-semibold tracking-widest text-emerald-700 dark:text-emerald-400 uppercase">
                Evidence
              </div>
              <div className="text-xs italic text-emerald-900 dark:text-emerald-200 mt-0.5">
                <Quote className="h-3 w-3 inline mr-1 -mt-0.5 text-emerald-600" />
                "{a.source_quote!.length > 280
                  ? a.source_quote!.slice(0, 280) + "…"
                  : a.source_quote}"
              </div>
              <button
                type="button"
                onClick={() => onJump?.(a.source_quote!)}
                className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-400 hover:underline inline-flex items-center gap-1"
                data-testid={`row-action-${index}-source`}
                title="Open the raw uploaded transcript and highlight this line"
              >
                <ExternalLink className="h-3 w-3" />
                View in raw transcript
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Companion Source-Transcript pane. Renders the raw transcript text with
 * a highlight band on the line matching the most recently clicked quote.
 * Scrolls the highlighted segment into view on every quote change.
 */
export function SourceTranscriptPane({
  transcriptText,
  jumpToQuote,
}: {
  transcriptText: string;
  jumpToQuote: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const markRef = useRef<HTMLSpanElement | null>(null);
  const [matchIdx, setMatchIdx] = useState<number>(-1);

  // Find the match offset whenever the requested quote changes. Case-
  // insensitive contains search; falls back to the first 60 chars when
  // the full quote doesn't appear verbatim (which happens when the LLM
  // lightly paraphrases despite the prompt asking for verbatim).
  useEffect(() => {
    if (!jumpToQuote || !transcriptText) {
      setMatchIdx(-1);
      return;
    }
    const hay = transcriptText.toLowerCase();
    const needle = jumpToQuote.toLowerCase().trim();
    let idx = hay.indexOf(needle);
    if (idx < 0 && needle.length > 60) {
      idx = hay.indexOf(needle.slice(0, 60));
    }
    if (idx < 0 && needle.length > 24) {
      idx = hay.indexOf(needle.slice(0, 24));
    }
    setMatchIdx(idx);
  }, [jumpToQuote, transcriptText]);

  // After the highlight node is in the DOM, scroll it into view.
  useEffect(() => {
    if (matchIdx < 0) return;
    requestAnimationFrame(() => {
      markRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [matchIdx, jumpToQuote]);

  if (!transcriptText) {
    return (
      <div className="text-xs text-muted-foreground p-3 border rounded bg-card">
        The original transcript text is not attached to this document.
      </div>
    );
  }

  const matchedFully = matchIdx >= 0 && jumpToQuote &&
    transcriptText.toLowerCase().includes(jumpToQuote.toLowerCase().trim());

  // Split text around the match so we can wrap the matched region in a
  // highlighted span. When there's no match, render the whole transcript
  // plainly.
  const before =
    matchIdx >= 0 ? transcriptText.slice(0, matchIdx) : transcriptText;
  const matchLen = Math.min(
    jumpToQuote?.length ?? 0,
    transcriptText.length - Math.max(matchIdx, 0),
  );
  const match =
    matchIdx >= 0 ? transcriptText.slice(matchIdx, matchIdx + matchLen) : "";
  const after =
    matchIdx >= 0 ? transcriptText.slice(matchIdx + matchLen) : "";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" />
          <span className="font-medium">Raw uploaded transcript</span>
          <span className="text-[10px]">
            {transcriptText.length.toLocaleString()} chars
          </span>
        </span>
        {jumpToQuote && (
          <span
            className={
              matchedFully
                ? "text-emerald-700 dark:text-emerald-400 font-medium"
                : "text-amber-700 dark:text-amber-400 font-medium"
            }
          >
            {matchedFully ? "Highlight located" : "Highlight: approximate"}
          </span>
        )}
      </div>
      <div
        ref={containerRef}
        className="text-xs font-mono whitespace-pre-wrap bg-card text-foreground p-3 rounded border max-h-[520px] overflow-auto"
        data-testid="source-transcript-pane"
      >
        {before}
      {matchIdx >= 0 && (
        <span
          ref={markRef}
          className="bg-emerald-200 dark:bg-emerald-700/60 ring-1 ring-emerald-400 rounded px-0.5 py-0.5"
          data-testid="transcript-highlight"
        >
          {match}
        </span>
      )}
        {after}
        {matchIdx < 0 && jumpToQuote && (
          <div className="mt-2 text-xs italic text-amber-700 dark:text-amber-400 sticky bottom-0 bg-card border-t pt-1">
            <FileText className="h-3 w-3 inline mr-1 -mt-0.5" />
            Could not locate the exact quote in the transcript. The model may
            have paraphrased it. Searched for:{" "}
            <span className="font-mono">"{jumpToQuote.slice(0, 80)}…"</span>
          </div>
        )}
      </div>
    </div>
  );
}
