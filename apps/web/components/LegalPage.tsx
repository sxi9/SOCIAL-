// Wave 1 (AUDIT-PLAN §1.1): the /terms, /privacy and /guidelines pages —
// UNAUTHENTICATED SSR (the share-page skeleton), indexable, rendered from
// GET /api/instance (operator markdown or the shipped default). SERVER
// component: lib/ssr is next/headers-scoped.
import type { Metadata } from 'next';
import Link from 'next/link';
import type { LEGAL_PAGES } from '@socialchat/shared';
import Markdown from './Markdown';
import { fetchInstanceInfo } from '@/lib/ssr';
import cm from './community.module.css';

export type LegalPageKey = (typeof LEGAL_PAGES)[number];

const TITLES: Record<LegalPageKey, string> = {
  terms: 'Terms of use',
  privacy: 'Privacy',
  guidelines: 'Community guidelines',
};

export function legalMetadata(page: LegalPageKey): Metadata {
  return { title: TITLES[page], description: `${TITLES[page]} for this Bored Chat server.` };
}

export default async function LegalPage({ page }: { page: LegalPageKey }) {
  const info = await fetchInstanceInfo();
  const text = info?.legal[page] ?? '';
  return (
    <main className={cm.sharePage}>
      <header className={cm.shareHead}>
        <Link href="/" className={cm.shareBrand}>
          bored.
        </Link>
        <span className={cm.shareHeadMeta}>{TITLES[page].toLowerCase()}</span>
      </header>
      <article className={`${cm.shareCard} ${cm.legalCard}`}>
        {text ? (
          <Markdown source={text} className={cm.legalBody} />
        ) : (
          <p className={cm.shareBody}>This page could not be loaded right now. Try again in a moment.</p>
        )}
        <p className="muted small" style={{ margin: '18px 0 0' }}>
          {info?.operator_contact ? (
            <>
              Hosted by <strong>{info.operator_contact}</strong>.{' '}
            </>
          ) : null}
          <Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link> ·{' '}
          <Link href="/guidelines">Guidelines</Link>
        </p>
      </article>
    </main>
  );
}
