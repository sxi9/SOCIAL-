// Wave 1 (AUDIT-PLAN §1.1): /privacy — operator-editable, public, indexable.
import LegalPage, { legalMetadata } from '@/components/LegalPage';

export const dynamic = 'force-dynamic';
export const metadata = legalMetadata('privacy');

export default function Page() {
  return <LegalPage page="privacy" />;
}
