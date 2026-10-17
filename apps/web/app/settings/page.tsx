// /settings is the deep-link target several FEATURE_DIRECTORY entries use
// (v0.8a §1.61); the actual settings live under /settings/profile.
import { redirect } from 'next/navigation';

export default function SettingsIndex() {
  redirect('/settings/profile');
}
