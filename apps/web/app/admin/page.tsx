'use client';

// Admin overview — metrics (§1.41). Number tiles + plain 30-day bar lists;
// deliberately no chart library (the series are 30 rows of divs). DAU is a
// documented PROXY: distinct users whose sessions were seen that day.
import { useEffect, useState } from 'react';
import type { AdminMetrics, DayCount } from '@socialchat/shared';
import { adminMetrics } from '@/lib/admin';
import { formatBytes } from '@/lib/format';
import ad from '@/components/admin.module.css';

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
