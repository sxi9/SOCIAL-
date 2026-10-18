'use client';

// Settings → Call self-test (v0.7.1 — API.md §1.55, FEATURES #89). Runs the
// binding check order: secure context → mic/cam permission probe (stopped
// immediately) → GET /api/call-selftest → relay-reachability gather with the
// probe creds + default-policy candidate inventory. Verdict in plain words,
// worst finding first. Reachability is decided CLIENT-side — only this
// browser can test the UDP path from where the user actually sits.
//
// Royal v2 reskin (proto ref 28): device cards (mic level bars, speaker Play
// chime, camera preview frame) + a ✓/!/✕ checklist card. The checks and
// their copy are unchanged; the chime and the on-demand camera preview are
// page-local conveniences and never touch lib/webrtc.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { runCallSelftest, type CheckStatus, type SelftestReport } from '@/lib/selftest';
import AppShell from '@/components/AppShell';
import sm from '@/components/settings.module.css';
import cs from '@/components/calls.module.css';

const CHEV = { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;

function ChevronLeft() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path d="M14.5 6 L8.5 12 L14.5 18" {...CHEV} />
    </svg>
  );
}

const STATUS_GLYPH: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '✕' };
const STATUS_CLASS: Record<CheckStatus, string> = { pass: 'ok-text', warn: 'warn-text', fail: 'error-text' };
const STATUS_WORD: Record<CheckStatus, string> = { pass: 'ready', warn: 'check needed', fail: 'blocked' };
const STATUS_NAME: Record<CheckStatus, string> = { pass: 'passed', warn: 'warning', fail: 'failed' };

function Row({ label, status, detail }: { label: string; status: CheckStatus; detail: string }) {
  return (
    <div className={cs.stRow}>
      <div className={cs.stRowMain}>
        <span>{label}</span>
        <span className={`${STATUS_CLASS[status]} ${cs.stGlyph}`} role="img" aria-label={STATUS_NAME[status]}>
          {STATUS_GLYPH[status]}
        </span>
      </div>
      {status !== 'pass' ? <p className={cs.stDetail}>{detail}</p> : null}
    </div>
  );
}

function permDetail(kind: 'Microphone' | 'Camera', value: string): { status: CheckStatus; detail: string } {
  switch (value) {
    case 'granted':
      return { status: 'pass', detail: `${kind} permission granted.` };
    case 'denied':
      return {
        status: kind === 'Microphone' ? 'fail' : 'warn',
        detail: `${kind} permission is blocked for this site — allow it in your browser's site settings.`,
      };
    case 'no-device':
      return { status: kind === 'Microphone' ? 'fail' : 'warn', detail: `No ${kind.toLowerCase()} was found on this device.` };
    default:
      return { status: 'warn', detail: `Could not probe the ${kind.toLowerCase()} (insecure context or browser quirk).` };
  }
}

/** A short two-note chime through the default output — WebAudio only, no
 * assets, closed as soon as it rings out. */
function playChime(): void {
  try {
    const ctx = new AudioContext();
    const at = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.2, at + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(659.25, at); // E5…
    osc.frequency.setValueAtTime(880, at + 0.18); // …up to A5
    osc.connect(gain);
    osc.start(at);
    osc.stop(at + 0.95);
    osc.onended = () => {
      void ctx.close().catch(() => undefined);
    };
  } catch {
    /* no audio output path — the Play button simply does nothing */
  }
}

function ReportView({ report }: { report: SelftestReport }) {
  const mic = permDetail('Microphone', report.mic);
  const cam = permDetail('Camera', report.cam);

  // On-demand camera preview inside the frame (stopped on toggle/unmount).
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (el && preview && el.srcObject !== preview) {
      el.srcObject = preview;
      void el.play().catch(() => undefined);
    }
    return () => {
      if (preview) for (const t of preview.getTracks()) t.stop();
    };
  }, [preview]);

  async function togglePreview(): Promise<void> {
    if (preview) {
      setPreview(null);
      return;
    }
    try {
      setPreview(await navigator.mediaDevices.getUserMedia({ video: true }));
    } catch {
      /* permission denied / no device — the Camera status already says so */
    }
  }

  return (
    <>
      <p className={`${STATUS_CLASS[report.verdictStatus]} ${cs.stVerdict}`}>{report.verdict}</p>

      <div className={`card ${cs.stCard}`}>
        <div className={cs.stHead}>
          <strong>Microphone</strong>
          <span className={`${STATUS_CLASS[mic.status]} ${cs.stWord}`}>{STATUS_WORD[mic.status]}</span>
        </div>
        <div className={`${cs.micBars}${mic.status === 'pass' ? ` ${cs.micBarsLive}` : ''}`} aria-hidden>
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        {mic.status !== 'pass' ? <p className={cs.stDetail}>{mic.detail}</p> : null}
      </div>

      <div className={`card ${cs.stCard}`}>
        <div className={cs.stHead}>
          <strong>Speaker</strong>
          <button type="button" className={cs.stPlay} onClick={playChime}>
            Play
          </button>
        </div>
        <p className={cs.stDetail}>Play a short chime to check this device&rsquo;s sound output.</p>
      </div>

      <div className={`card ${cs.stCard}`}>
        <div className={cs.stHead}>
          <strong>Camera</strong>
          <span className={`${STATUS_CLASS[cam.status]} ${cs.stWord}`}>{STATUS_WORD[cam.status]}</span>
        </div>
        <div className={cs.stPreview}>
          {preview ? <video ref={videoRef} autoPlay playsInline muted /> : null}
          {cam.status === 'pass' ? (
            <button type="button" className={cs.stPreviewBtn} onClick={() => void togglePreview()}>
              {preview ? 'Stop preview' : 'Show preview'}
            </button>
          ) : (
            <p className={cs.stPreviewNote}>{cam.detail}</p>
          )}
        </div>
      </div>

      <div className={`card ${cs.stCard}`}>
        <Row
          label="Secure context"
          status={report.secureContext ? 'pass' : 'fail'}
          detail={
            report.secureContext
              ? 'HTTPS (or localhost) — the browser allows mic, camera and calls.'
              : 'Not secure — browsers block mic/cam entirely. Phones must open the app via the HTTPS tunnel URL, never a plain LAN IP.'
          }
        />
        <Row
          label="Call relay (TURN)"
          status={report.turnConfigured === true ? 'pass' : report.turnConfigured === false ? 'warn' : 'warn'}
          detail={
            report.turnConfigured === true
              ? 'This server has a call relay configured.'
              : report.turnConfigured === false
                ? 'No relay configured — calls only work on the same network.'
                : 'Could not read the server relay state (offline or rate-limited).'
          }
        />
        {report.turnConfigured === true ? (
          <Row
            label="Relay reachable from here"
            status={report.relayReachable === true ? 'pass' : 'warn'}
            detail={
              report.relayReachable === true
                ? 'A relay candidate was gathered — cross-network calls can flow through it.'
                : 'No relay candidate within the time budget — the relay is not reachable from this network (firewall, NAT, or the server sits behind one).'
            }
          />
        ) : null}
        <Row
          label="Candidate types found"
          status={report.candidateTypes.length > 0 ? 'pass' : 'warn'}
          detail={
            report.candidateTypes.length > 0
              ? `${report.candidateTypes.join(', ')} — host = same network, srflx = direct across networks, relay = through the server.`
              : 'None gathered — the browser produced no ICE candidates at all.'
          }
        />
      </div>
    </>
  );
}

function CallSelftest() {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<SelftestReport | null>(null);

  async function run(): Promise<void> {
    if (running) return;
    setRunning(true);
    setReport(null);
    try {
      setReport(await runCallSelftest());
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <Link href="/settings" className="btn btn-ghost btn-icon" aria-label="Back">
          <ChevronLeft />
        </Link>
        <h1 className={sm.title}>Calls</h1>
        <span />
      </header>
      {/* Royal v2 IA (proto ref 51): this page is the Calls category. The
          who-can-call / video-asks-first settings and call history ship with
          the Calls pack — nothing fake is rendered meanwhile. */}
      <h2 className={sm.sectionLabel}>Self-test</h2>
      <div className="settings-section" style={{ marginTop: 8 }}>
        <div className="card">
          <p className="muted small" style={{ marginTop: 0 }}>
            Checks everything a call needs from this exact device and network: secure context,
            microphone and camera permission (probed and released immediately), whether this server
            has a call relay, and whether that relay is reachable from where you sit. Nothing is
            recorded server-side.
          </p>
          <button type="button" className="btn btn-primary" disabled={running} onClick={() => void run()}>
            {running ? 'Testing… (up to ~20 seconds)' : report ? 'Run it again' : 'Run the test'}
          </button>
        </div>
        {report ? <ReportView report={report} /> : null}
      </div>
      <p className={sm.noteLine}>Call history is coming soon.</p>
    </div>
  );
}

export default function CallSelftestPage() {
  return (
    <AppShell>
      <CallSelftest />
    </AppShell>
  );
}
