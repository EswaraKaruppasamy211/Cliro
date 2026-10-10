export interface SpeechPreferences {
  enabled: boolean;
  voiceURI: string;
  rate: number;
  pitch: number;
  volume: number;
}

export type SpeechPlaybackState = 'IDLE' | 'SPEAKING' | 'INTERRUPTED' | 'ERROR';

export type VoiceCommand =
  | { type: 'stop'; remainingCommand: string }
  | { type: 'repeat' };

export const DEFAULT_SPEECH_PREFERENCES: SpeechPreferences = {
  enabled: false,
  voiceURI: '',
  rate: 0.95,
  pitch: 1.05,
  volume: 1
};

const femaleVoiceNames = /\b(female|zira|jenny|aria|samantha|susan|hazel|eva|sara|karen|victoria|heera|priya|neerja|google us english female|google uk english female)\b/i;

export function isFemaleEnglishVoice(voice: SpeechSynthesisVoice | null): boolean {
  return Boolean(voice && /^en(?:-|$)/i.test(voice.lang) && femaleVoiceNames.test(voice.name));
}

export function selectSpeechVoice(
  voices: SpeechSynthesisVoice[],
  preferredVoiceURI = ''
): SpeechSynthesisVoice | null {
  if (preferredVoiceURI) {
    const preferred = voices.find(voice => voice.voiceURI === preferredVoiceURI);
    if (preferred) return preferred;
  }
  const english = voices.filter(voice => /^en(?:-|$)/i.test(voice.lang));
  if (english.length === 0) return voices.find(voice => voice.default) || voices[0] || null;

  const female = english.filter(voice => isFemaleEnglishVoice(voice));
  const priority = ['en-IN', 'en-US', 'en-GB'];
  for (const locale of priority) {
    const match = female.find(voice => voice.lang.toLowerCase() === locale.toLowerCase());
    if (match) return match;
  }
  if (female.length > 0) return female[0];
  return english.find(voice => voice.default) || english[0];
}

export function sanitizeSpeechText(text: string): string {
  let speechText = text.replace(/```[\s\S]*?```/g, ' ');
  if (/^\s*(?:\{|\[)/.test(speechText)) {
    try {
      const parsed: unknown = JSON.parse(speechText);
      const extract = (value: unknown): string => {
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) return value.map(extract).filter(Boolean).join('. ');
        if (!value || typeof value !== 'object') return '';
        const record = value as Record<string, unknown>;
        for (const key of ['answer', 'response', 'message', 'content', 'text']) {
          if (key in record) {
            const readable = extract(record[key]);
            if (readable) return readable;
          }
        }
        return '';
      };
      const readable = extract(parsed);
      if (readable) speechText = readable;
      else if (parsed && typeof parsed === 'object') speechText = '';
    } catch {
      // Continue sanitizing ordinary text that happens to start with a bracket.
    }
  }
  const withoutMetadata = speechText
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:source|provider|verified(?: at)?|retrieved(?: at)?|duration|analysis method|files scanned|debug|error code|metadata|raw json|tool output)\s*:/i.test(line))
    .join(' ');

  return withoutMetadata
    .replace(/!\[.*?\]\([^)]*\)/g, ' ')
    .replace(/\[(.{1,120}?)\]\((?:https?:\/\/|mailto:)[^)]+\)/gi, '$1')
    .replace(/<https?:\/\/[^>]+>/gi, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\[(?:\^?\d+(?:\s*[,;-]\s*\^?\d+)*|source|citation)]/gi, ' ')
    .replace(/\(\s*\d+(?:\s*[,;-]\s*\d+)*\s*\)/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[(.+?)\]\(([^)]+)\)/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/([*_~])/g, ' ')
    .replace(/[|{}"]/g, ' ')
    .replace(/[\x5B\x5D]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyVoiceCommand(input: string): VoiceCommand | null {
  const normalized = input
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(?:please )?(?:repeat|repeat that|say that again|what did you say)$/.test(normalized)) {
    return { type: 'repeat' };
  }

  const stopMatch = normalized.match(
    /^(?:please )?(?:stop(?: talking| speaking)?|be quiet|silence|quiet|enough|cancel speech)(?: (?:and|then))?(?: (.*))?$/
  );
  if (!stopMatch) return null;
  const remainingCommand = (stopMatch[1] || '')
    .replace(/^(?:(?:please|now|right now) )+/, '')
    .trim();
  return { type: 'stop', remainingCommand };
}

export function splitSpeechChunks(text: string, maxLength = 240): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];
  const sentences = typeof Intl.Segmenter === 'function'
    ? Array.from(
      new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(cleaned),
      part => part.segment
    )
    : cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  const chunks: string[] = [];
  let current = '';

  const appendWords = (sentence: string) => {
    for (const word of sentence.trim().split(/\s+/)) {
      if (!word) continue;
      const next = current ? `${current} ${word}` : word;
      if (next.length > maxLength && current) {
        chunks.push(current);
        current = word;
      } else {
        current = next;
      }
    }
  };

  for (const sentence of sentences) {
    const normalized = sentence.trim();
    if (!normalized) continue;
    const combined = current ? `${current} ${normalized}` : normalized;
    if (combined.length <= maxLength) {
      current = combined;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (normalized.length <= maxLength) {
      current = normalized;
      continue;
    }
    appendWords(normalized);
    if (current) {
      chunks.push(current);
      current = '';
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

interface SpeechSynthesisLike {
  cancel(): void;
  speak(utterance: SpeechSynthesisUtterance): void;
}

export class LocalSpeechQueue {
  private readonly spokenIds = new Set<string>();
  private chunks: string[] = [];
  private generation = 0;
  private readonly synthesis: SpeechSynthesisLike;
  private readonly createUtterance: (text: string) => SpeechSynthesisUtterance;
  private readonly getVoice: () => SpeechSynthesisVoice | null;
  private readonly onStateChange: (state: SpeechPlaybackState) => void;
  private state: SpeechPlaybackState = 'IDLE';

  constructor(
    synthesis: SpeechSynthesisLike,
    createUtterance: (text: string) => SpeechSynthesisUtterance,
    getVoice: () => SpeechSynthesisVoice | null,
    onStateChange: (state: SpeechPlaybackState) => void
  ) {
    this.synthesis = synthesis;
    this.createUtterance = createUtterance;
    this.getVoice = getVoice;
    this.onStateChange = onStateChange;
  }

  speak(text: string, id: string, preferences: SpeechPreferences): boolean {
    if (this.spokenIds.has(id)) return false;
    const chunks = splitSpeechChunks(sanitizeSpeechText(text));
    if (chunks.length === 0) return false;

    this.cancelCurrent();
    this.spokenIds.add(id);
    if (this.spokenIds.size > 128) {
      const oldest = this.spokenIds.values().next().value;
      if (oldest) this.spokenIds.delete(oldest);
    }
    this.chunks = chunks;
    const generation = this.generation;
    this.setState('SPEAKING');
    this.speakNext(generation, preferences);
    return true;
  }

  stop(): void {
    this.cancelCurrent();
    this.setState('IDLE');
  }

  interrupt(): boolean {
    if (this.state !== 'SPEAKING') return false;
    this.cancelCurrent();
    this.setState('INTERRUPTED');
    return true;
  }

  private cancelCurrent(): void {
    this.generation += 1;
    this.chunks = [];
    this.synthesis.cancel();
  }

  private speakNext(generation: number, preferences: SpeechPreferences): void {
    if (generation !== this.generation || this.chunks.length === 0) {
      if (generation === this.generation) this.setState('IDLE');
      return;
    }

    const text = this.chunks.shift();
    if (!text) return;
    const utterance = this.createUtterance(text);
    utterance.voice = this.getVoice();
    utterance.rate = preferences.rate;
    utterance.pitch = preferences.pitch;
    utterance.volume = preferences.volume;
    let settled = false;
    utterance.onend = () => {
      if (settled) return;
      settled = true;
      this.speakNext(generation, preferences);
    };
    utterance.onerror = () => {
      if (settled || generation !== this.generation) return;
      settled = true;
      this.generation += 1;
      this.chunks = [];
      this.setState('ERROR');
    };
    try {
      this.synthesis.speak(utterance);
    } catch {
      this.generation += 1;
      this.chunks = [];
      this.setState('ERROR');
    }
  }

  private setState(state: SpeechPlaybackState): void {
    this.state = state;
    this.onStateChange(state);
  }
}
