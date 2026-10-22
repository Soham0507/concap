const MICROSOFT_AUTH_URL = "https://login.microsoftonline.com";
const GRAPH_API_URL = "https://graph.microsoft.com/v1.0";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

interface TeamsOnlineMeeting {
  id: string;
  subject: string;
  startDateTime: string;
  endDateTime: string;
  joinWebUrl: string;
  meetingType: "teams" | "calendar";
  chatInfo?: {
    threadId: string;
  };
}

interface TeamsTranscript {
  id: string;
  meetingId: string;
  createdDateTime: string;
}

const tokenStore = new Map<
  string,
  {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }
>();

function getClientId(): string {
  return process.env.MICROSOFT_CLIENT_ID || "";
}

function getClientSecret(): string {
  return process.env.MICROSOFT_CLIENT_SECRET || "";
}

function getTenantId(): string {
  return "common";
}

export function getRedirectUri(): string {
  return "https://devrequisorio-y-cnew.replit.app/api/teams/oauth/callback";
}

export function isTeamsConfigured(): boolean {
  return !!(
    process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET
  );
}

export function getAuthUrl(state: string): string {
  const tenantId = getTenantId();
  const scopes = [
    "openid",
    "profile",
    "offline_access",
    "OnlineMeetings.ReadWrite",
    "Calendars.ReadWrite",
    "User.Read",
  ].join(" ");

  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: "code",
    redirect_uri: getRedirectUri(),
    scope: scopes,
    state,
    response_mode: "query",
    prompt: "select_account",
  });

  return `${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(
  code: string,
): Promise<TokenResponse> {
  const tenantId = getTenantId();
  const response = await fetch(
    `${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: getClientId(),
        client_secret: getClientSecret(),
        code,
        redirect_uri: getRedirectUri(),
        grant_type: "authorization_code",
        scope:
          "openid profile offline_access OnlineMeetings.ReadWrite Calendars.ReadWrite User.Read",
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const tokenData = await response.json();
  console.log(`[Teams] Token granted scopes: ${tokenData.scope}`);
  return tokenData;
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenResponse> {
  const tenantId = getTenantId();
  const response = await fetch(
    `${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: getClientId(),
        client_secret: getClientSecret(),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope:
          "openid profile offline_access OnlineMeetings.ReadWrite Calendars.ReadWrite User.Read",
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  return response.json();
}

export function storeToken(
  userId: string,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
) {
  tokenStore.set(userId, {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000 - 60000,
  });
}

export async function getValidToken(userId: string): Promise<string | null> {
  const stored = tokenStore.get(userId);
  if (!stored) return null;

  if (Date.now() >= stored.expiresAt && stored.refreshToken) {
    try {
      const newTokens = await refreshAccessToken(stored.refreshToken);
      storeToken(
        userId,
        newTokens.access_token,
        newTokens.refresh_token || stored.refreshToken,
        newTokens.expires_in,
      );
      return newTokens.access_token;
    } catch {
      tokenStore.delete(userId);
      return null;
    }
  }

  return stored.accessToken;
}

export function removeToken(userId: string) {
  tokenStore.delete(userId);
}

export function hasToken(userId: string): boolean {
  return tokenStore.has(userId);
}

async function graphRequest(
  accessToken: string,
  endpoint: string,
  options: RequestInit = {},
) {
  const response = await fetch(`${GRAPH_API_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Graph API error (${response.status}): ${error}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

export async function createOnlineMeeting(
  accessToken: string,
  subject: string,
  startTime: string,
  endTime: string,
  attendees: string[] = [],
  timeZone: string = "UTC",
): Promise<TeamsOnlineMeeting> {
  console.log("[Teams] Using Calendar API to create meeting (ensures calendar entry + invitations)");
  try {
    return await createMeetingViaCalendar(accessToken, subject, startTime, endTime, attendees, timeZone);
  } catch (calErr: any) {
    console.log("[Teams] Calendar API failed:", calErr.message);
    if (attendees.length > 0) {
      throw calErr;
    }
  }

  try {
    const body: any = {
      subject,
      startDateTime: startTime,
      endDateTime: endTime,
    };

    console.log("[Teams] Falling back to /me/onlineMeetings (v1.0)...");
    const result = await graphRequest(accessToken, "/me/onlineMeetings", {
      method: "POST",
      body: JSON.stringify(body),
    });
    console.log(
      `[Teams] onlineMeetings success: joinWebUrl=${result.joinWebUrl}`,
    );
    return { ...result, meetingType: "teams" as const };
  } catch (err: any) {
    console.log("[Teams] onlineMeetings v1.0 failed:", err.message);

    try {
      console.log("[Teams] Trying beta /me/onlineMeetings...");
      const betaBody: any = {
        subject,
        startDateTime: startTime,
        endDateTime: endTime,
      };
      const betaResponse = await fetch(
        `https://graph.microsoft.com/beta/me/onlineMeetings`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(betaBody),
        },
      );
      if (betaResponse.ok) {
        const result = await betaResponse.json();
        console.log(
          `[Teams] beta onlineMeetings success: joinWebUrl=${result.joinWebUrl}`,
        );
        return { ...result, meetingType: "teams" as const };
      }
      const betaErr = await betaResponse.text();
      console.log(
        `[Teams] beta onlineMeetings failed (${betaResponse.status}):`,
        betaErr,
      );
    } catch (betaErr: any) {
      console.log("[Teams] beta onlineMeetings error:", betaErr.message);
    }

    throw new Error("All Teams meeting creation methods failed");
  }
}

async function createMeetingViaCalendar(
  accessToken: string,
  subject: string,
  startTime: string,
  endTime: string,
  attendees: string[] = [],
  timeZone: string = "UTC",
): Promise<TeamsOnlineMeeting> {
  const toCleanDateTime = (dt: string): string => {
    return dt
      .replace(/[Z]$/i, "")
      .replace(/[+-]\d{2}:\d{2}$/, "")
      .split(".")[0];
  };

  const startDt = toCleanDateTime(startTime);
  const endDt = toCleanDateTime(endTime);
  console.log(
    `Creating meeting: startDt=${startDt}, endDt=${endDt}, timeZone=${timeZone}, original: start=${startTime}, end=${endTime}`,
  );

  const baseEvent = {
    subject,
    start: { dateTime: startDt, timeZone },
    end: { dateTime: endDt, timeZone },
    isOnlineMeeting: true,
  };

  const strategies: Array<{ name: string; body: any; useBeta?: boolean }> = [
    {
      name: "auto-detect (beta)",
      body: baseEvent,
      useBeta: true,
    },
    {
      name: "auto-detect (v1.0)",
      body: baseEvent,
    },
    {
      name: "teamsForBusiness",
      body: { ...baseEvent, onlineMeetingProvider: "teamsForBusiness" },
    },
    {
      name: "skypeForConsumer",
      body: { ...baseEvent, onlineMeetingProvider: "skypeForConsumer" },
    },
  ];

  let lastEvent: any = null;

  for (const strategy of strategies) {
    try {
      const body = { ...strategy.body };
      if (attendees.length > 0) {
        body.attendees = attendees.map((email: string) => ({
          emailAddress: { address: email },
          type: "required",
        }));
      }

      const apiBase = strategy.useBeta
        ? "https://graph.microsoft.com/beta"
        : GRAPH_API_URL;
      console.log(
        `Attempting calendar event with strategy '${strategy.name}' (${apiBase}):`,
        JSON.stringify(body),
      );

      const eventResponse = await fetch(`${apiBase}/me/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!eventResponse.ok) {
        const errText = await eventResponse.text();
        throw new Error(
          `Graph API error (${eventResponse.status}): ${errText}`,
        );
      }

      const event = await eventResponse.json();

      const joinLink =
        event.onlineMeeting?.joinUrl || event.onlineMeetingUrl || "";
      const calendarLink = event.webLink || "";
      const chosenProvider = event.onlineMeetingProvider || "none";

      console.log(
        `Calendar event created with strategy '${strategy.name}': provider=${chosenProvider}, joinLink=${joinLink}, calendarLink=${calendarLink}, isOnlineMeeting=${event.isOnlineMeeting}, onlineMeeting=${JSON.stringify(event.onlineMeeting || {})}`,
      );

      if (joinLink) {
        return {
          id: event.id,
          subject: event.subject,
          startDateTime: event.start?.dateTime || startTime,
          endDateTime: event.end?.dateTime || endTime,
          joinUrl: joinLink,
          joinWebUrl: joinLink,
          meetingType: "teams" as const,
        };
      }

      if (!lastEvent) {
        lastEvent = event;
      } else {
        try {
          await graphRequest(accessToken, `/me/events/${event.id}`, {
            method: "DELETE",
          });
        } catch (delErr: any) {
          console.log("Could not delete duplicate event:", delErr.message);
        }
      }
    } catch (err: any) {
      console.log(
        `Calendar meeting with strategy '${strategy.name}' failed:`,
        err.message,
      );
    }
  }

  if (lastEvent) {
    const fallbackLink =
      lastEvent.onlineMeeting?.joinUrl ||
      lastEvent.onlineMeetingUrl ||
      lastEvent.webLink ||
      "";
    return {
      id: lastEvent.id,
      subject: lastEvent.subject,
      startDateTime: lastEvent.start?.dateTime || startTime,
      endDateTime: lastEvent.end?.dateTime || endTime,
      joinUrl: fallbackLink,
      joinWebUrl: fallbackLink,
      meetingType: "calendar" as const,
    };
  }

  console.log(
    "All strategies failed, creating plain calendar event as final fallback",
  );
  try {
    const plainBody: any = {
      subject,
      body: { contentType: "text", content: `Meeting: ${subject}` },
      start: { dateTime: startDt, timeZone },
      end: { dateTime: endDt, timeZone },
    };

    if (attendees.length > 0) {
      plainBody.attendees = attendees.map((email: string) => ({
        emailAddress: { address: email },
        type: "required",
      }));
    }

    const event = await graphRequest(accessToken, "/me/events", {
      method: "POST",
      body: JSON.stringify(plainBody),
    });

    const calendarLink = event.webLink || "";
    console.log(`Plain calendar event created: calendarLink=${calendarLink}`);

    return {
      id: event.id,
      subject: event.subject,
      startDateTime: event.start?.dateTime || startTime,
      endDateTime: event.end?.dateTime || endTime,
      joinUrl: calendarLink,
      joinWebUrl: calendarLink,
      meetingType: "calendar" as const,
    };
  } catch (plainErr: any) {
    console.log("Plain calendar event also failed:", plainErr.message);
    throw plainErr || new Error("Failed to create meeting via Calendar API");
  }
}

export async function listOnlineMeetings(
  accessToken: string,
): Promise<TeamsOnlineMeeting[]> {
  try {
    const result = await graphRequest(accessToken, "/me/onlineMeetings");
    return result?.value || [];
  } catch (err: any) {
    console.log(
      "OnlineMeetings list failed, trying Calendar events as fallback:",
      err.message,
    );
    return listMeetingsViaCalendar(accessToken);
  }
}

async function listMeetingsViaCalendar(
  accessToken: string,
): Promise<TeamsOnlineMeeting[]> {
  const now = new Date().toISOString();
  const result = await graphRequest(
    accessToken,
    `/me/events?$filter=isOnlineMeeting eq true and start/dateTime ge '${now}'&$top=50&$orderby=start/dateTime`,
  );
  const events = result?.value || [];
  return events.map((event: any) => ({
    id: event.id,
    subject: event.subject || "Untitled Meeting",
    startDateTime: event.start?.dateTime || "",
    endDateTime: event.end?.dateTime || "",
    joinUrl: event.onlineMeeting?.joinUrl || event.onlineMeetingUrl || "",
    joinWebUrl: event.onlineMeeting?.joinUrl || event.onlineMeetingUrl || "",
  }));
}

export async function getCalendarEventDetails(
  accessToken: string,
  calendarEventId: string,
): Promise<any> {
  try {
    const event = await graphRequest(
      accessToken,
      `/me/events/${calendarEventId}`,
    );
    return event;
  } catch (err: any) {
    console.log(
      `[Teams] Failed to fetch calendar event ${calendarEventId}:`,
      err.message,
    );
    try {
      const response = await fetch(
        `https://graph.microsoft.com/beta/me/events/${calendarEventId}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (response.ok) return response.json();
    } catch {}
    return null;
  }
}

export async function findOnlineMeetingByJoinUrl(
  accessToken: string,
  joinUrl: string,
): Promise<string | null> {
  if (!joinUrl) return null;
  try {
    const encodedUrl = encodeURIComponent(joinUrl);
    const result = await graphRequest(
      accessToken,
      `/me/onlineMeetings?$filter=JoinWebUrl eq '${joinUrl}'`,
    );
    if (result?.value?.length > 0) {
      return result.value[0].id;
    }
  } catch (err: any) {
    console.log(
      `[Teams] findOnlineMeetingByJoinUrl failed (v1.0):`,
      err.message,
    );
    try {
      const response = await fetch(
        `https://graph.microsoft.com/beta/me/onlineMeetings?$filter=JoinWebUrl eq '${encodeURIComponent(joinUrl)}'`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (response.ok) {
        const data = await response.json();
        if (data?.value?.length > 0) return data.value[0].id;
      }
    } catch {}
  }
  return null;
}

export async function getMeetingTranscripts(
  accessToken: string,
  meetingId: string,
): Promise<TeamsTranscript[]> {
  const result = await graphRequest(
    accessToken,
    `/communications/onlineMeetings/${meetingId}/transcripts`,
  );
  return result?.value || [];
}

export async function getTranscriptContent(
  accessToken: string,
  meetingId: string,
  transcriptId: string,
): Promise<string> {
  const response = await fetch(
    `${GRAPH_API_URL}/communications/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content?$format=text/vtt`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch transcript content (${response.status}): ${errorText}`,
    );
  }

  const vttContent = await response.text();
  return parseVttToPlainText(vttContent);
}

function parseVttToPlainText(vtt: string): string {
  const lines = vtt.split("\n");
  const textLines: string[] = [];
  let currentSpeaker = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed === "WEBVTT" ||
      trimmed.includes("-->") ||
      /^\d+$/.test(trimmed)
    ) {
      continue;
    }
    const speakerMatch = trimmed.match(/^<v\s+([^>]+)>(.*)<\/v>$/);
    if (speakerMatch) {
      const speaker = speakerMatch[1];
      const text = speakerMatch[2].trim();
      if (speaker !== currentSpeaker) {
        currentSpeaker = speaker;
        textLines.push(`\n${speaker}:`);
      }
      textLines.push(text);
    } else {
      textLines.push(trimmed);
    }
  }

  return textLines.join("\n").trim();
}

export async function updateCalendarEvent(
  accessToken: string,
  calendarEventId: string,
  updates: {
    subject?: string;
    startTime?: string;
    endTime?: string;
    attendees?: string[];
    description?: string;
    timeZone?: string;
  },
): Promise<any> {
  const body: any = {};
  const tz = updates.timeZone || "UTC";

  if (updates.subject) body.subject = updates.subject;
  if (updates.description) body.body = { contentType: "text", content: updates.description };
  if (updates.startTime) {
    const cleanDt = updates.startTime.replace(/[Z]$/i, "").replace(/[+-]\d{2}:\d{2}$/, "").split(".")[0];
    body.start = { dateTime: cleanDt, timeZone: tz };
  }
  if (updates.endTime) {
    const cleanDt = updates.endTime.replace(/[Z]$/i, "").replace(/[+-]\d{2}:\d{2}$/, "").split(".")[0];
    body.end = { dateTime: cleanDt, timeZone: tz };
  }
  if (updates.attendees) {
    body.attendees = updates.attendees.map((email: string) => ({
      emailAddress: { address: email },
      type: "required",
    }));
  }

  console.log(`[Teams] Updating calendar event ${calendarEventId}:`, JSON.stringify(body));
  return graphRequest(accessToken, `/me/events/${calendarEventId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function getUserProfile(accessToken: string) {
  return graphRequest(accessToken, "/me");
}

export async function getCalendarEvents(accessToken: string) {
  const now = new Date().toISOString();
  const futureDate = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = await graphRequest(
    accessToken,
    `/me/calendarView?startDateTime=${now}&endDateTime=${futureDate}&$filter=isOnlineMeeting eq true&$orderby=start/dateTime&$top=50`,
  );
  return result?.value || [];
}
