import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { apiRequest } from "@/lib/queryClient";
import type {
  Conversation,
  TeamsMeeting,
  GoogleMeetMeeting,
  ZoomMeeting,
} from "@shared/schema";
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
  Brain,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { useDropzone } from "react-dropzone";
import { SiSlack, SiZoom, SiGooglemeet } from "react-icons/si";
import { MeetingIntelligenceTab } from "@/components/meetings/MeetingIntelligenceTab";

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

export default function MeetingsPage() {
  const { toast } = useToast();
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
          const err = await res.json();
          throw new Error(err.error || "Transcription failed");
        }
        return await res.json();
      } catch (err) {
        clearInterval(progressInterval);
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
    maxSize: 25 * 1024 * 1024,
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
          {/* When the Intelligence tab is active we expand the import panel
              to full width and hide the Imported-Conversations detail
              column. Intelligence has its own input/output/bulk/history
              cards and needs the room. */}
          <div
            className={
              activeTab === "intelligence"
                ? "lg:col-span-5"
                : "lg:col-span-2"
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
                  {/* h-auto + flex-wrap so 7 tabs don't compress into
                      unreadable slivers on narrow viewports. */}
                  <TabsList className="flex flex-wrap h-auto gap-1 p-1">
                    <TabsTrigger value="all" className="text-xs px-1">
                      <Calendar className="h-3.5 w-3.5 mr-1" />
                      All
                    </TabsTrigger>
                    <TabsTrigger value="manual" className="text-xs px-1">
                      <FileText className="h-3.5 w-3.5 mr-1" />
                      Manual
                    </TabsTrigger>
                    <TabsTrigger value="audio" className="text-xs px-1">
                      <Mic className="h-3.5 w-3.5 mr-1" />
                      Audio
                    </TabsTrigger>
                    <TabsTrigger value="zoom" className="text-xs px-1 relative">
                      <SiZoom className="h-3.5 w-3.5 mr-1" />
                      Zoom
                      {isZoomConnected && (
                        <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full" />
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="meet" className="text-xs px-1 relative">
                      <SiGooglemeet className="h-3.5 w-3.5 mr-1" />
                      Meet
                      {(isGoogleMeetConnected ||
                        integrationStatuses.google_meet?.connected) && (
                        <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full" />
                      )}
                    </TabsTrigger>
                    <TabsTrigger
                      value="teams"
                      className="text-xs px-1 relative"
                    >
                      <Users className="h-3.5 w-3.5 mr-1" />
                      Teams
                      {isTeamsConnected && (
                        <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full" />
                      )}
                    </TabsTrigger>
                    <TabsTrigger
                      value="intelligence"
                      className="text-xs px-1"
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
                            MP3, MP4, WAV, M4A, WebM — up to 25MB
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

                  {/* AI Meeting Intelligence — bulk-transcript MOM processor */}
                  <TabsContent value="intelligence">
                    <MeetingIntelligenceTab />
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>

          {/* Imported Conversations detail panel — hidden when Intelligence
              tab is active (it has its own output / history surface). */}
          <div
            className={
              activeTab === "intelligence"
                ? "hidden"
                : "lg:col-span-3"
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

                          <p className="text-xs text-slate-500 line-clamp-2 mb-3">
                            {conv.content.substring(0, 200)}
                            {conv.content.length > 200 ? "..." : ""}
                          </p>

                          {conv.summary && (
                            <div className="bg-emerald-50 border border-emerald-200 rounded-md p-3 mb-3">
                              <div className="flex items-center gap-1 mb-1">
                                <Sparkles className="h-3 w-3 text-emerald-600" />
                                <span className="text-xs font-semibold text-emerald-700">
                                  AI Summary
                                </span>
                              </div>
                              <p className="text-xs text-emerald-800 whitespace-pre-line">
                                {conv.summary}
                              </p>
                            </div>
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
              />
              <p className="text-xs text-muted-foreground mt-1">
                Each attendee will receive a calendar invitation with the Teams
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
    </div>
  );
}
