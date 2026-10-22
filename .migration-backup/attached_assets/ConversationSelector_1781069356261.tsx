import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Conversation } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  MessageSquare,
  Check,
  Loader2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface ConversationSelectorProps {
  selectedIds: number[];
  onSelectionChange: (ids: number[]) => void;
}

export function ConversationSelector({
  selectedIds,
  onSelectionChange,
}: ConversationSelectorProps) {
  const [expanded, setExpanded] = useState(false);

  const { data: conversations = [], isLoading } = useQuery<Conversation[]>({
    queryKey: ["/api/conversations"],
  });

  const toggleConversation = (id: number) => {
    if (selectedIds.includes(id)) {
      onSelectionChange(selectedIds.filter((sid) => sid !== id));
    } else {
      onSelectionChange([...selectedIds, id]);
    }
  };

  const selectedConversations = conversations.filter((c) =>
    selectedIds.includes(c.id),
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-400 py-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading conversations...
      </div>
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-slate-700 bg-slate-50 hover:bg-slate-100 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5 text-emerald-600" />
          Meetings
          {selectedIds.length > 0 && (
            <Badge className="h-4 px-1.5 text-[10px] bg-emerald-100 text-emerald-700 border-emerald-200">
              {selectedIds.length}
            </Badge>
          )}
        </span>
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
        )}
      </button>

      {expanded && conversations.length === 0 && (
        <div className="px-3 py-3 text-xs text-slate-500 text-center">
          <p className="mb-1">No meetings imported yet.</p>
          <a href="/meetings" className="text-emerald-600 hover:text-emerald-700 font-medium underline">
            Go to Meetings to import transcripts
          </a>
        </div>
      )}

      {expanded && conversations.length > 0 && (
        <ScrollArea className="max-h-[200px]">
          <div className="p-1.5 space-y-1">
            {conversations.map((conv) => {
              const isSelected = selectedIds.includes(conv.id);
              return (
                <button
                  key={conv.id}
                  onClick={() => toggleConversation(conv.id)}
                  className={`w-full flex items-start gap-2 p-2 rounded-md text-left transition-colors text-xs ${
                    isSelected
                      ? "bg-emerald-50 border border-emerald-200"
                      : "hover:bg-slate-50 border border-transparent"
                  }`}
                >
                  <div
                    className={`mt-0.5 h-4 w-4 rounded border flex-shrink-0 flex items-center justify-center ${
                      isSelected
                        ? "bg-emerald-600 border-emerald-600 text-white"
                        : "border-slate-300"
                    }`}
                  >
                    {isSelected && <Check className="h-3 w-3" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-700 truncate">
                      {conv.title}
                    </p>
                    <p className="text-slate-400 truncate mt-0.5">
                      {conv.summary
                        ? conv.summary.substring(0, 60) + "..."
                        : conv.content.substring(0, 60) + "..."}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      )}

      {!expanded && selectedConversations.length > 0 && (
        <div className="px-3 py-1.5 flex flex-wrap gap-1">
          {selectedConversations.map((c) => (
            <Badge
              key={c.id}
              variant="outline"
              className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200"
            >
              {c.title.length > 20 ? c.title.substring(0, 20) + "..." : c.title}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function getConversationContextText(
  conversations: Conversation[],
  selectedIds: number[],
): string {
  const selected = conversations.filter((c) => selectedIds.includes(c.id));
  if (selected.length === 0) return "";

  return selected
    .map(
      (c) =>
        `[MEETING: ${c.title}]\n${c.summary ? `Summary: ${c.summary}\n\n` : ""}${c.content}`,
    )
    .join("\n\n---\n\n");
}
