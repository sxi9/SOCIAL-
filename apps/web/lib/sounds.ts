// Sounds (FEATURES #103, SPECS §v1.0c): ringtone for incoming calls,
// ringback while my outgoing call rings, and a text tone for new messages —
// all synthesized with the Web Audio API. No audio files, no third-party
// anything (CLAUDE.md rule 7/10): every tone is a few oscillator notes, so
// the "bundled sounds" of the spec are bundled as code.
//
// Rules this module enforces (PSYCHOLOGY.md + the spec):
//   * a tone is a device preference → stored per browser in localStorage,
//     never on the server (nobody else learns your sound choices);
//   * respects the server-side per-chat mute (participants.muted_until) and
//     the per-chat override here; blocked senders never reach the client in
//     the first place (server-enforced), so there is nothing to filter;
//   * never dings for the chat you are looking at, for your own sends, for
//     system rows, or while you are on a call;
//   * the ringer follows the store: it rings exactly while `callInvite` is
//     set (and no call is live) and plays ringback exactly while my outgoing
//     call is in phase 'ringing' — lib/webrtc stays the sole writer of call
//     state, this module only listens.
//
// Browser autoplay policy: an AudioContext may only produce sound after a
// user gesture. `installSoundEngine()` unlocks it on the first pointer/key
// event; a ring that arrives before that still vibrates (where supported)
// and starts sounding the moment the page is first touched.
import * as store from './store';

export type RingChoice = 'classic' | 'soft' | 'pulse' | 'off';
export type ChatSoundOverride = 'on' | 'off';

export interface SoundPrefs {
  ring: RingChoice;
  /** Text tone for new messages (global default; per-chat overrides win). */
  text: boolean;
  /** Vibrate with the ringtone (Android/Chrome; no-op elsewhere). */
  vibrate: boolean;
  /** Per-chat text-tone override: absent = follow `text`. */
  perChat: Record<string, ChatSoundOverride>;
}

export const RING_CHOICES: { key: RingChoice; label: string }[] = [
  { key: 'classic', label: 'Classic' },
  { key: 'soft', label: 'Soft' },
  { key: 'pulse', label: 'Pulse' },
  { key: 'off', label: 'Off' },
];

const STORAGE_KEY = 'bc.sounds.v1';
const DEFAULTS: SoundPrefs = { ring: 'classic', text: true, vibrate: true, perChat: {} };
/** Two messages landing together make one ding, not a drum roll. */
const TEXT_TONE_MIN_GAP_MS = 1500;
/** Android vibration pattern per ring cycle (ms on/off…). */
const RING_VIBRATE_PATTERN = [400, 250, 400, 1150];

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

let cached: SoundPrefs | null = null;

export function getSoundPrefs(): SoundPrefs {
  if (cached) return cached;
  let parsed: Partial<SoundPrefs> = {};
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) parsed = JSON.parse(raw) as Partial<SoundPrefs>;
  } catch {
    /* no storage / bad JSON → defaults */
  }
  const ring = RING_CHOICES.some((c) => c.key === parsed.ring) ? (parsed.ring as RingChoice) : DEFAULTS.ring;
  cached = {
    ring,
    text: typeof parsed.text === 'boolean' ? parsed.text : DEFAULTS.text,
    vibrate: typeof parsed.vibrate === 'boolean' ? parsed.vibrate : DEFAULTS.vibrate,
    perChat: parsed.perChat && typeof parsed.perChat === 'object' ? { ...parsed.perChat } : {},
  };
  return cached;
}

export function setSoundPrefs(patch: Partial<Omit<SoundPrefs, 'perChat'>>): SoundPrefs {
  const next = { ...getSoundPrefs(), ...patch };
  persist(next);
  // A ring in progress follows the new choice immediately (switch tone /
  // silence it) — the store-driven evaluator re-reads prefs.
  evaluate();
  return next;
}

export function getChatSoundOverride(conversationId: string): ChatSoundOverride | null {
  return getSoundPrefs().perChat[conversationId] ?? null;
}

export function setChatSoundOverride(conversationId: string, value: ChatSoundOverride | null): void {
  const prefs = getSoundPrefs();
  const perChat = { ...prefs.perChat };
  if (value === null) delete perChat[conversationId];
  else perChat[conversationId] = value;
  persist({ ...prefs, perChat });
}

function persist(next: SoundPrefs): void {
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — the in-memory copy still applies this session */
  }
}

// ---------------------------------------------------------------------------
// Audio graph
// ---------------------------------------------------------------------------

type Ctx = AudioContext;
let ctx: Ctx | null = null;
let unlocked = false;

function getCtx(): Ctx | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  } catch {
    return null;
  }
  return ctx;
}

/** Resume the context from a user gesture. Resolves to whether sound can play. */
async function unlock(): Promise<boolean> {
  const c = getCtx();
  if (!c) return false;
  if (c.state !== 'running') {
    try {
      await c.resume();
    } catch {
      /* still suspended */
    }
  }
  unlocked = c.state === 'running';
  return unlocked;
}

type Wave = OscillatorType;

interface Note {
  /** Hz; two frequencies play together (dual-tone ringback, bell partials). */
  freq: number | [number, number];
  /** Seconds from cycle start. */
  at: number;
  /** Seconds the note sustains before its release. */
  dur: number;
  gain?: number;
  wave?: Wave;
  /** Seconds of exponential release after `dur` (default 0.08). */
  release?: number;
}

interface Pattern {
  notes: Note[];
  /** Seconds per loop. */
  cycle: number;
}

// Classic: a telephone-style two-tone trill — six quick alternating pulses,
// then a breath. Unmistakably "a call", at a polite level.
const RING_CLASSIC: Pattern = {
  cycle: 2.6,
  notes: Array.from({ length: 8 }, (_, i) => ({
    freq: i % 2 === 0 ? 880 : 1046.5,
    at: i * 0.11,
    dur: 0.085,
    gain: 0.16,
    wave: 'square' as Wave,
    release: 0.02,
  })),
};

// Soft: a rising bell arpeggio (C5 E5 G5 C6) with long tails — gentle enough
// for an office, still clearly a ring.
const RING_SOFT: Pattern = {
  cycle: 3.2,
  notes: [523.25, 659.25, 783.99, 1046.5].map((f, i) => ({
    freq: [f, f * 2.01] as [number, number],
    at: i * 0.22,
    dur: 0.12,
    gain: 0.14,
    wave: 'sine' as Wave,
    release: 0.9,
  })),
};

// Pulse: a marimba-like triangle beat — two notes, twice, then rest.
const RING_PULSE: Pattern = {
  cycle: 2.0,
  notes: [0, 0.18, 0.5, 0.68].map((at, i) => ({
    freq: i % 2 === 0 ? 523.25 : 659.25,
    at,
    dur: 0.09,
    gain: 0.2,
    wave: 'triangle' as Wave,
    release: 0.25,
  })),
};

// Ringback (what the CALLER hears): the standard 440 + 480 Hz dual tone,
// 2 s on / 4 s off, quiet — it is reassurance, not an alarm.
const RINGBACK: Pattern = {
  cycle: 6.0,
  notes: [{ freq: [440, 480], at: 0, dur: 2.0, gain: 0.07, wave: 'sine', release: 0.05 }],
};

// Text tone: two quick rising notes, a quarter second in all.
const TEXT_TONE: Pattern = {
  cycle: 0.3,
  notes: [
    { freq: 987.77, at: 0, dur: 0.06, gain: 0.14, wave: 'sine', release: 0.08 },
    { freq: 1318.5, at: 0.09, dur: 0.08, gain: 0.14, wave: 'sine', release: 0.14 },
  ],
};

const RING_PATTERNS: Record<Exclude<RingChoice, 'off'>, Pattern> = {
  classic: RING_CLASSIC,
  soft: RING_SOFT,
  pulse: RING_PULSE,
};

/** Schedule one pass of a pattern starting at context time `t0`. */
function scheduleCycle(c: Ctx, pattern: Pattern, t0: number): void {
  for (const n of pattern.notes) {
    const start = t0 + n.at;
    const release = n.release ?? 0.08;
    const gain = c.createGain();
    gain.connect(c.destination);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(n.gain ?? 0.15, start + 0.012);
    gain.gain.setValueAtTime(n.gain ?? 0.15, start + n.dur);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur + release);
    const freqs = Array.isArray(n.freq) ? n.freq : [n.freq];
    for (const f of freqs) {
      const osc = c.createOscillator();
      osc.type = n.wave ?? 'sine';
      osc.frequency.setValueAtTime(f, start);
      osc.connect(gain);
      osc.start(start);
      osc.stop(start + n.dur + release + 0.02);
    }
  }
}

/** A looping player: schedules the next cycle slightly ahead of time. */
class Loop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  constructor(
    private readonly pattern: Pattern,
    private readonly onCycle?: () => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const c = getCtx();
    if (!c || c.state !== 'running') {
      // Not unlocked yet: keep the loop "running" so unlock() picks it up.
      this.timer = null;
      return;
    }
    this.tick(c.currentTime + 0.05);
  }

  private tick(at: number): void {
    const c = getCtx();
    if (!this.running || !c) return;
    scheduleCycle(c, this.pattern, at);
    this.onCycle?.();
    const next = at + this.pattern.cycle;
    const delayMs = Math.max(0, (next - c.currentTime) * 1000 - 120);
    this.timer = setTimeout(() => this.tick(next), delayMs);
  }

  /** Called after a late unlock: begin sounding if we are meant to be. */
  resume(): void {
    const c = getCtx();
    if (this.running && this.timer === null && c && c.state === 'running') this.tick(c.currentTime + 0.05);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get active(): boolean {
    return this.running;
  }
}

// ---------------------------------------------------------------------------
// Ringer (store-driven)
// ---------------------------------------------------------------------------

let ringer: Loop | null = null;
let ringerChoice: RingChoice | null = null;
let ringback: Loop | null = null;

function vibrateOnce(): void {
  const prefs = getSoundPrefs();
  if (!prefs.vibrate) return;
  try {
    navigator.vibrate?.(RING_VIBRATE_PATTERN);
  } catch {
    /* unsupported */
  }
}

function stopVibrate(): void {
  try {
    navigator.vibrate?.(0);
  } catch {
    /* unsupported */
  }
}

function startRinger(choice: Exclude<RingChoice, 'off'>): void {
  if (ringer && ringerChoice === choice) return;
  stopRinger();
  ringerChoice = choice;
  ringer = new Loop(RING_PATTERNS[choice], vibrateOnce);
  ringer.start();
  // Vibrate even when audio is locked — the phone still buzzes in a pocket.
  if (!unlocked) vibrateOnce();
}

function stopRinger(): void {
  ringer?.stop();
  ringer = null;
  ringerChoice = null;
  stopVibrate();
}

function startRingback(): void {
  if (ringback) return;
  ringback = new Loop(RINGBACK);
  ringback.start();
}

function stopRingback(): void {
  ringback?.stop();
  ringback = null;
}

/** Reconcile the two loops with the store (idempotent; runs on every change). */
function evaluate(): void {
  const s = store.state;
  const live = s.callUi !== null && s.callUi.phase !== 'ended';
  const incoming = s.callInvite !== null && !live;
  const prefs = getSoundPrefs();

  if (incoming && prefs.ring !== 'off') startRinger(prefs.ring);
  else stopRinger();

  const outgoingRinging = live && s.callUi!.outgoing && s.callUi!.phase === 'ringing';
  if (outgoingRinging) startRingback();
  else stopRingback();
}

let installed = false;

/** Boot once from the app shell: unlock-on-gesture + store subscription. */
export function installSoundEngine(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const onGesture = () => {
    void unlock().then((ok) => {
      if (!ok) return;
      ringer?.resume();
      ringback?.resume();
      window.removeEventListener('pointerdown', onGesture);
      window.removeEventListener('keydown', onGesture);
      window.removeEventListener('touchstart', onGesture);
    });
  };
  window.addEventListener('pointerdown', onGesture);
  window.addEventListener('keydown', onGesture);
  window.addEventListener('touchstart', onGesture, { passive: true });
  store.subscribe(evaluate);
  evaluate();
}

// ---------------------------------------------------------------------------
// Text tone
// ---------------------------------------------------------------------------

let lastTextToneAt = 0;

function playPattern(pattern: Pattern): void {
  const c = getCtx();
  if (!c || c.state !== 'running') return;
  scheduleCycle(c, pattern, c.currentTime + 0.01);
}

/** Should a new message in this conversation ding on this device? */
export function shouldDingForMessage(message: {
  conversation_id: string;
  sender_id: string | null;
  type: string;
}): boolean {
  const s = store.state;
  const meId = s.me?.id;
  if (!meId || message.sender_id === null || message.sender_id === meId) return false;
  if (message.type === 'system') return false;
  // Looking at it right now → the bubble IS the notification.
  if (
    s.activeConversationId === message.conversation_id &&
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible'
  ) {
    return false;
  }
  // On a call: nothing competes with the voice channel.
  if (s.callUi !== null && s.callUi.phase !== 'ended') return false;
  // Server-side mute wins over everything (pushGuard parity).
  const conv = s.conversations.get(message.conversation_id);
  const mine = conv?.participants.find((p) => p.user.id === meId);
  if (mine?.muted_until && new Date(mine.muted_until).getTime() > Date.now()) return false;
  const prefs = getSoundPrefs();
  const override = prefs.perChat[message.conversation_id];
  if (override === 'off') return false;
  if (override === 'on') return true;
  return prefs.text;
}

/** Fired from the WS `msg.new` path; all the filtering lives in
 * shouldDingForMessage so the connection layer stays one line. */
export function dingForMessage(message: {
  conversation_id: string;
  sender_id: string | null;
  type: string;
}): void {
  if (!shouldDingForMessage(message)) return;
  const now = Date.now();
  if (now - lastTextToneAt < TEXT_TONE_MIN_GAP_MS) return;
  lastTextToneAt = now;
  playPattern(TEXT_TONE);
}

// ---------------------------------------------------------------------------
// Settings previews
// ---------------------------------------------------------------------------

/** Play one cycle of a ringtone (or the text tone) from a settings button —
 * a user gesture, so this also unlocks the context. */
export async function previewSound(kind: RingChoice | 'text'): Promise<void> {
  if (kind === 'off') return;
  if (!(await unlock())) return;
  playPattern(kind === 'text' ? TEXT_TONE : RING_PATTERNS[kind]);
}
