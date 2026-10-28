// Web-push opt-in: VAPID subscribe + POST the subscription (API.md §1.9).
import type { PushSubscribeRequest, VapidResponse } from '@socialchat/shared';
import { api } from './api';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  // getRegistration() resolves (to undefined) when there is no worker;
  // `.ready` would wait forever and hang a logout.
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

export async function enablePush(): Promise<boolean> {
  if (!pushSupported()) return false;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;
  const { public_key } = await api.get<VapidResponse>('/api/push/vapid');
  if (!public_key) return false;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(public_key).buffer as ArrayBuffer,
  });
  const json = sub.toJSON();
  const keys = json.keys ?? {};
  const body: PushSubscribeRequest = {
    endpoint: sub.endpoint,
    keys: { p256dh: keys.p256dh ?? '', auth: keys.auth ?? '' },
  };
  await api.post('/api/push/subscriptions', body);
  return true;
}

export async function disablePush(): Promise<void> {
  const sub = await getPushSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);
  await api.del('/api/push/subscriptions', { endpoint }).catch(() => undefined);
}
