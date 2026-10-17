'use client';

// Settings → Call self-test (v0.7.1 — API.md §1.55, FEATURES #89). Runs the
// binding check order: secure context → mic/cam permission probe (stopped
// immediately) → GET /api/call-selftest → relay-reachability gather with the
// probe creds + default-policy candidate inventory. Verdict in plain words,
// worst finding first. Reachability is decided CLIENT-side — only this
// browser can test the UDP path from where the user actually sits.
import { useState } from 'react';
import Link from 'next/link';
import { runCallSelftest, type CheckStatus, type SelftestReport } from '@/lib/selftest';
import AppShell from '@/components/AppShell';

const STATUS_GLYPH: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '×' };
const STATUS_CLASS: Record<CheckStatus, string> = { pass: 'ok-text', warn: 'warn-text', fail: 'error-text' };

function Row({ label, status, detail }: { label: string; status: CheckStatus; detail: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '6px 0' }}>
      <span className={STATUS_CLASS[status] ?? 'muted'} aria-hidden style={{ width: 16, textAlign: 'center', flex: 'none', fontWeight: 700 }}>
        {STATUS_GLYPH[status]}
      </span>
      <div style={{ minWidth: 0 }}>
        <strong>{label}</strong>
        <p className="muted small" style={{ margin: '2px 0 0' }}>
          {detail}
        </p>
      </div>
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

function ReportView({ report }: { report: SelftestReport }) {
  const mic = permDetail('Microphone', report.mic);
  const cam = permDetail('Camera', report.cam);
  return (
    <>
      <div className={`card`} style={{ marginTop: 12 }}>
        <p className={STATUS_CLASS[report.verdictStatus]} style={{ marginTop: 0, fontWeight: 600 }}>
          {report.verdict}
        </p>
        <Row
          label="Secure context"
          status={report.secureContext ? 'pass' : 'fail'}
          detail={
            report.secureContext
              ? 'HTTPS (or localhost) — the browser allows mic, camera and calls.'
              : 'Not secure — browsers block mic/cam entirely. Phones must open the app via the HTTPS tunnel URL, never a plain LAN IP.'
          }
        />
        <Row label="Microphone" status={mic.status} detail={mic.detail} />
        <Row label="Camera" status={cam.status} detail={cam.detail} />
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
        <Link href="/settings/profile" className="btn btn-ghost btn-icon" aria-label="Back">
          ←
        </Link>
        <h1>Call self-test</h1>
        <span />
      </header>
      <div className="settings-section">
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
