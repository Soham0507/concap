import { lazy, Suspense, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import {
  Brain as BrainIcon,
  MessageSquare,
  MessagesSquare,
  Library,
  Database,
  Plus,
  Mic,
  Upload,
  StickyNote,
  ClipboardPaste,
  ChevronDown,
} from "lucide-react";

const BrainPage = lazy(() => import("@/pages/brain"));
const MeetingsPage = lazy(() => import("@/pages/meetings"));
const ConversationsPage = lazy(() => import("@/pages/conversations"));
const EvidencePage = lazy(() => import("@/pages/evidence"));

const TABS = [
  { value: "insights", label: "Insights", icon: BrainIcon },
  { value: "meetings", label: "Meetings", icon: MessageSquare },
  { value: "conversations", label: "Conversations", icon: MessagesSquare },
  { value: "notes", label: "Notes & Files", icon: Library },
] as const;

type TabValue = (typeof TABS)[number]["value"];
const VALID = new Set<string>(TABS.map((t) => t.value));

function PanelLoader() {
  return (
    <div className="flex items-center justify-center py-16">
      <Spinner size="lg" />
    </div>
  );
}

export default function BrainHubPage() {
  const [, setLocation] = useLocation();
  const search = useSearch();

  const activeTab: TabValue = useMemo(() => {
    const params = new URLSearchParams(search || "");
    const t = params.get("tab") || "insights";
    return (VALID.has(t) ? t : "insights") as TabValue;
  }, [search]);

  const goToTab = (next: TabValue, extra?: Record<string, string>) => {
    const params = new URLSearchParams();
    if (next !== "insights") params.set("tab", next);
    if (extra) Object.entries(extra).forEach(([k, v]) => params.set(k, v));
    const qs = params.toString();
    setLocation(qs ? `/brain?${qs}` : "/brain");
  };

  const handleTabChange = (next: string) => {
    if (!VALID.has(next)) return;
    if (next === "notes") {
      goToTab("notes", { etab: "library" });
    } else {
      goToTab(next as TabValue);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-6 pt-6 pb-2 border-b bg-white">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-100 to-teal-100 flex items-center justify-center">
              <BrainIcon className="h-5 w-5 text-emerald-700" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-slate-800">Brain</h1>
              <p className="text-xs text-slate-500">
                Your meetings, conversations, notes, and insights — all in one place.
              </p>
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className="gap-1.5 bg-emerald-600 hover:bg-emerald-700"
                data-testid="button-brain-add"
              >
                <Plus className="h-3.5 w-3.5" />
                Add
                <ChevronDown className="h-3.5 w-3.5 opacity-80" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Add to Brain</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => goToTab("notes", { etab: "library", add: "note" })}>
                <StickyNote className="h-4 w-4 mr-2" /> Add note
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => goToTab("conversations")}>
                <ClipboardPaste className="h-4 w-4 mr-2" /> Paste transcript / chat
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => goToTab("notes", { etab: "library", add: "file" })}>
                <Upload className="h-4 w-4 mr-2" /> Upload file
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => goToTab("notes", { etab: "usage-import" })}>
                <Database className="h-4 w-4 mr-2" /> Import usage data
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => goToTab("meetings", { record: "1" })}>
                <Mic className="h-4 w-4 mr-2" /> Record meeting
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList className="bg-transparent p-0 h-auto gap-1 flex-wrap">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <TabsTrigger
                  key={t.value}
                  value={t.value}
                  className="data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700 data-[state=active]:shadow-none rounded-md px-3 py-1.5 text-sm gap-1.5"
                  data-testid={`tab-brain-${t.value}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t.label}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <Suspense fallback={<PanelLoader />}>
          {activeTab === "insights" && <BrainPage />}
          {activeTab === "meetings" && <MeetingsPage />}
          {activeTab === "conversations" && <ConversationsPage />}
          {activeTab === "notes" && <EvidencePage />}
        </Suspense>
      </div>
    </div>
  );
}
