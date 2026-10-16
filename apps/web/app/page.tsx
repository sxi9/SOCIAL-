import AppShell from '@/components/AppShell';
import ConversationListView from '@/components/ConversationListView';

export default function HomePage() {
  return (
    <AppShell>
      <ConversationListView />
    </AppShell>
  );
}
