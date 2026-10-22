/**
 * SRT subtitle parser.
 *
 * Strips cue numbers and timestamp lines from SRT subtitle text and returns
 * the plain transcript text. Speaker tags / HTML-ish tags inside cues are
 * preserved as plain text but stripped of angle brackets.
 *
 * Optional rich mode (`preserveStructure: true`):
 *   - Keeps speaker prefixes — `<v Alex>Hello</v>` becomes `Alex: Hello` and
 *     existing inline prefixes like "Alex: …" are left intact.
 *   - Inserts coarse `[HH:MM]` timestamp markers whenever a cue starts in a
 *     new minute, so downstream AI can cite roughly when something was said.
 *
 * Also exposes a heuristic detector so other ingestion paths (e.g. pasted
 * conversation content) can auto-clean SRT input transparently.
 */

const TIMESTAMP_LINE_REGEX =
  /^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3}).*$/;

const CUE_NUMBER_LINE_REGEX = /^\s*\d+\s*$/;

const TAG_REGEX = /<\/?[^>]+>/g;

const BRACKET_TAG_REGEX = /\{\\[^}]+\}/g;

// WebVTT-style voice tag, e.g. <v Alex>Hello</v> or <v.loud Alex Smith>Hi</v>.
const VOICE_TAG_OPEN_REGEX = /<v(?:\.[^\s>]+)?\s+([^>]+)>/i;

export interface ParseSrtOptions {
  /**
   * When true, keep speaker labels (converting `<v Speaker>` voice tags into
   * `Speaker:` prefixes) and insert minute-level `[HH:MM]` markers between
   * cues. Defaults to false to preserve the original lossy-clean behaviour.
   */
  preserveStructure?: boolean;
}

interface ParsedCue {
  startMs: number;
  endMs: number;
  rawLines: string[];
}

export function looksLikeSrt(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const sample = text.slice(0, 4000);
  // SRT must contain at least one timestamp arrow line. That alone is a
  // strong signal — some SRT variants omit the leading numeric cue line.
  const timestampMatches = sample.match(
    /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/g,
  );
  if (!timestampMatches || timestampMatches.length === 0) return false;
  return true;
}

function parseTimestampToMs(line: string): { startMs: number; endMs: number } | null {
  const m = line.match(TIMESTAMP_LINE_REGEX);
  if (!m) return null;
  const [, h1, m1, s1, ms1, h2, m2, s2, ms2] = m;
  const startMs =
    parseInt(h1, 10) * 3600000 +
    parseInt(m1, 10) * 60000 +
    parseInt(s1, 10) * 1000 +
    parseInt(ms1.padEnd(3, "0").slice(0, 3), 10);
  const endMs =
    parseInt(h2, 10) * 3600000 +
    parseInt(m2, 10) * 60000 +
    parseInt(s2, 10) * 1000 +
    parseInt(ms2.padEnd(3, "0").slice(0, 3), 10);
  return { startMs, endMs };
}

function formatMinuteMarker(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hh = hours.toString().padStart(2, "0");
  const mm = minutes.toString().padStart(2, "0");
  return `[${hh}:${mm}]`;
}

function cleanCueText(rawLines: string[], preserveStructure: boolean): string {
  const out: string[] = [];
  for (const raw of rawLines) {
    let line = raw;

    if (preserveStructure) {
      // Convert WebVTT voice tags into "Speaker:" prefixes before stripping
      // remaining tags. We only do this when the line *starts* with one to
      // avoid clobbering accidental tag-like text in the middle of a cue.
      const trimmed = line.trim();
      const voice = trimmed.match(VOICE_TAG_OPEN_REGEX);
      if (voice && trimmed.toLowerCase().startsWith("<v")) {
        const speaker = voice[1].trim();
        // Drop the opening voice tag and any matching closing </v>.
        const after = trimmed.slice(voice[0].length).replace(/<\/v>\s*$/i, "");
        line = `${speaker}: ${after}`;
      }
    }

    const cleaned = line
      .replace(TAG_REGEX, "")
      .replace(BRACKET_TAG_REGEX, "")
      .trim();
    if (cleaned !== "") out.push(cleaned);
  }
  return out.join("\n");
}

function parseCueBlocks(srtText: string): ParsedCue[] {
  // Strip BOM.
  const text = srtText.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);

  const cues: ParsedCue[] = [];
  let i = 0;
  while (i < lines.length) {
    // Skip blank lines between cues.
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;

    // Optional cue-number line followed by a timestamp line.
    let timestamp: { startMs: number; endMs: number } | null = null;
    if (CUE_NUMBER_LINE_REGEX.test(lines[i].trim())) {
      // Peek ahead for a timestamp on the next non-blank line.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length) {
        const ts = parseTimestampToMs(lines[j].trim());
        if (ts) {
          timestamp = ts;
          i = j + 1;
        }
      }
    }
    if (!timestamp) {
      const ts = parseTimestampToMs(lines[i].trim());
      if (ts) {
        timestamp = ts;
        i += 1;
      }
    }

    if (!timestamp) {
      // Not a recognisable cue header — skip the line so we don't loop forever.
      i += 1;
      continue;
    }

    // Collect text lines until the next blank line or EOF.
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i += 1;
    }

    cues.push({
      startMs: timestamp.startMs,
      endMs: timestamp.endMs,
      rawLines: textLines,
    });
  }

  return cues;
}

export function parseSrt(srtText: string, options: ParseSrtOptions = {}): string {
  if (!srtText || typeof srtText !== "string") return "";

  const preserveStructure = options.preserveStructure === true;
  const cues = parseCueBlocks(srtText);

  const output: string[] = [];
  let lastMinuteEmitted = -1;

  for (const cue of cues) {
    const cleaned = cleanCueText(cue.rawLines, preserveStructure);
    if (cleaned === "") continue;

    if (preserveStructure) {
      const minute = Math.floor(cue.startMs / 60000);
      if (minute !== lastMinuteEmitted) {
        output.push(formatMinuteMarker(cue.startMs));
        lastMinuteEmitted = minute;
      }
      output.push(cleaned);
    } else {
      output.push(cleaned);
      output.push("");
    }
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Parse if input looks like SRT, otherwise return original text unchanged.
 * Useful for transcript ingestion endpoints that may receive either.
 */
export function maybeParseSrt(text: string, options: ParseSrtOptions = {}): string {
  if (looksLikeSrt(text)) return parseSrt(text, options);
  return text;
}
