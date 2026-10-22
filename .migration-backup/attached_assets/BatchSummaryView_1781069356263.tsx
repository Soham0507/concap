/**
 * BatchSummaryView — aggregated MOM across every completed transcript
 * in a single bulk batch.
 *
 * Each extracted item rolls up the list of source documents that
 * produced it. When a quote is present for a given source, the user can
 * click "View in raw transcript" → the parent flips to that source
 * document's MOM + opens its Raw Transcript tab with the line
 * highlighted. This is how a user goes from "interesting pattern across
 * five meetings" to "show me exactly where that came from in the third
 * meeting" in two clicks.
 */

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Quote,
  ListChecks,
  AlertTriangle,
  HelpCircle,
  ArrowRight,
  CheckCircle2,
  ScrollText,
  ExternalLink,
  FileText,
  Layers,
} from "lucide-react";

interface BatchSummarySource {
  docId: number;
  transcriptId: string;
  meetingTitle: string | null;
  quote: string | null;
}

interface SummaryItem {
  text: string;
  sources: BatchSummarySource[];
}
interface ActionSummaryItem {
  task: string;
  owner: string;
  deadline: string;
  status: string;
  sources: BatchSummarySource[];
}

export interface BatchSummary {
  batch: {
    id: number;
    label: string | null;
    status: string;
    totalCount: number;
    completedCount: number;
    failedCount: number;
  };
  sources: Array<{
    docId: number;
    transcriptId: string;
    meetingTitle: string | null;
    meetingDate: string | null;
    source: string;
  }>;
  summary: {
    discussion_points: SummaryItem[];
    decisions_taken: SummaryItem[];
    risks: SummaryItem[];
    pending_clarifications: SummaryItem[];
    next_steps: SummaryItem[];
    action_items: ActionSummaryItem[];
    executive_summaries: Array<{
      docId: number;
      transcriptId: string;
      meetingTitle: string | null;
      summary: string;
    }>;
    confidence: number;
    cited_count: number;
    total_docs: number;
  };
}

interface Props {
  data: BatchSummary;
  /**
   * Called when the user clicks "View in raw transcript" on a citation.
   * The parent should:
   *   (a) load the source document into the active result
   *   (b) flip the output card to the Raw Transcript tab
   *   (c) set the jump-quote so the matching line is highlighted
   */
  onOpenSource: (docId: number, quote: string | null) => void;
}

/** Per-source citation block. One per doc that produced an item. */
function CitationBlock({
  source,
  onOpenSource,
}: {
  source: BatchSummarySource;
  onOpenSource: (docId: number, quote: string | null) => void;
}) {
  return (
    <div
      className="pl-2 border-l-2 border-emerald-400 dark:border-emerald-700"
      data-testid={`citation-${source.docId}`}
    >
      <div className="text-[10px] font-semibold tracking-widest text-emerald-700 dark:text-emerald-400 uppercase">
        Evidence · {source.meetingTitle || `Transcript ${source.transcriptId}`}
      </div>
      {source.quote ? (
        <div className="text-xs italic text-emerald-900 dark:text-emerald-200 mt-0.5">
          <Quote className="h-3 w-3 inline mr-1 -mt-0.5 text-emerald-600" />
          "{source.quote.length > 220 ? source.quote.slice(0, 220) + "…" : source.quote}"
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground italic mt-0.5">
          No verbatim quote captured for this source (item was summarised).
        </div>
      )}
      <button
        type="button"
        onClick={() => onOpenSource(source.docId, source.quote)}
        className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-400 hover:underline inline-flex items-center gap-1"
        data-testid={`citation-${source.docId}-link`}
        title="Open the originating transcript and highlight this line"
      >
        <ExternalLink className="h-3 w-3" />
        View in raw transcript
      </button>
    </div>
  );
}

function ItemBlock({
  text,
  sources,
  iconColor,
  testIdPrefix,
  index,
  onOpenSource,
}: {
  text: string;
  sources: BatchSummarySource[];
  iconColor: string;
  testIdPrefix: string;
  index: number;
  onOpenSource: (docId: number, quote: string | null) => void;
}) {
  return (
    <li
      className="flex items-start gap-2 text-sm"
      data-testid={`${testIdPrefix}-${index}`}
    >
      <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${iconColor}`} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">{text}</div>
          {sources.length > 1 && (
            <Badge
              variant="outline"
              className="text-[10px] shrink-0"
              title={`Mentioned in ${sources.length} transcripts`}
            >
              ×{sources.length}
            </Badge>
          )}
        </div>
        <div className="space-y-1.5">
          {sources.map((s) => (
            <CitationBlock
              key={s.docId}
              source={s}
              onOpenSource={onOpenSource}
            />
          ))}
        </div>
      </div>
    </li>
  );
}

function Section({
  title,
  icon,
  testId,
  count,
  children,
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
      <ul className="space-y-3 pl-1">{children}</ul>
    </section>
  );
}

export function BatchSummaryView({ data, onOpenSource }: Props) {
  const { batch, sources, summary } = data;
  const dp = summary.discussion_points;
  const dt = summary.decisions_taken;
  const rk = summary.risks;
  const pc = summary.pending_clarifications;
  const ns = summary.next_steps;
  const ai = summary.action_items;

  return (
    <div className="space-y-4" data-testid="batch-summary-view">
      {/* Header — counts + confidence + which meetings rolled into this */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-base font-semibold truncate flex items-center gap-2">
                <Layers className="h-4 w-4 text-emerald-600" />
                {batch.label || `Batch #${batch.id} — combined MOM`}
              </h3>
              <div className="text-xs text-muted-foreground mt-0.5">
                Rolled up from {summary.total_docs} of {batch.totalCount}{" "}
                transcripts
                {batch.failedCount > 0 && (
                  <span className="text-amber-700 dark:text-amber-400 ml-1">
                    · {batch.failedCount} failed (excluded)
                  </span>
                )}
              </div>
            </div>
            <div className="shrink-0 flex flex-col items-end gap-1">
              <Badge variant="outline" className="text-xs">
                Confidence {(summary.confidence * 100).toFixed(0)}%
              </Badge>
              <Badge variant="outline" className="text-xs">
                {summary.cited_count} cited items
              </Badge>
            </div>
          </div>

          {/* Source-transcript chip list. Clicking a chip opens that doc. */}
          {sources.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1.5 border-t">
              <span className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mr-1">
                Sources
              </span>
              {sources.map((s) => (
                <button
                  key={s.docId}
                  type="button"
                  onClick={() => onOpenSource(s.docId, null)}
                  className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border bg-card hover:bg-muted/40 hover:border-emerald-300 transition-colors"
                  data-testid={`source-chip-${s.docId}`}
                  title="Open this transcript's full MOM"
                >
                  <FileText className="h-3 w-3" />
                  {s.meetingTitle || s.transcriptId}
                  {s.meetingDate && (
                    <span className="text-muted-foreground">· {s.meetingDate}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-transcript executive summaries — quick read of each meeting. */}
      {summary.executive_summaries.length > 0 && (
        <section data-testid="section-summaries">
          <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">
            Per-transcript executive summaries
          </div>
          <div className="space-y-1.5">
            {summary.executive_summaries.map((s) => (
              <div
                key={s.docId}
                className="text-sm border rounded p-2 bg-card"
                data-testid={`exec-summary-${s.docId}`}
              >
                <button
                  type="button"
                  onClick={() => onOpenSource(s.docId, null)}
                  className="text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:underline inline-flex items-center gap-1 mb-0.5"
                  title="Open this transcript's MOM"
                >
                  <FileText className="h-3 w-3" />
                  {s.meetingTitle || s.transcriptId}
                </button>
                <p className="text-sm leading-relaxed">{s.summary}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <Section
        title="Discussion points (across all transcripts)"
        icon={<ScrollText className="h-3 w-3" />}
        testId="bs-section-discussion"
        count={dp.length}
      >
        {dp.map((it, i) => (
          <ItemBlock
            key={i}
            text={it.text}
            sources={it.sources}
            iconColor="bg-blue-400"
            testIdPrefix="bs-row-discussion"
            index={i}
            onOpenSource={onOpenSource}
          />
        ))}
      </Section>

      <Section
        title="Decisions"
        icon={<CheckCircle2 className="h-3 w-3" />}
        testId="bs-section-decisions"
        count={dt.length}
      >
        {dt.map((it, i) => (
          <ItemBlock
            key={i}
            text={it.text}
            sources={it.sources}
            iconColor="bg-emerald-500"
            testIdPrefix="bs-row-decision"
            index={i}
            onOpenSource={onOpenSource}
          />
        ))}
      </Section>

      {/* Action items: table-style with citations per row */}
      <section className="space-y-1" data-testid="bs-section-actions">
        <div className="flex items-center gap-2 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
          <ListChecks className="h-3 w-3" /> Action items
          <Badge variant="outline" className="text-[10px] ml-1">
            {ai.length}
          </Badge>
        </div>
        {ai.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">None.</div>
        ) : (
          <div className="space-y-2">
            {ai.map((a, i) => (
              <div
                key={i}
                className="border rounded p-2 bg-card space-y-1.5"
                data-testid={`bs-row-action-${i}`}
              >
                <div className="flex items-start justify-between gap-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{a.task}</div>
                    <div className="text-xs text-muted-foreground">
                      Owner: {a.owner} · Deadline: {a.deadline}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {a.sources.length > 1 && (
                      <Badge variant="outline" className="text-[10px]">
                        ×{a.sources.length}
                      </Badge>
                    )}
                    <Badge variant="outline" className="text-[10px]">
                      {a.status}
                    </Badge>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {a.sources.map((s) => (
                    <CitationBlock
                      key={s.docId}
                      source={s}
                      onOpenSource={onOpenSource}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Section
        title="Risks"
        icon={<AlertTriangle className="h-3 w-3" />}
        testId="bs-section-risks"
        count={rk.length}
      >
        {rk.map((it, i) => (
          <ItemBlock
            key={i}
            text={it.text}
            sources={it.sources}
            iconColor="bg-red-500"
            testIdPrefix="bs-row-risk"
            index={i}
            onOpenSource={onOpenSource}
          />
        ))}
      </Section>

      <Section
        title="Pending clarifications"
        icon={<HelpCircle className="h-3 w-3" />}
        testId="bs-section-clarifications"
        count={pc.length}
      >
        {pc.map((it, i) => (
          <ItemBlock
            key={i}
            text={it.text}
            sources={it.sources}
            iconColor="bg-amber-500"
            testIdPrefix="bs-row-clarification"
            index={i}
            onOpenSource={onOpenSource}
          />
        ))}
      </Section>

      <Section
        title="Next steps"
        icon={<ArrowRight className="h-3 w-3" />}
        testId="bs-section-next"
        count={ns.length}
      >
        {ns.map((it, i) => (
          <ItemBlock
            key={i}
            text={it.text}
            sources={it.sources}
            iconColor="bg-indigo-500"
            testIdPrefix="bs-row-next"
            index={i}
            onOpenSource={onOpenSource}
          />
        ))}
      </Section>
    </div>
  );
}
