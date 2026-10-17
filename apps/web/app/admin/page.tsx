'use client';

// Admin overview — metrics (§1.41). Number tiles + plain 30-day bar lists;
// deliberately no chart library (the series are 30 rows of divs). DAU is a
// documented PROXY: distinct users whose sessions were seen that day.
import { useEffect, useState } from 'react';
import type { AdminMetrics, AdminUpdateStatus, DayCount, ReleasesResponse } from '@socialchat/shared';
import { api } from '@/lib/api';
import { adminMetrics, adminUpdateStatus } from '@/lib/admin';
import { formatBytes, formatTime } from '@/lib/format';
import ad from '@/components/admin.module.css';
import cm from '@/components/community.module.css';

/** v0.8b §1.69 #81d: the "update available" banner. The api compares its
 * baked GIT_COMMIT against the repo remote's HEAD (git HTTPS smart protocol,
 * first-party, no SaaS); update_available null = honestly unknown. The update
 * itself ALWAYS runs on the host (./bored update) — the container never gets
 * docker.sock, so this banner instructs, it never executes. */
function UpdateBanner() {
  const [update, setUpdate] = useState<AdminUpdateStatus | null>(null);
  const [releases, setReleases] = useState<ReleasesResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    void adminUpdateStatus()
      .then((res) => {
        if (!cancelled) setUpdate(res.update);
      })
      .catch(() => undefined);
    void api
      .get<ReleasesResponse>('/api/releases')
      .then((res) => {
        if (!cancelled) setReleases(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!update) return null;

  const short = (sha: string | null) => (sha ? sha.slice(0, 10) : null);
  // The §1.61 release-notes delta: everything newer than the running version
  // (best effort — the banner's changelog, not a precise diff).
  const norm = (v: string) => v.trim().toLowerCase().replace(/^v/, '');
  const newer =
    releases && update.running_version
      ? (() => {
          const idx = releases.releases.findIndex((r) => norm(r.version) === norm(update.running_version!));
          return idx > 0 ? releases.releases.slice(0, idx) : [];
        })()
      : [];

  return (
    <div className={cm.updateBanner} role="status">
      {update.running_commit === null ? (
        <>
          <h3>🧪 Dev build</h3>
          <p style={{ margin: 0 }}>
            No commit is baked into this image, so there is nothing to compare against the repo.
          </p>
        </>
      ) : update.update_available === true ? (
        <>
          <h3>⬆️ Update available</h3>
          <p style={{ margin: '0 0 6px' }}>
            Running <code>{short(update.running_commit)}</code>
            {update.running_version ? ` (${update.running_version})` : ''} — the repo&rsquo;s HEAD is{' '}
            <code>{short(update.latest_commit)}</code>
            {update.checked_at ? ` (checked ${formatTime(update.checked_at)})` : ''}.
          </p>
          {newer.length > 0 ? (
            <ul style={{ margin: '0 0 6px', paddingLeft: 18 }}>
              {newer.map((r) => (
                <li key={r.version}>
                  <strong>{r.version}</strong> — {r.title}
                </li>
              ))}
            </ul>
          ) : null}
          <p style={{ margin: 0 }}>
            Run <code>./bored update</code> on the HOST — the container never updates itself (no
            docker.sock, by design).
          </p>
        </>
      ) : update.update_available === false ? (
        <>
          <h3>✅ Up to date</h3>
          <p style={{ margin: 0 }}>
            Running <code>{short(update.running_commit)}</code>
            {update.running_version ? ` (${update.running_version})` : ''}
            {update.checked_at ? ` · checked ${formatTime(update.checked_at)}` : ''}.
          </p>
        </>
      ) : (
        <>
          <h3>🤷 Can&rsquo;t tell</h3>
          <p style={{ margin: 0 }}>
            Running <code>{short(update.running_commit)}</code> — the repo remote hasn&rsquo;t been
            reachable, so whether an update exists is honestly unknown (never a guess).
          </p>
        </>
      )}
    </div>
  );
}

export default function AdminOverviewPage() {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void adminMetrics()
      .then((res) => {
        if (!cancelled) setMetrics(res.metrics);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load metrics.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="error-text">{error}</p>;
  if (!metrics) {
    return (
      <p className="muted small" role="status">
        Loading metrics…
      </p>
    );
  }

  const tiles: { label: string; value: string }[] = [
    { label: 'Users', value: String(metrics.users_total) },
    { label: 'Open beacons', value: String(metrics.open_beacons) },
    { label: 'Active listings', value: String(metrics.active_listings) },
    { label: 'Open reports', value: String(metrics.open_reports) },
    { label: 'Storage', value: formatBytes(metrics.storage_total_bytes) },
  ];

  return (
    <div>
      <h2>Overview</h2>
      <UpdateBanner />
      <div className={ad.tiles}>
        {tiles.map((t) => (
          <div key={t.label} className={ad.tile}>
            <div className={ad.tileVal}>{t.value}</div>
            <div className={ad.tileLabel}>{t.label}</div>
          </div>
        ))}
      </div>

      <div className={ad.seriesGrid}>
        <Series title="Registrations / day (30d)" data={metrics.registrations_per_day} />
        <Series
          title="Active users / day (30d — proxy: sessions seen that day)"
          data={metrics.active_users_per_day}
        />
        <Series title="Messages / day (30d)" data={metrics.messages_per_day} />
      </div>
      <p className={ad.note}>
        The DAU series is approximate by design: sliding sessions mean a quiet client can count
        without a visit (API §1.41 documents this as a proxy, not precision).
      </p>
    </div>
  );
}

function Series({ title, data }: { title: string; data: DayCount[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <section className={ad.series} aria-label={title}>
      <h3>{title}</h3>
      {data.length === 0 ? (
        <p className={ad.dim} style={{ fontSize: 12.5, margin: 0 }}>
          No data yet.
        </p>
      ) : (
        data.map((d) => (
          <div key={d.date} className={ad.barRow}>
            <span>{d.date.slice(5)}</span>
            <span className={ad.barTrack}>
              <span
                className={ad.barFill}
                style={{ width: `${Math.round((d.count / max) * 100)}%`, display: 'block' }}
              />
            </span>
            <span className={ad.barCount}>{d.count}</span>
          </div>
        ))
      )}
    </section>
  );
}
