const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_DOCS_API = "https://docs.googleapis.com/v1";
const GOOGLE_MEET_API = "https://meet.googleapis.com/v2";

const tokenCache = new Map<string, { accessToken: string; refreshToken: string; expiresAt: number }>();

export function storeToken(userId: string, accessToken: string, refreshToken: string, expiresIn: number = 3600) {
  tokenCache.set(userId, {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000 - 60000,
  });
}

export function getValidToken(userId: string): string | null {
  const cached = tokenCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }
  return null;
}

export function getCachedRefreshToken(userId: string): string | null {
  return tokenCache.get(userId)?.refreshToken || null;
}

export function removeToken(userId: string): void {
  tokenCache.delete(userId);
}

export async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json();
  if (data.error) {
    throw new Error(`Google refresh error: ${data.error} - ${data.error_description || ""}`);
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in || 3600,
  };
}

export async function getUserEmail(accessToken: string): Promise<string> {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json();
  return data.email || "";
}

export interface GoogleMeetEvent {
  eventId: string;
  meetLink: string;
  subject: string;
  startTime: string;
  endTime: string;
  organizerEmail: string;
  htmlLink: string;
}

export async function createMeetingWithGoogleMeet(
  accessToken: string,
  subject: string,
  startTime: string,
  endTime: string,
  attendeeEmails: string[] = [],
  description: string = "",
  timeZone: string = "UTC"
): Promise<GoogleMeetEvent> {
  const attendees = attendeeEmails.map(email => ({ email }));

  const eventBody = {
    summary: subject,
    description,
    start: {
      dateTime: startTime,
      timeZone,
    },
    end: {
      dateTime: endTime,
      timeZone,
    },
    attendees,
    conferenceData: {
      createRequest: {
        requestId: `requisor-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };

  console.log(`[Google Meet] Creating calendar event with Meet link: ${subject}`);

  const response = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(eventBody),
    }
  );

  const data = await response.json();

  if (data.error) {
    console.error("[Google Meet] Calendar API error:", data.error);
    throw new Error(`Google Calendar API error: ${data.error.message || data.error.code}`);
  }

  const meetLink = data.conferenceData?.entryPoints?.find(
    (ep: any) => ep.entryPointType === "video"
  )?.uri || data.hangoutLink || "";

  console.log(`[Google Meet] Event created: eventId=${data.id}, meetLink=${meetLink}`);

  const organizerEmail = data.organizer?.email || "";

  return {
    eventId: data.id,
    meetLink,
    subject: data.summary || subject,
    startTime: data.start?.dateTime || startTime,
    endTime: data.end?.dateTime || endTime,
    organizerEmail,
    htmlLink: data.htmlLink || "",
  };
}

export async function updateCalendarEvent(
  accessToken: string,
  eventId: string,
  subject: string,
  startTime: string,
  endTime: string,
  attendeeEmails: string[] = [],
  description: string = "",
  timeZone: string = "UTC"
): Promise<GoogleMeetEvent> {
  const attendees = attendeeEmails.map(email => ({ email }));

  const eventBody = {
    summary: subject,
    description,
    start: {
      dateTime: startTime,
      timeZone,
    },
    end: {
      dateTime: endTime,
      timeZone,
    },
    attendees,
  };

  console.log(`[Google Meet] Updating calendar event ${eventId}: ${subject}`);

  const response = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/primary/events/${eventId}?sendUpdates=all`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(eventBody),
    }
  );

  const data = await response.json();

  if (data.error) {
    console.error("[Google Meet] Calendar API update error:", data.error);
    throw new Error(`Google Calendar API error: ${data.error.message || data.error.code}`);
  }

  const meetLink = data.conferenceData?.entryPoints?.find(
    (ep: any) => ep.entryPointType === "video"
  )?.uri || data.hangoutLink || "";

  console.log(`[Google Meet] Event updated: eventId=${data.id}, meetLink=${meetLink}`);

  return {
    eventId: data.id,
    meetLink,
    subject: data.summary || subject,
    startTime: data.start?.dateTime || startTime,
    endTime: data.end?.dateTime || endTime,
    organizerEmail: data.organizer?.email || "",
    htmlLink: data.htmlLink || "",
  };
}

export async function listUpcomingMeetings(accessToken: string, maxResults: number = 20): Promise<any[]> {
  const now = new Date().toISOString();
  const response = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/primary/events?timeMin=${encodeURIComponent(now)}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime&conferenceDataVersion=1`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  const data = await response.json();
  if (data.error) {
    throw new Error(`Google Calendar API error: ${data.error.message}`);
  }
  return (data.items || []).filter((event: any) =>
    event.conferenceData?.conferenceSolution?.key?.type === "hangoutsMeet" ||
    event.hangoutLink
  );
}

export async function getCalendarEvent(accessToken: string, eventId: string): Promise<any> {
  const response = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/primary/events/${eventId}?conferenceDataVersion=1`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  const data = await response.json();
  if (data.error) {
    throw new Error(`Google Calendar API error: ${data.error.message}`);
  }
  return data;
}

export async function deleteCalendarEvent(accessToken: string, eventId: string): Promise<void> {
  const response = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/primary/events/${eventId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!response.ok && response.status !== 204) {
    const data = await response.json().catch(() => ({}));
    throw new Error(`Failed to delete event: ${data.error?.message || response.statusText}`);
  }
}

export interface DriveTranscriptFile {
  fileId: string;
  name: string;
  mimeType: string;
  createdTime: string;
  webViewLink: string;
}

export interface TranscriptResult {
  content: string;
  source: string;
  documentId?: string;
  conferenceRecordId?: string;
  meetingCode?: string;
}

export function extractMeetingCode(meetLink?: string): string | null {
  if (!meetLink) return null;
  const match = meetLink.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
  return match ? match[1] : null;
}

async function fetchGoogleDocContent(accessToken: string, documentId: string): Promise<string> {
  console.log(`[Google Meet Transcript] fetchGoogleDocContent: Starting for docId="${documentId}"`);

  const metaUrl = `${GOOGLE_DRIVE_API}/files/${documentId}?fields=id,name,mimeType,trashed`;
  const metaResponse = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!metaResponse.ok) {
    const metaBody = await metaResponse.text().catch(() => "");
    console.error(`[Google Meet Transcript] fetchGoogleDocContent: File metadata lookup FAILED for "${documentId}" — status=${metaResponse.status}, body=${metaBody}`);
    throw new Error(`File not accessible (${metaResponse.status}): ${documentId}`);
  }

  const meta = await metaResponse.json();
  console.log(`[Google Meet Transcript] fetchGoogleDocContent: File found — name="${meta.name}", mimeType="${meta.mimeType}", trashed=${meta.trashed}`);

  if (meta.trashed) {
    throw new Error(`File "${meta.name}" is in trash`);
  }

  const isGoogleDoc = meta.mimeType === "application/vnd.google-apps.document";
  const isWordDoc = meta.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || meta.mimeType === "application/msword";

  if (isGoogleDoc) {
    const exportUrl = `${GOOGLE_DRIVE_API}/files/${documentId}/export?mimeType=text/plain`;
    console.log(`[Google Meet Transcript] fetchGoogleDocContent: Exporting Google Doc as text/plain`);
    const response = await fetch(exportUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.error(`[Google Meet Transcript] fetchGoogleDocContent: Export FAILED — status=${response.status}, body=${errBody}`);
      throw new Error(`Failed to export Google Doc "${meta.name}" (${response.status}): ${response.statusText}`);
    }
    const text = await response.text();
    console.log(`[Google Meet Transcript] fetchGoogleDocContent: Export SUCCESS — ${text.length} chars`);
    return text.replace(/\x00/g, "").trim();
  }

  if (isWordDoc) {
    const downloadUrl = `${GOOGLE_DRIVE_API}/files/${documentId}?alt=media`;
    console.log(`[Google Meet Transcript] fetchGoogleDocContent: Downloading Word doc for mammoth parsing (mimeType="${meta.mimeType}")`);
    const dlResponse = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!dlResponse.ok) {
      const errBody = await dlResponse.text().catch(() => "");
      console.error(`[Google Meet Transcript] fetchGoogleDocContent: Word doc download FAILED — status=${dlResponse.status}, body=${errBody}`);
      throw new Error(`Failed to download Word doc "${meta.name}" (${dlResponse.status}): ${dlResponse.statusText}`);
    }
    try {
      const mammoth = await import("mammoth");
      const arrayBuffer = await dlResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value.replace(/\x00/g, "").trim();
      console.log(`[Google Meet Transcript] fetchGoogleDocContent: Word doc parsed SUCCESS — ${text.length} chars`);
      return text;
    } catch (err: any) {
      console.error(`[Google Meet Transcript] fetchGoogleDocContent: mammoth parse FAILED for "${meta.name}": ${err.message}`);
      throw new Error(`Could not extract text from Word document "${meta.name}"`);
    }
  }

  const downloadUrl = `${GOOGLE_DRIVE_API}/files/${documentId}?alt=media`;
  console.log(`[Google Meet Transcript] fetchGoogleDocContent: Downloading file as media (mimeType="${meta.mimeType}")`);
  const dlResponse = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!dlResponse.ok) {
    const errBody = await dlResponse.text().catch(() => "");
    console.error(`[Google Meet Transcript] fetchGoogleDocContent: Download FAILED — status=${dlResponse.status}, body=${errBody}`);
    throw new Error(`Failed to download file "${meta.name}" (${dlResponse.status}): ${dlResponse.statusText}`);
  }

  const contentType = dlResponse.headers.get("content-type") || "";
  if (contentType.includes("application/vnd.openxmlformats") || contentType.includes("application/msword")) {
    try {
      console.log(`[Google Meet Transcript] fetchGoogleDocContent: Content-Type suggests Word doc, trying mammoth parse`);
      const mammoth = await import("mammoth");
      const arrayBuffer = await dlResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value.replace(/\x00/g, "").trim();
      console.log(`[Google Meet Transcript] fetchGoogleDocContent: Fallback mammoth parse SUCCESS — ${text.length} chars`);
      return text;
    } catch (err: any) {
      console.log(`[Google Meet Transcript] fetchGoogleDocContent: Fallback mammoth parse failed: ${err.message}`);
    }
  }

  const text = await dlResponse.text();
  console.log(`[Google Meet Transcript] fetchGoogleDocContent: Raw text download — ${text.length} chars`);
  return text.replace(/\x00/g, "").trim();
}

async function driveSearch(accessToken: string, query: string, label: string): Promise<any[]> {
  try {
    console.log(`[Google Meet Transcript] ${label}: query="${query}"`);
    const params = new URLSearchParams({
      q: query,
      fields: "files(id,name,mimeType,createdTime,webViewLink)",
      orderBy: "createdTime desc",
      pageSize: "10",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    const url = `${GOOGLE_DRIVE_API}/files?${params.toString()}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.error(`[Google Meet Transcript] Drive search HTTP error (${label}): status=${response.status}, body=${errBody}`);
      return [];
    }

    const data = await response.json();
    if (data.error) {
      console.error(`[Google Meet Transcript] Drive search API error (${label}):`, JSON.stringify(data.error));
      return [];
    }

    const files = data.files || [];
    console.log(`[Google Meet Transcript] ${label}: Found ${files.length} file(s)`);
    for (const f of files) {
      console.log(`[Google Meet Transcript]   -> "${f.name}" (id=${f.id}, mimeType=${f.mimeType}, created=${f.createdTime})`);
    }
    return files;
  } catch (err: any) {
    console.error(`[Google Meet Transcript] Drive search exception (${label}): ${err.message}`);
    return [];
  }
}

export async function fetchTranscriptPipeline(
  accessToken: string,
  meeting: {
    meetLink?: string | null;
    subject: string;
    startTime: Date | string;
    endTime: Date | string;
    calendarEventId?: string | null;
    transcriptDocId?: string | null;
    conferenceRecordId?: string | null;
    meetingCode?: string | null;
  }
): Promise<TranscriptResult | null> {
  const meetingCode = meeting.meetingCode || extractMeetingCode(meeting.meetLink || undefined);
  const startTime = typeof meeting.startTime === "string" ? meeting.startTime : meeting.startTime.toISOString();
  const endTime = typeof meeting.endTime === "string" ? meeting.endTime : meeting.endTime.toISOString();

  console.log(`[Google Meet Transcript] Starting pipeline for meeting: subject="${meeting.subject}", code=${meetingCode}`);

  // Diagnostic: Check token scopes and Drive access
  try {
    const tokenInfoResp = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${accessToken}`);
    const tokenInfo = await tokenInfoResp.json();
    console.log(`[Google Meet Transcript] Token scopes: ${tokenInfo.scope || "unknown"}`);
    console.log(`[Google Meet Transcript] Token email: ${tokenInfo.email || "unknown"}`);
    console.log(`[Google Meet Transcript] Token expires_in: ${tokenInfo.expires_in || "unknown"}`);
  } catch (err: any) {
    console.log(`[Google Meet Transcript] Could not check token info: ${err.message}`);
  }

  // Diagnostic: List recent Google Docs to verify Drive access works
  try {
    const diagFiles = await driveSearch(
      accessToken,
      `mimeType='application/vnd.google-apps.document' and trashed=false`,
      "Diagnostic: List recent Google Docs"
    );
    console.log(`[Google Meet Transcript] Diagnostic: Token can see ${diagFiles.length} Google Docs in Drive`);
  } catch (err: any) {
    console.log(`[Google Meet Transcript] Diagnostic Drive check failed: ${err.message}`);
  }

  // Step 0: If we already have a stored transcriptDocId, fetch directly
  if (meeting.transcriptDocId) {
    try {
      console.log(`[Google Meet Transcript] Step 0: Fetching stored transcript doc ${meeting.transcriptDocId}`);
      const content = await fetchGoogleDocContent(accessToken, meeting.transcriptDocId);
      if (content.length > 0) {
        console.log(`[Google Meet Transcript] Step 0 SUCCESS: Retrieved transcript from stored docId`);
        return {
          content,
          source: "stored_doc_id",
          documentId: meeting.transcriptDocId,
          conferenceRecordId: meeting.conferenceRecordId || undefined,
          meetingCode: meetingCode || undefined,
        };
      }
    } catch (err: any) {
      console.log(`[Google Meet Transcript] Step 0 failed: ${err.message}`);
    }
  }

  // Step 1: Conference Record API (primary method)
  if (meetingCode) {
    try {
      console.log(`[Google Meet Transcript] Step 1: Conference Record API for code "${meetingCode}"`);
      const crResponse = await fetch(
        `${GOOGLE_MEET_API}/conferenceRecords?filter=space.meeting_code%3D%22${meetingCode}%22`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const crData = await crResponse.json();

      if (crData.conferenceRecords && crData.conferenceRecords.length > 0) {
        for (const record of crData.conferenceRecords) {
          const recordName = record.name;
          const conferenceRecordId = recordName.replace("conferenceRecords/", "");
          console.log(`[Google Meet Transcript] Found conference record: ${recordName}`);

          const trResponse = await fetch(
            `${GOOGLE_MEET_API}/${recordName}/transcripts`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const trData = await trResponse.json();

          if (trData.transcripts && trData.transcripts.length > 0) {
            for (const transcript of trData.transcripts) {
              const docId = transcript.docsDestination?.document;
              if (docId) {
                const documentId = docId.includes("/") ? docId.split("/").pop() : docId;
                console.log(`[Google Meet Transcript] Step 1: Found transcript doc ${documentId}`);
                try {
                  const content = await fetchGoogleDocContent(accessToken, documentId!);
                  if (content.length > 0) {
                    console.log(`[Google Meet Transcript] Step 1 SUCCESS: Conference Record API`);
                    return {
                      content,
                      source: "conference_record_api",
                      documentId: documentId!,
                      conferenceRecordId,
                      meetingCode,
                    };
                  }
                } catch (err: any) {
                  console.log(`[Google Meet Transcript] Step 1: Could not fetch doc ${documentId}: ${err.message}`);
                }
              }
            }
          } else {
            console.log(`[Google Meet Transcript] Step 1: No transcripts in conference record ${recordName}`);
          }
        }
      } else {
        console.log(`[Google Meet Transcript] Step 1: No conference records found for code "${meetingCode}"`);
      }
    } catch (err: any) {
      console.log(`[Google Meet Transcript] Step 1 failed: ${err.message}`);
    }
  }

  // Step 2: Calendar event attachments
  if (meeting.calendarEventId) {
    try {
      console.log(`[Google Meet Transcript] Step 2: Calendar event attachments for ${meeting.calendarEventId}`);
      const eventResponse = await fetch(
        `${GOOGLE_CALENDAR_API}/calendars/primary/events/${meeting.calendarEventId}?fields=attachments`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const eventData = await eventResponse.json();
      if (eventData.attachments) {
        for (const attachment of eventData.attachments) {
          if (
            attachment.title?.toLowerCase().includes("transcript") ||
            attachment.mimeType === "application/vnd.google-apps.document"
          ) {
            const fileId = attachment.fileId || attachment.fileUrl?.match(/\/d\/([^/]+)/)?.[1];
            if (fileId) {
              console.log(`[Google Meet Transcript] Step 2: Found attachment "${attachment.title}" (${fileId})`);
              try {
                const content = await fetchGoogleDocContent(accessToken, fileId);
                if (content.length > 0) {
                  console.log(`[Google Meet Transcript] Step 2 SUCCESS: Calendar attachment`);
                  return {
                    content,
                    source: "calendar_attachment",
                    documentId: fileId,
                    meetingCode: meetingCode || undefined,
                  };
                }
              } catch (err: any) {
                console.log(`[Google Meet Transcript] Step 2: Could not fetch attachment ${fileId}: ${err.message}`);
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.log(`[Google Meet Transcript] Step 2 failed: ${err.message}`);
    }
  }

  // Step 3a: Drive search by meeting code in filename (e.g. "bwf-mans-vzt - Transcript")
  if (meetingCode) {
    try {
      console.log(`[Google Meet Transcript] Step 3a: Drive search by meeting code in filename "${meetingCode}"`);
      const files = await driveSearch(
        accessToken,
        `name contains '${meetingCode}' and (mimeType='application/vnd.google-apps.document' or mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType='application/msword') and trashed=false`,
        "Step 3a: Drive name contains meeting code"
      );
      if (files.length > 0) {
        console.log(`[Google Meet Transcript] Step 3a: Found ${files.length} file(s) with meeting code in name`);
        for (const file of files) {
          console.log(`[Google Meet Transcript] Step 3a: Trying file "${file.name}" (id=${file.id}, mimeType=${file.mimeType})`);
          try {
            const content = await fetchGoogleDocContent(accessToken, file.id);
            if (content.length > 0) {
              console.log(`[Google Meet Transcript] Step 3a SUCCESS: "${file.name}" — ${content.length} chars`);
              return {
                content,
                source: "drive_name_meeting_code",
                documentId: file.id,
                meetingCode,
              };
            }
          } catch (err: any) {
            console.log(`[Google Meet Transcript] Step 3a: Could not read "${file.name}" (${file.id}): ${err.message}`);
          }
        }
      } else {
        console.log(`[Google Meet Transcript] Step 3a: No Google Docs found with meeting code in name, trying without mimeType filter...`);
        const anyFiles = await driveSearch(
          accessToken,
          `name contains '${meetingCode}' and trashed=false`,
          "Step 3a-alt: name contains meeting code (any type)"
        );
        if (anyFiles.length > 0) {
          console.log(`[Google Meet Transcript] Step 3a-alt: Found ${anyFiles.length} file(s) of any type with meeting code in name`);
          for (const file of anyFiles) {
            console.log(`[Google Meet Transcript] Step 3a-alt: Trying file "${file.name}" (id=${file.id}, mimeType=${file.mimeType})`);
            try {
              const content = await fetchGoogleDocContent(accessToken, file.id);
              if (content.length > 0) {
                console.log(`[Google Meet Transcript] Step 3a-alt SUCCESS: "${file.name}" — ${content.length} chars`);
                return {
                  content,
                  source: "drive_name_meeting_code",
                  documentId: file.id,
                  meetingCode,
                };
              }
            } catch (err: any) {
              console.log(`[Google Meet Transcript] Step 3a-alt: Could not read "${file.name}" (${file.id}): ${err.message}`);
            }
          }
        } else {
          console.log(`[Google Meet Transcript] Step 3a-alt: No files of ANY type found with meeting code "${meetingCode}" in name`);
        }
      }
    } catch (err: any) {
      console.log(`[Google Meet Transcript] Step 3a failed: ${err.message}`);
    }
  }

  // Step 3b: Drive search by meeting code in fullText content
  if (meetingCode) {
    try {
      console.log(`[Google Meet Transcript] Step 3b: Drive search by meeting code in content "${meetingCode}"`);
      const files = await driveSearch(
        accessToken,
        `fullText contains '${meetingCode}' and mimeType='application/vnd.google-apps.document' and trashed=false`,
        "Step 3b: Drive fullText meeting code"
      );
      for (const file of files) {
        console.log(`[Google Meet Transcript] Step 3b: Trying file "${file.name}" (id=${file.id}, mimeType=${file.mimeType})`);
        try {
          const content = await fetchGoogleDocContent(accessToken, file.id);
          if (content.length > 0) {
            console.log(`[Google Meet Transcript] Step 3b SUCCESS: "${file.name}" — ${content.length} chars`);
            return {
              content,
              source: "drive_meeting_code",
              documentId: file.id,
              meetingCode,
            };
          }
        } catch (err: any) {
          console.log(`[Google Meet Transcript] Step 3b: Could not read "${file.name}" (${file.id}): ${err.message}`);
        }
      }
    } catch (err: any) {
      console.log(`[Google Meet Transcript] Step 3b failed: ${err.message}`);
    }
  }

  // Step 4: Name + date filter (tight window: start - 2h to end + 2h)
  {
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    const searchStart = new Date(startDate.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const searchEnd = new Date(endDate.getTime() + 2 * 60 * 60 * 1000).toISOString();

    console.log(`[Google Meet Transcript] Step 4: Name + date filter (${searchStart} to ${searchEnd})`);
    const files = await driveSearch(
      accessToken,
      `name contains 'Transcript' and mimeType='application/vnd.google-apps.document' and trashed=false and createdTime > '${searchStart}' and createdTime < '${searchEnd}'`,
      "Step 4: Transcript + tight date"
    );

    if (files.length > 0) {
      files.sort((a: any, b: any) => {
        const aScore = scoreTranscriptFile(a, meeting.subject, meetingCode, startTime);
        const bScore = scoreTranscriptFile(b, meeting.subject, meetingCode, startTime);
        return bScore - aScore;
      });

      for (const file of files.slice(0, 3)) {
        try {
          const content = await fetchGoogleDocContent(accessToken, file.id);
          if (content.length > 0) {
            const codeInContent = meetingCode ? content.includes(meetingCode) : false;
            if (codeInContent || files.length === 1) {
              console.log(`[Google Meet Transcript] Step 4 SUCCESS: "${file.name}" (code in content: ${codeInContent})`);
              return {
                content,
                source: "drive_name_date",
                documentId: file.id,
                meetingCode: meetingCode || undefined,
              };
            }
          }
        } catch (err: any) {
          console.log(`[Google Meet Transcript] Step 4: Could not read file ${file.id}: ${err.message}`);
        }
      }

      if (files.length > 0) {
        try {
          const content = await fetchGoogleDocContent(accessToken, files[0].id);
          if (content.length > 0) {
            console.log(`[Google Meet Transcript] Step 4 SUCCESS (best match): "${files[0].name}"`);
            return {
              content,
              source: "drive_name_date",
              documentId: files[0].id,
              meetingCode: meetingCode || undefined,
            };
          }
        } catch {}
      }
    }
  }

  // Step 5: Broad search fallback
  {
    console.log(`[Google Meet Transcript] Step 5: Broad search fallback`);
    const files = await driveSearch(
      accessToken,
      `name contains 'Transcript' and mimeType='application/vnd.google-apps.document' and trashed=false`,
      "Step 5: Broad transcript search"
    );

    if (files.length > 0) {
      files.sort((a: any, b: any) => {
        const aScore = scoreTranscriptFile(a, meeting.subject, meetingCode, startTime);
        const bScore = scoreTranscriptFile(b, meeting.subject, meetingCode, startTime);
        return bScore - aScore;
      });

      for (const file of files.slice(0, 3)) {
        try {
          const content = await fetchGoogleDocContent(accessToken, file.id);
          if (content.length > 0 && meetingCode && content.includes(meetingCode)) {
            console.log(`[Google Meet Transcript] Step 5 SUCCESS: "${file.name}" contains meeting code`);
            return {
              content,
              source: "drive_broad_search",
              documentId: file.id,
              meetingCode,
            };
          }
        } catch {}
      }

      try {
        const content = await fetchGoogleDocContent(accessToken, files[0].id);
        if (content.length > 0) {
          console.log(`[Google Meet Transcript] Step 5 SUCCESS (best scored): "${files[0].name}"`);
          return {
            content,
            source: "drive_broad_search",
            documentId: files[0].id,
            meetingCode: meetingCode || undefined,
          };
        }
      } catch {}
    }
  }

  console.log(`[Google Meet Transcript] Pipeline complete: no transcript found`);
  return null;
}

function scoreTranscriptFile(file: any, subject?: string, meetingCode?: string | null, meetingDate?: string): number {
  let score = 0;
  const name = (file.name || "").toLowerCase();

  if (meetingCode && name.includes(meetingCode)) score += 50;
  if (name.includes("transcript")) score += 10;
  if (subject) {
    const subjectLower = subject.toLowerCase();
    if (name.includes(subjectLower)) score += 20;
    const words = subjectLower.split(/\s+/).filter((w: string) => w.length > 3);
    score += words.filter((w: string) => name.includes(w)).length * 3;
  }
  if (meetingDate && file.createdTime) {
    const diff = Math.abs(new Date(file.createdTime).getTime() - new Date(meetingDate).getTime());
    const hoursDiff = diff / (1000 * 60 * 60);
    if (hoursDiff < 1) score += 15;
    else if (hoursDiff < 4) score += 10;
    else if (hoursDiff < 24) score += 5;
  }
  return score;
}

export async function findMeetingTranscripts(accessToken: string, meetLink?: string, subject?: string, meetingDate?: string, calendarEventId?: string): Promise<DriveTranscriptFile[]> {
  const allFiles: DriveTranscriptFile[] = [];
  const seenIds = new Set<string>();

  const addFiles = (files: any[]) => {
    for (const f of files) {
      if (!seenIds.has(f.id)) {
        seenIds.add(f.id);
        allFiles.push({
          fileId: f.id,
          name: f.name,
          mimeType: f.mimeType,
          createdTime: f.createdTime,
          webViewLink: f.webViewLink || "",
        });
      }
    }
  };

  let dateFilter = "";
  if (meetingDate) {
    const meetDate = new Date(meetingDate);
    const before = new Date(meetDate.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const after = new Date(meetDate.getTime() + 2 * 60 * 60 * 1000).toISOString();
    dateFilter = ` and createdTime > '${before}' and createdTime < '${after}'`;
  }

  const transcriptFiles = await driveSearch(
    accessToken,
    `name contains 'Transcript' and mimeType='application/vnd.google-apps.document' and trashed=false${dateFilter}`,
    "Legacy findMeetingTranscripts"
  );
  addFiles(transcriptFiles);

  return allFiles;
}


export async function getTranscriptContent(accessToken: string, fileId: string, mimeType: string): Promise<string> {
  const isGoogleDoc = mimeType === "application/vnd.google-apps.document";
  const isWordDoc = mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" 
    || mimeType === "application/msword";

  if (isGoogleDoc || isWordDoc) {
    const exportUrl = `${GOOGLE_DRIVE_API}/files/${fileId}/export?mimeType=text/plain`;
    const response = await fetch(exportUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) {
      const text = await response.text();
      const clean = text.replace(/\x00/g, "").trim();
      if (clean.length > 0) return clean;
    }
  }

  const downloadUrl = `${GOOGLE_DRIVE_API}/files/${fileId}?alt=media`;
  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch transcript content: ${response.statusText}`);
  }

  if (isWordDoc || mimeType === "application/msword") {
    try {
      const mammoth = await import("mammoth");
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const result = await mammoth.extractRawText({ buffer });
      return result.value.replace(/\x00/g, "").trim();
    } catch (err: any) {
      console.log(`[Google Meet] mammoth parse failed for ${fileId}:`, err.message);
      throw new Error("Could not extract text from Word document");
    }
  }

  const text = await response.text();
  const clean = text.replace(/\x00/g, "").trim();

  const binaryCheck = clean.substring(0, 100);
  if (binaryCheck.includes("PK") && binaryCheck.includes("[Content_Types]")) {
    try {
      const reDownload = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const mammoth = await import("mammoth");
      const arrayBuffer = await reDownload.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const result = await mammoth.extractRawText({ buffer });
      return result.value.replace(/\x00/g, "").trim();
    } catch (err: any) {
      console.log(`[Google Meet] Fallback mammoth parse failed for ${fileId}:`, err.message);
      throw new Error("File appears to be a binary document that could not be parsed");
    }
  }

  return clean;
}

export async function importCalendarMeetings(accessToken: string, daysBack: number = 90, daysForward: number = 30): Promise<GoogleMeetEvent[]> {
  const now = new Date();
  const timeMin = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + daysForward * 24 * 60 * 60 * 1000).toISOString();

  console.log(`[Google Meet] Importing calendar events from ${timeMin} to ${timeMax}`);

  const meetEvents: GoogleMeetEvent[] = [];
  let pageToken: string | undefined = undefined;
  let pageCount = 0;

  do {
    const url = new URL(`${GOOGLE_CALENDAR_API}/calendars/primary/events`);
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("conferenceDataVersion", "1");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json();
    if (data.error) {
      throw new Error(`Google Calendar API error: ${data.error.message}`);
    }

    for (const event of (data.items || [])) {
      const meetLink = event.conferenceData?.entryPoints?.find(
        (ep: any) => ep.entryPointType === "video"
      )?.uri || event.hangoutLink;

      if (meetLink) {
        meetEvents.push({
          eventId: event.id,
          meetLink,
          subject: event.summary || "Untitled Meeting",
          startTime: event.start?.dateTime || event.start?.date || "",
          endTime: event.end?.dateTime || event.end?.date || "",
          organizerEmail: event.organizer?.email || "",
          htmlLink: event.htmlLink || "",
        });
      }
    }

    pageToken = data.nextPageToken;
    pageCount++;
    console.log(`[Google Meet] Page ${pageCount}: fetched ${data.items?.length || 0} events, ${meetEvents.length} with Meet links so far`);
  } while (pageToken && pageCount < 20);

  console.log(`[Google Meet] Found ${meetEvents.length} total calendar events with Meet links across ${pageCount} page(s)`);
  return meetEvents;
}

export async function findMeetingRecordings(accessToken: string, subject?: string): Promise<any[]> {
  let query = "(mimeType='video/mp4' or mimeType='video/webm') and trashed=false";

  if (subject) {
    query += ` and name contains '${subject.replace(/'/g, "\\'")}'`;
  }

  const response = await fetch(
    `${GOOGLE_DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,createdTime,webViewLink,size)&orderBy=createdTime desc&pageSize=10`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  const data = await response.json();
  if (data.error) {
    console.error("[Google Meet] Drive recording search error:", data.error);
    return [];
  }
  return data.files || [];
}
