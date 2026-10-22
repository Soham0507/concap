export interface ConversationImport {
  title: string;
  content: string;
  participants: string[];
  meetingDate: Date | null;
  source: string;
}

export class MeetingIntegrationsService {
  private get slackClientId(): string {
    return process.env.SLACK_CLIENT_ID || "";
  }
  private get slackClientSecret(): string {
    return process.env.SLACK_CLIENT_SECRET || "";
  }
  private get zoomClientId(): string {
    return process.env.ZOOM_CLIENT_ID || "";
  }
  private get zoomClientSecret(): string {
    return process.env.ZOOM_CLIENT_SECRET || "";
  }
  private get googleClientId(): string {
    return process.env.GOOGLE_CLIENT_ID || "";
  }
  private get googleClientSecret(): string {
    return process.env.GOOGLE_CLIENT_SECRET || "";
  }
  private get teamsClientId(): string {
    return process.env.MICROSOFT_CLIENT_ID || process.env.TEAMS_CLIENT_ID || "";
  }
  private get teamsClientSecret(): string {
    return process.env.MICROSOFT_CLIENT_SECRET || process.env.TEAMS_CLIENT_SECRET || "";
  }
  private get teamsTenantId(): string {
    return process.env.MICROSOFT_TENANT_ID || "common";
  }

  getSlackAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.slackClientId,
      scope: "channels:history,channels:read,groups:read,groups:history",
      redirect_uri: redirectUri,
      response_type: "code",
      state,
    });
    return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
  }

  getZoomAuthUrl(redirectUri: string, state: string, codeChallenge?: string): string {
    const params: Record<string, string> = {
      client_id: this.zoomClientId,
      response_type: "code",
      redirect_uri: redirectUri,
      state,
    };
    if (codeChallenge) {
      params.code_challenge = codeChallenge;
      params.code_challenge_method = "S256";
    }
    return `https://zoom.us/oauth/authorize?${new URLSearchParams(params).toString()}`;
  }

  getGoogleAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.googleClientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents.readonly openid email",
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  getTeamsAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.teamsClientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "Chat.Read OnlineMeetingTranscript.Read.All offline_access",
      response_mode: "query",
      state,
    });
    return `https://login.microsoftonline.com/${this.teamsTenantId}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async exchangeSlackCode(
    code: string,
    redirectUri: string,
  ): Promise<{ accessToken: string; teamName?: string; teamId?: string }> {
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.slackClientId,
        client_secret: this.slackClientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const data = await response.json();
    if (!data.ok) {
      throw new Error(`Slack OAuth error: ${data.error}`);
    }
    return {
      accessToken: data.access_token,
      teamName: data.team?.name,
      teamId: data.team?.id,
    };
  }

  async exchangeZoomCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
  ): Promise<{ accessToken: string; refreshToken?: string }> {
    const credentials = Buffer.from(
      `${this.zoomClientId}:${this.zoomClientSecret}`,
    ).toString("base64");
    const bodyParams: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    };
    if (codeVerifier) {
      bodyParams.code_verifier = codeVerifier;
    }
    const response = await fetch("https://zoom.us/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(bodyParams),
    });
    const data = await response.json();
    console.log(`Zoom token exchange response: status=${response.status}, error=${data.error}, reason=${data.reason}, redirectUri=${redirectUri}`);
    if (data.error) {
      throw new Error(`Zoom OAuth error: ${data.error} - ${data.reason || 'no reason provided'}`);
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
    };
  }

  async exchangeGoogleCode(
    code: string,
    redirectUri: string,
  ): Promise<{ accessToken: string; refreshToken?: string }> {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.googleClientId,
        client_secret: this.googleClientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const data = await response.json();
    console.log(`Google token exchange response: status=${response.status}, error=${data.error}, redirectUri=${redirectUri}`);
    if (data.error) {
      throw new Error(`Google OAuth error: ${data.error} - ${data.error_description || 'no description'}`);
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
    };
  }

  async exchangeTeamsCode(
    code: string,
    redirectUri: string,
  ): Promise<{ accessToken: string; refreshToken?: string }> {
    const response = await fetch(
      `https://login.microsoftonline.com/${this.teamsTenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.teamsClientId,
          client_secret: this.teamsClientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          scope: "Chat.Read OnlineMeetingTranscript.Read.All offline_access",
        }),
      },
    );
    const data = await response.json();
    if (data.error) {
      throw new Error(`Teams OAuth error: ${data.error}`);
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
    };
  }

  async fetchSlackConversations(
    accessToken: string,
  ): Promise<ConversationImport[]> {
    try {
      const channelsRes = await fetch(
        "https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=20",
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const channelsData = await channelsRes.json();
      if (!channelsData.ok) {
        console.error("Slack conversations.list error:", channelsData.error);
        return [];
      }

      const results: ConversationImport[] = [];
      const channels = channelsData.channels || [];

      for (const channel of channels.slice(0, 10)) {
        try {
          const historyRes = await fetch(
            `https://slack.com/api/conversations.history?channel=${channel.id}&limit=50`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          const historyData = await historyRes.json();
          if (!historyData.ok) continue;

          const messages = historyData.messages || [];
          if (messages.length === 0) continue;

          const participants = Array.from(
            new Set(
              messages
                .map((m: any) => m.user)
                .filter(Boolean) as string[],
            ),
          );
          const content = messages
            .map((m: any) => m.text || "")
            .filter(Boolean)
            .join("\n");
          const latestTs = messages[0]?.ts
            ? new Date(parseFloat(messages[0].ts) * 1000)
            : null;

          results.push({
            title: `#${channel.name || channel.id}`,
            content,
            participants,
            meetingDate: latestTs,
            source: "slack",
          });
        } catch (err) {
          console.error(
            `Slack history error for channel ${channel.id}:`,
            err,
          );
        }
      }

      return results;
    } catch (error) {
      console.error("Slack fetchConversations error:", error);
      return [];
    }
  }

  async fetchZoomTranscripts(
    accessToken: string,
  ): Promise<ConversationImport[]> {
    try {
      const fromDate = new Date();
      fromDate.setMonth(fromDate.getMonth() - 1);
      const from = fromDate.toISOString().split("T")[0];
      const to = new Date().toISOString().split("T")[0];

      const recordingsRes = await fetch(
        `https://api.zoom.us/v2/users/me/recordings?from=${from}&to=${to}&page_size=30`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const recordingsData = await recordingsRes.json();
      if (recordingsData.code) {
        console.error("Zoom recordings error:", recordingsData.message);
        return [];
      }

      const results: ConversationImport[] = [];
      const meetings = recordingsData.meetings || [];

      for (const meeting of meetings) {
        const recordingFiles = meeting.recording_files || [];
        const transcriptFile = recordingFiles.find(
          (f: any) => f.file_type === "TRANSCRIPT",
        );

        let content = "";
        if (transcriptFile?.download_url) {
          try {
            const transcriptRes = await fetch(
              `${transcriptFile.download_url}?access_token=${accessToken}`,
            );
            if (transcriptRes.ok) {
              content = await transcriptRes.text();
            }
          } catch (err) {
            console.error(
              `Zoom transcript download error for meeting ${meeting.id}:`,
              err,
            );
          }
        }

        if (!content) {
          content = `Zoom meeting: ${meeting.topic || "Untitled"}`;
        }

        results.push({
          title: meeting.topic || "Zoom Meeting",
          content,
          participants: meeting.participants
            ? meeting.participants.map((p: any) => p.name || p.email || "Unknown")
            : [],
          meetingDate: meeting.start_time
            ? new Date(meeting.start_time)
            : null,
          source: "zoom",
        });
      }

      return results;
    } catch (error) {
      console.error("Zoom fetchTranscripts error:", error);
      return [];
    }
  }

  async fetchGoogleMeetTranscripts(
    accessToken: string,
  ): Promise<ConversationImport[]> {
    try {
      const query = encodeURIComponent(
        "mimeType='application/vnd.google-apps.document' and (name contains 'Meeting transcript' or name contains 'meeting notes' or name contains 'Google Meet' or name contains 'Meeting')",
      );
      const filesRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,createdTime,owners)&orderBy=createdTime desc&pageSize=20`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const filesData = await filesRes.json();
      console.log(`Google Drive search: found ${filesData.files?.length || 0} files, error=${filesData.error?.message || 'none'}`);
      if (filesData.error) {
        console.error("Google Drive files error:", filesData.error.message);
        return [];
      }

      const results: ConversationImport[] = [];
      const files = filesData.files || [];

      for (const file of files) {
        try {
          const exportRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          if (!exportRes.ok) continue;

          const content = await exportRes.text();
          const owners = (file.owners || []).map(
            (o: any) => o.displayName || o.emailAddress || "Unknown",
          );

          results.push({
            title: file.name || "Google Meet Transcript",
            content,
            participants: owners,
            meetingDate: file.createdTime
              ? new Date(file.createdTime)
              : null,
            source: "google_meet",
          });
        } catch (err) {
          console.error(
            `Google Drive export error for file ${file.id}:`,
            err,
          );
        }
      }

      return results;
    } catch (error) {
      console.error("Google Meet fetchTranscripts error:", error);
      return [];
    }
  }

  async fetchTeamsTranscripts(
    accessToken: string,
  ): Promise<ConversationImport[]> {
    try {
      const results: ConversationImport[] = [];

      const chatsRes = await fetch(
        "https://graph.microsoft.com/v1.0/me/chats?$top=20&$expand=members",
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const chatsData = await chatsRes.json();
      if (chatsData.error) {
        console.error("Teams chats error:", chatsData.error.message);
        return [];
      }

      const chats = chatsData.value || [];

      for (const chat of chats) {
        try {
          const messagesRes = await fetch(
            `https://graph.microsoft.com/v1.0/me/chats/${chat.id}/messages?$top=50`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          const messagesData = await messagesRes.json();
          if (messagesData.error) continue;

          const messages = messagesData.value || [];
          if (messages.length === 0) continue;

          const content = messages
            .map((m: any) => {
              const body = m.body?.content || "";
              return body.replace(/<[^>]*>/g, "");
            })
            .filter(Boolean)
            .join("\n");

          const participants = (chat.members || []).map(
            (m: any) => m.displayName || m.email || "Unknown",
          );

          const latestDate = messages[0]?.createdDateTime
            ? new Date(messages[0].createdDateTime)
            : null;

          results.push({
            title: chat.topic || `Teams Chat`,
            content,
            participants,
            meetingDate: latestDate,
            source: "teams",
          });
        } catch (err) {
          console.error(
            `Teams messages error for chat ${chat.id}:`,
            err,
          );
        }
      }

      try {
        const meetingsRes = await fetch(
          "https://graph.microsoft.com/v1.0/me/onlineMeetings?$top=20",
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        const meetingsData = await meetingsRes.json();

        if (!meetingsData.error) {
          const meetings = meetingsData.value || [];

          for (const meeting of meetings) {
            try {
              const transcriptsRes = await fetch(
                `https://graph.microsoft.com/v1.0/me/onlineMeetings/${meeting.id}/transcripts`,
                { headers: { Authorization: `Bearer ${accessToken}` } },
              );
              const transcriptsData = await transcriptsRes.json();
              if (transcriptsData.error) continue;

              const transcripts = transcriptsData.value || [];
              for (const transcript of transcripts) {
                try {
                  const contentRes = await fetch(
                    `https://graph.microsoft.com/v1.0/me/onlineMeetings/${meeting.id}/transcripts/${transcript.id}/content?$format=text/vtt`,
                    { headers: { Authorization: `Bearer ${accessToken}` } },
                  );
                  if (!contentRes.ok) continue;

                  const transcriptContent = await contentRes.text();

                  results.push({
                    title:
                      meeting.subject ||
                      `Teams Meeting Transcript`,
                    content: transcriptContent,
                    participants: (meeting.participants?.attendees || []).map(
                      (a: any) =>
                        a.identity?.user?.displayName || "Unknown",
                    ),
                    meetingDate: meeting.startDateTime
                      ? new Date(meeting.startDateTime)
                      : null,
                    source: "teams",
                  });
                } catch (err) {
                  console.error(
                    `Teams transcript content error:`,
                    err,
                  );
                }
              }
            } catch (err) {
              console.error(
                `Teams transcripts list error for meeting ${meeting.id}:`,
                err,
              );
            }
          }
        }
      } catch (err) {
        console.error("Teams onlineMeetings error:", err);
      }

      return results;
    } catch (error) {
      console.error("Teams fetchTranscripts error:", error);
      return [];
    }
  }
}

export const meetingIntegrations = new MeetingIntegrationsService();
