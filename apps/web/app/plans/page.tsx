// v0.5b (FEATURES #43): the Plans tab became the Local tab — beacons up top,
// the board below. Old links and installed PWAs land here; send them on.
import { redirect } from 'next/navigation';

export default function PlansRedirect() {
  redirect('/local');
}
