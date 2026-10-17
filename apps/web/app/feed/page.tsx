'use client';

import FeedView from '@/components/FeedView';
import TabPage from '@/components/TabPage';

export default function FeedPage() {
  return (
    <TabPage active="feed">
      <FeedView />
    </TabPage>
  );
}
