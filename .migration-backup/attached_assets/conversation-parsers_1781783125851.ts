/**
 * Normalizers that turn raw pasted/uploaded chat content into clean,
 * conversation-ready transcripts for the Conversations Hub.
 *
 * Supported kinds:
 *   - "plain"   – passthrough (whitespace-trimmed)
 *   - "slack"   – Slack JSON export (array of message objects from a
 *                 channel-export file, or the raw text copy of a channel)
 *   - "discord" – DiscordChatExporter JSON export (single channel) or
 *                 a raw `discord.js` messages array
 *   - "email"   – a single .eml RFC822 message or a forwarded email
 *                 pasted as plain text. Also handles trivial mbox
 *                 (multiple `From ` separated messages).
 */

export type ConversationKind = "plain" | "slack" | "discord" | "email";

export interface NormalizedConversation {
  title: string;
  content: string;
  participants: string[];
  meetingDate: Date | null;
  source: string; // 'manual' | 'slack' | 'discord' | 'email'
  channelName?: string | null;
  threadId?: string | null;
}

interface SlackJsonMessage {
  type?: string;
  user?: string;
  user_profile?: { real_name?: string; display_name?: string; name?: string };
  username?: string;
  text?: string;
  ts?: string | number;
}

interface DiscordExporterMessage {
  id?: string;
  timestamp?: string;
  content?: string;
  author?: { name?: string; nickname?: string; username?: string };
}

interface DiscordExporterFile {
  channel?: { name?: string; category?: string; topic?: string };
  guild?: { name?: string };
  messages?: DiscordExporterMessage[];
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tsToDate(ts: string | number | undefined): Date | null {
  if (ts === undefined || ts === null) return null;
  const num = typeof ts === "number" ? ts : parseFloat(String(ts));
  if (!isFinite(num)) return null;
  // Slack uses seconds-with-decimal; if too small treat as seconds, else ms.
  const ms = num < 1e12 ? num * 1000 : num;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d;
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr.filter((x) => x && x.trim().length > 0)));
}

// ---------- Slack ----------

function normalizeSlackJson(parsed: unknown): NormalizedConversation | null {
  let messages: SlackJsonMessage[] | null = null;
  let channelName: string | undefined;

  if (Array.isArray(parsed)) {
    messages = parsed as SlackJsonMessage[];
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.messages)) {
      messages = obj.messages as SlackJsonMessage[];
    }
    if (typeof obj.channel === "string") {
      channelName = obj.channel;
    } else if (obj.channel && typeof obj.channel === "object") {
      const channelObj = obj.channel as Record<string, unknown>;
      if (typeof channelObj.name === "string") channelName = channelObj.name;
    }
  }

  if (!messages || messages.length === 0) return null;

  const lines: string[] = [];
  const participants: string[] = [];
  let earliest: Date | null = null;
  let latest: Date | null = null;

  for (const m of messages) {
    if (m.type && m.type !== "message") continue;
    const text = (m.text || "").trim();
    if (!text) continue;
    const author =
      m.user_profile?.real_name ||
      m.user_profile?.display_name ||
      m.user_profile?.name ||
      m.username ||
      m.user ||
      "Unknown";
    participants.push(author);
    const date = tsToDate(m.ts);
    if (date) {
      if (!earliest || date < earliest) earliest = date;
      if (!latest || date > latest) latest = date;
    }
    const stamp = date ? date.toISOString().replace("T", " ").slice(0, 16) : "";
    lines.push(`${stamp ? `[${stamp}] ` : ""}${author}: ${text}`);
  }

  if (lines.length === 0) return null;

  return {
    title: channelName ? `Slack: #${channelName}` : "Slack conversation",
    content: lines.join("\n"),
    participants: uniq(participants),
    meetingDate: latest || earliest,
    source: "slack",
    channelName: channelName || null,
  };
}

// ---------- Discord ----------

function normalizeDiscordJson(parsed: unknown): NormalizedConversation | null {
  let messages: DiscordExporterMessage[] | null = null;
  let channelName: string | undefined;
  let guildName: string | undefined;

  if (Array.isArray(parsed)) {
    messages = parsed as DiscordExporterMessage[];
  } else if (parsed && typeof parsed === "object") {
    const file = parsed as DiscordExporterFile;
    if (Array.isArray(file.messages)) messages = file.messages;
    channelName = file.channel?.name;
    guildName = file.guild?.name;
  }

  if (!messages || messages.length === 0) return null;

  const lines: string[] = [];
  const participants: string[] = [];
  let earliest: Date | null = null;
  let latest: Date | null = null;

  for (const m of messages) {
    const text = (m.content || "").trim();
    if (!text) continue;
    const author =
      m.author?.nickname ||
      m.author?.name ||
      m.author?.username ||
      "Unknown";
    participants.push(author);
    let date: Date | null = null;
    if (m.timestamp) {
      const d = new Date(m.timestamp);
      if (!isNaN(d.getTime())) date = d;
    }
    if (date) {
      if (!earliest || date < earliest) earliest = date;
      if (!latest || date > latest) latest = date;
    }
    const stamp = date ? date.toISOString().replace("T", " ").slice(0, 16) : "";
    lines.push(`${stamp ? `[${stamp}] ` : ""}${author}: ${text}`);
  }

  if (lines.length === 0) return null;

  const titleParts: string[] = [];
  if (guildName) titleParts.push(guildName);
  if (channelName) titleParts.push(`#${channelName}`);
  const title = titleParts.length > 0
    ? `Discord: ${titleParts.join(" ")}`
    : "Discord conversation";

  return {
    title,
    content: lines.join("\n"),
    participants: uniq(participants),
    meetingDate: latest || earliest,
    source: "discord",
    channelName: channelName || null,
  };
}

// ---------- Email (.eml / forwarded paste / mbox) ----------

interface ParsedEmail {
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  date?: Date | null;
  body: string;
}

function decodeQuotedPrintable(input: string, charset = "utf-8"): string {
  // Strip soft line breaks then decode =XX hex bytes against the declared
  // charset so non-UTF-8 emails (latin1, etc.) round-trip cleanly.
  const collapsed = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < collapsed.length; i++) {
    const ch = collapsed[i];
    if (ch === "=" && i + 2 < collapsed.length) {
      const hex = collapsed.slice(i + 1, i + 3);
      if (/^[A-Fa-f0-9]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  try {
    return new TextDecoder(charset, { fatal: false }).decode(
      new Uint8Array(bytes),
    );
  } catch {
    return Buffer.from(bytes).toString("utf-8");
  }
}

function decodeBase64(input: string, charset = "utf-8"): string {
  try {
    const buf = Buffer.from(input.replace(/\s+/g, ""), "base64");
    try {
      return new TextDecoder(charset, { fatal: false }).decode(buf);
    } catch {
      return buf.toString("utf-8");
    }
  } catch {
    return input;
  }
}

function extractCharset(contentType: string): string {
  const m = contentType.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return (m?.[1] || "utf-8").toLowerCase();
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>(?!\n)/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseSingleEmail(raw: string): ParsedEmail {
  // Split headers / body on first blank line.
  const splitIdx = raw.search(/\r?\n\r?\n/);
  let headerBlock = "";
  let bodyBlock = raw;
  if (splitIdx > -1) {
    headerBlock = raw.slice(0, splitIdx);
    bodyBlock = raw.slice(splitIdx).replace(/^\r?\n\r?\n/, "");
  }

  // Unfold continuation header lines.
  const headerLines = headerBlock
    .replace(/\r?\n[ \t]+/g, " ")
    .split(/\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2].trim();
  }

  const enc = (headers["content-transfer-encoding"] || "").toLowerCase();
  const ctype = (headers["content-type"] || "").toLowerCase();
  const charset = extractCharset(ctype);

  let body = bodyBlock;
  if (enc.includes("quoted-printable")) body = decodeQuotedPrintable(body, charset);
  if (enc.includes("base64")) body = decodeBase64(body, charset);

  // Strip multipart wrappers crudely: take the text/plain part if present,
  // else convert the first text/html part. Real MIME parsing is overkill
  // for the lightweight ingest path.
  const boundaryMatch = ctype.match(/boundary="?([^";]+)"?/);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?`));
    let plain = "";
    let html = "";
    for (const part of parts) {
      const partHeaderEnd = part.search(/\r?\n\r?\n/);
      if (partHeaderEnd === -1) continue;
      const partHeaders = part.slice(0, partHeaderEnd).toLowerCase();
      let partBody = part.slice(partHeaderEnd).replace(/^\r?\n\r?\n/, "");
      const partCharset = extractCharset(partHeaders);
      if (partHeaders.includes("quoted-printable")) {
        partBody = decodeQuotedPrintable(partBody, partCharset);
      } else if (partHeaders.includes("base64")) {
        partBody = decodeBase64(partBody, partCharset);
      }
      if (partHeaders.includes("text/plain") && !plain) plain = partBody;
      else if (partHeaders.includes("text/html") && !html) html = partBody;
    }
    if (plain.trim()) body = plain;
    else if (html.trim()) body = htmlToText(html);
  } else if (ctype.includes("text/html")) {
    body = htmlToText(body);
  }

  let date: Date | null = null;
  if (headers.date) {
    const d = new Date(headers.date);
    if (!isNaN(d.getTime())) date = d;
  }

  const splitAddrs = (s: string) =>
    s.split(",").map((x) => x.trim()).filter(Boolean);

  return {
    from: headers.from,
    to: headers.to ? splitAddrs(headers.to) : undefined,
    cc: headers.cc ? splitAddrs(headers.cc) : undefined,
    subject: headers.subject,
    date,
    body: body.trim(),
  };
}

function looksLikeEml(raw: string): boolean {
  const head = raw.slice(0, 2000);
  // RFC822-ish: at least one of From/Subject/Date headers near the top.
  return /^(From|Subject|Date|To|Message-ID|Return-Path):/im.test(head);
}

function normalizeEmail(raw: string): NormalizedConversation | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Trivial mbox handling – split on lines starting with "From " (mbox From_).
  let blocks: string[];
  if (/^From [^\r\n]+\r?\n/m.test(trimmed)) {
    blocks = trimmed
      .split(/(?:^|\r?\n)From [^\r\n]+\r?\n/m)
      .map((b) => b.trim())
      .filter(Boolean);
  } else {
    blocks = [trimmed];
  }

  const emails = blocks
    .map(parseSingleEmail)
    .filter((e) => e.body || e.subject);

  if (emails.length === 0) return null;

  const participants: string[] = [];
  const lines: string[] = [];
  let earliest: Date | null = null;
  let latest: Date | null = null;
  let firstSubject: string | undefined;

  for (const e of emails) {
    if (e.from) participants.push(e.from);
    if (e.to) participants.push(...e.to);
    if (e.cc) participants.push(...e.cc);
    if (e.date) {
      if (!earliest || e.date < earliest) earliest = e.date;
      if (!latest || e.date > latest) latest = e.date;
    }
    if (!firstSubject && e.subject) firstSubject = e.subject;

    const header: string[] = [];
    if (e.subject) header.push(`Subject: ${e.subject}`);
    if (e.from) header.push(`From: ${e.from}`);
    if (e.to && e.to.length) header.push(`To: ${e.to.join(", ")}`);
    if (e.cc && e.cc.length) header.push(`Cc: ${e.cc.join(", ")}`);
    if (e.date) header.push(`Date: ${e.date.toISOString()}`);

    lines.push(header.join("\n"));
    lines.push("");
    lines.push(e.body || "");
    lines.push("\n---\n");
  }

  return {
    title: firstSubject ? `Email: ${firstSubject}` : "Email thread",
    content: lines.join("\n").trim(),
    participants: uniq(participants),
    meetingDate: latest || earliest,
    source: "email",
  };
}

// ---------- Public entry point ----------

export function normalizeConversation(
  rawContent: string,
  kind: ConversationKind,
  fallbackTitle?: string,
): NormalizedConversation {
  const trimmed = (rawContent || "").trim();
  if (!trimmed) {
    return {
      title: fallbackTitle || "Empty conversation",
      content: "",
      participants: [],
      meetingDate: null,
      source: kind === "plain" ? "manual" : kind,
    };
  }

  if (kind === "slack") {
    const parsed = safeJsonParse(trimmed);
    if (parsed) {
      const result = normalizeSlackJson(parsed);
      if (result) {
        if (fallbackTitle) result.title = fallbackTitle;
        return result;
      }
    }
    // Fall through to plain text passthrough but tag as slack source.
    return {
      title: fallbackTitle || "Slack conversation",
      content: trimmed,
      participants: [],
      meetingDate: null,
      source: "slack",
    };
  }

  if (kind === "discord") {
    const parsed = safeJsonParse(trimmed);
    if (parsed) {
      const result = normalizeDiscordJson(parsed);
      if (result) {
        if (fallbackTitle) result.title = fallbackTitle;
        return result;
      }
    }
    return {
      title: fallbackTitle || "Discord conversation",
      content: trimmed,
      participants: [],
      meetingDate: null,
      source: "discord",
    };
  }

  if (kind === "email") {
    if (looksLikeEml(trimmed)) {
      const result = normalizeEmail(trimmed);
      if (result) {
        if (fallbackTitle) result.title = fallbackTitle;
        return result;
      }
    }
    // Forwarded plain-text email: keep as-is, just tag it.
    return {
      title: fallbackTitle || "Email thread",
      content: trimmed,
      participants: [],
      meetingDate: null,
      source: "email",
    };
  }

  return {
    title: fallbackTitle || "Pasted conversation",
    content: trimmed,
    participants: [],
    meetingDate: null,
    source: "manual",
  };
}
