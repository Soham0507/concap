const ZOOM_API_URL = "https://api.zoom.us/v2";

const tokenStore: Map<string, { accessToken: string; refreshToken: string; expiresAt: number }> = new Map();

export function storeToken(userId: string, accessToken: string, refreshToken: string, expiresIn: number = 3600) {
  tokenStore.set(userId, {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000 - 60000,
  });
}

export function getValidToken(userId: string): string | null {
  const entry = tokenStore.get(userId);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) return null;
  return entry.accessToken;
}

export function getStoredRefreshToken(userId: string): string | null {
  return tokenStore.get(userId)?.refreshToken || null;
}

export function removeToken(userId: string): void {
  tokenStore.delete(userId);
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}> {
  const clientId = process.env.ZOOM_CLIENT_ID || "";
  const clientSecret = process.env.ZOOM_CLIENT_SECRET || "";
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(`Zoom token refresh error: ${data.error}`);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in || 3600,
  };
}

async function zoomRequest(accessToken: string, path: string, options: RequestInit = {}): Promise<any> {
  const url = path.startsWith("http") ? path : `${ZOOM_API_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Zoom API error (${response.status}): ${errText}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

export interface ZoomMeetingResponse {
  id: number;
  uuid: string;
  topic: string;
  start_time: string;
  duration: number;
  join_url: string;
  start_url: string;
  status: string;
}

export async function createMeeting(
  accessToken: string,
  topic: string,
  startTime: string,
  duration: number,
  description: string = "",
  timeZone: string = "UTC",
): Promise<ZoomMeetingResponse> {
  console.log(`[Zoom] Creating meeting: ${topic}, start=${startTime}, duration=${duration}min, tz=${timeZone}`);

  const body: any = {
    topic,
    type: 2,
    start_time: startTime,
    duration,
    timezone: timeZone,
    settings: {
      host_video: true,
      participant_video: true,
      join_before_host: true,
      mute_upon_entry: false,
      auto_recording: "cloud",
    },
  };

  if (description) {
    body.agenda = description;
  }

  const result = await zoomRequest(accessToken, "/users/me/meetings", {
    method: "POST",
    body: JSON.stringify(body),
  });

  console.log(`[Zoom] Meeting created: id=${result.id}, joinUrl=${result.join_url}`);
  return result;
}

export async function listMeetings(accessToken: string): Promise<ZoomMeetingResponse[]> {
  const result = await zoomRequest(accessToken, "/users/me/meetings?type=upcoming&page_size=50");
  return result.meetings || [];
}

export async function getMeeting(accessToken: string, meetingId: string): Promise<ZoomMeetingResponse> {
  return await zoomRequest(accessToken, `/meetings/${meetingId}`);
}

export async function updateMeeting(
  accessToken: string,
  meetingId: string,
  updates: {
    topic?: string;
    start_time?: string;
    duration?: number;
    agenda?: string;
    timezone?: string;
  },
): Promise<void> {
  console.log(`[Zoom] Updating meeting ${meetingId}:`, JSON.stringify(updates));
  await zoomRequest(accessToken, `/meetings/${meetingId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
  console.log(`[Zoom] Meeting ${meetingId} updated successfully`);
}

export async function deleteMeeting(accessToken: string, meetingId: string): Promise<void> {
  console.log(`[Zoom] Deleting meeting ${meetingId}`);
  await zoomRequest(accessToken, `/meetings/${meetingId}`, {
    method: "DELETE",
  });
  console.log(`[Zoom] Meeting ${meetingId} deleted`);
}

export async function getRecordings(accessToken: string, meetingId: string): Promise<any> {
  try {
    return await zoomRequest(accessToken, `/meetings/${meetingId}/recordings`);
  } catch {
    return null;
  }
}

export async function fetchTranscript(accessToken: string, meetingId: string): Promise<string | null> {
  console.log(`[Zoom] Fetching transcript for meeting ${meetingId}`);

  try {
    const recordings = await zoomRequest(accessToken, `/meetings/${meetingId}/recordings`);

    if (!recordings || !recordings.recording_files) {
      console.log(`[Zoom] No recordings found for meeting ${meetingId}`);
      return null;
    }

    const transcriptFile = recordings.recording_files.find(
      (f: any) => f.file_type === "TRANSCRIPT" && f.status === "completed"
    );

    if (transcriptFile && transcriptFile.download_url) {
      console.log(`[Zoom] Found TRANSCRIPT file, downloading...`);
      const response = await fetch(`${transcriptFile.download_url}?access_token=${accessToken}`);
      if (response.ok) {
        const vttContent = await response.text();
        const plainText = parseVttToPlainText(vttContent);
        console.log(`[Zoom] Transcript fetched successfully (${plainText.length} chars)`);
        return plainText;
      }
    }

    const audioTranscript = recordings.recording_files.find(
      (f: any) => f.recording_type === "audio_transcript" && f.status === "completed"
    );

    if (audioTranscript && audioTranscript.download_url) {
      console.log(`[Zoom] Found audio_transcript file, downloading...`);
      const response = await fetch(`${audioTranscript.download_url}?access_token=${accessToken}`);
      if (response.ok) {
        const vttContent = await response.text();
        const plainText = parseVttToPlainText(vttContent);
        console.log(`[Zoom] Audio transcript fetched successfully (${plainText.length} chars)`);
        return plainText;
      }
    }

    const ccFile = recordings.recording_files.find(
      (f: any) => f.file_type === "CC" && f.status === "completed"
    );

    if (ccFile && ccFile.download_url) {
      console.log(`[Zoom] Found CC (closed caption) file, downloading...`);
      const response = await fetch(`${ccFile.download_url}?access_token=${accessToken}`);
      if (response.ok) {
        const vttContent = await response.text();
        const plainText = parseVttToPlainText(vttContent);
        console.log(`[Zoom] CC transcript fetched successfully (${plainText.length} chars)`);
        return plainText;
      }
    }

    console.log(`[Zoom] No transcript files found among ${recordings.recording_files.length} recording files. Types: ${recordings.recording_files.map((f: any) => `${f.file_type}/${f.recording_type}`).join(", ")}`);
    return null;
  } catch (err: any) {
    console.log(`[Zoom] Error fetching transcript: ${err.message}`);
    return null;
  }
}

function parseVttToPlainText(vtt: string): string {
  const lines = vtt.split("\n");
  const textLines: string[] = [];
  let currentSpeaker = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "WEBVTT") continue;
    if (trimmed.match(/^\d+$/)) continue;
    if (trimmed.match(/^\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}/)) continue;
    if (trimmed.startsWith("NOTE")) continue;
    if (trimmed.startsWith("Kind:") || trimmed.startsWith("Language:")) continue;

    const speakerMatch = trimmed.match(/^([^:]+):\s*(.+)$/);
    if (speakerMatch) {
      const speaker = speakerMatch[1].trim();
      const text = speakerMatch[2].trim();
      if (speaker !== currentSpeaker) {
        currentSpeaker = speaker;
        textLines.push(`\n${speaker}: ${text}`);
      } else {
        textLines.push(text);
      }
    } else {
      textLines.push(trimmed);
    }
  }

  return textLines.join(" ").replace(/\n /g, "\n").replace(/  +/g, " ").trim();
}

export async function sendMeetingInvitations(
  attendeeEmails: string[],
  meetingTopic: string,
  joinUrl: string,
  startTime: string,
  duration: number,
  timeZone: string,
): Promise<void> {
  if (attendeeEmails.length === 0) return;

  try {
    const { sendEmail } = await import("./email-service");

    const startDate = new Date(startTime);
    const formattedDate = startDate.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone,
    });
    const formattedTime = startDate.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    });
    const tzAbbr = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(startDate)
      .find(p => p.type === "timeZoneName")?.value || timeZone;

    for (const email of attendeeEmails) {
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #2D8CFF; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h2 style="margin: 0;">Meeting Invitation</h2>
          </div>
          <div style="padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
            <h3 style="color: #1a1a1a; margin-top: 0;">${meetingTopic}</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280; width: 100px;">Date:</td>
                <td style="padding: 8px 0; color: #1a1a1a;">${formattedDate}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Time:</td>
                <td style="padding: 8px 0; color: #1a1a1a;">${formattedTime} ${tzAbbr}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Duration:</td>
                <td style="padding: 8px 0; color: #1a1a1a;">${duration} minutes</td>
              </tr>
            </table>
            <div style="margin-top: 24px; text-align: center;">
              <a href="${joinUrl}" style="display: inline-block; background: #2D8CFF; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: bold;">
                Join Zoom Meeting
              </a>
            </div>
            <p style="margin-top: 16px; font-size: 13px; color: #6b7280; text-align: center;">
              Or copy this link: <a href="${joinUrl}" style="color: #2D8CFF;">${joinUrl}</a>
            </p>
          </div>
          <p style="font-size: 12px; color: #9ca3af; text-align: center; margin-top: 16px;">
            Sent via Requisor
          </p>
        </div>
      `;

      const sent = await sendEmail({
        to: email,
        from: "Requisor Meetings <team@requisor.io>",
        subject: `Meeting Invitation: ${meetingTopic}`,
        html,
        text: `You are invited to a meeting.\n\nMeeting: ${meetingTopic}\nDate: ${formattedDate}\nTime: ${formattedTime} ${tzAbbr}\nDuration: ${duration} minutes\n\nJoin Meeting: ${joinUrl}`,
      });

      if (sent) {
        console.log(`[Zoom] Invitation sent to ${email}`);
      } else {
        console.log(`[Zoom] Failed to send invitation to ${email} (email service may not be configured)`);
      }
    }
  } catch (err: any) {
    console.log(`[Zoom] Email invitation error: ${err.message}`);
  }
}
