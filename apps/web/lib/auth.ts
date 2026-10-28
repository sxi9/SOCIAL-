// v0.9 auth-pack client (API.md §1.70–§1.74, ADR-021). Every call here MINTS
// or manages how a session starts — the session itself stays ADR-001's
// opaque-token sid cookie, so nothing in this file stores tokens: the cookie
// rides Set-Cookie on the minting responses and that is that.
import type {
  ApproveLoginLinkRequest,
  CreateLoginLinkResponse,
  LoginOutcome,
  LookupLoginLinkResponse,
  PasskeyInfo,
  PasskeyLoginOptionsResponse,
  PasskeyRegisterOptionsResponse,
  PasskeyRegisterResponse,
  PasskeysResponse,
  PollLoginLinkResponse,
  RecoverResponse,
  RecoveryCodesResponse,
  RecoveryCodesStatusResponse,
  ResetPasswordResponse,
  TotpChallenge,
  TotpDisableRequest,
  TotpSetupResponse,
  UserPrivate,
  WebAuthnJson,
} from '@socialchat/shared';
import { api } from './api';

// ---- §1.1/§1.73 login outcome ------------------------------------------------

/** A correct password/passkey on a TOTP-armed account answers the half-login
 * challenge instead of a session (§1.73). */
export function isTotpChallenge(outcome: LoginOutcome): outcome is TotpChallenge {
  return 'totp_required' in outcome && outcome.totp_required === true;
}

// ---- §1.70 passkeys -----------------------------------------------------------

export function passkeyRegisterOptions(): Promise<PasskeyRegisterOptionsResponse> {
  return api.post<PasskeyRegisterOptionsResponse>('/api/auth/passkeys/options');
}

export function passkeyRegister(
  response: WebAuthnJson,
  nickname: string | null,
): Promise<PasskeyRegisterResponse> {
  return api.post<PasskeyRegisterResponse>('/api/auth/passkeys', {
    response,
    ...(nickname ? { nickname } : {}),
  });
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const res = await api.get<PasskeysResponse>('/api/auth/passkeys');
  return res.passkeys;
}

export async function renamePasskey(id: string, nickname: string): Promise<PasskeyInfo> {
  const res = await api.patch<{ passkey: PasskeyInfo }>(`/api/auth/passkeys/${id}`, { nickname });
  return res.passkey;
}

export async function deletePasskey(id: string): Promise<void> {
  await api.del(`/api/auth/passkeys/${id}`);
}

export function passkeyLoginOptions(username?: string): Promise<PasskeyLoginOptionsResponse> {
  return api.post<PasskeyLoginOptionsResponse>(
    '/api/auth/passkey-login/options',
    username ? { username } : {},
  );
}

export function passkeyLogin(challengeRef: string, response: WebAuthnJson): Promise<LoginOutcome> {
  return api.post<LoginOutcome>('/api/auth/passkey-login', {
    challenge_ref: challengeRef,
    response,
  });
}

// ---- §1.71 QR cross-device login ----------------------------------------------

export function createLoginLink(): Promise<CreateLoginLinkResponse> {
  return api.post<CreateLoginLinkResponse>('/api/auth/link');
}

export function pollLoginLink(code: string): Promise<PollLoginLinkResponse> {
  return api.post<PollLoginLinkResponse>('/api/auth/link/poll', { code });
}

export function lookupLoginLink(code: string): Promise<LookupLoginLinkResponse> {
  return api.post<LookupLoginLinkResponse>('/api/auth/link/lookup', { code });
}

export async function approveLoginLink(code: string): Promise<void> {
  const body: ApproveLoginLinkRequest = { code };
  await api.post('/api/auth/link/approve', body);
}

/** Wave 1 §1.3: a real Deny — the pending code is deleted server-side. */
export async function denyLoginLink(code: string): Promise<void> {
  const body: ApproveLoginLinkRequest = { code };
  await api.post('/api/auth/link/deny', body);
}

// ---- §1.72 recovery codes ------------------------------------------------------

export function recoveryCodesStatus(): Promise<RecoveryCodesStatusResponse> {
  return api.get<RecoveryCodesStatusResponse>('/api/auth/recovery-codes');
}

export function regenerateRecoveryCodes(password: string): Promise<RecoveryCodesResponse> {
  return api.post<RecoveryCodesResponse>('/api/auth/recovery-codes', { password });
}

/** §1.72: change password while signed in; other devices get signed out. */
export function changePassword(currentPassword: string, newPassword: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>('/api/auth/password', {
    current_password: currentPassword,
    new_password: newPassword,
  });
}

export function recoverAccount(usernameOrEmail: string, code: string): Promise<RecoverResponse> {
  return api.post<RecoverResponse>('/api/auth/recover', {
    username_or_email: usernameOrEmail,
    code,
  });
}

export function resetPassword(
  resetToken: string,
  newPassword: string,
): Promise<ResetPasswordResponse> {
  return api.post<ResetPasswordResponse>('/api/auth/reset-password', {
    reset_token: resetToken,
    new_password: newPassword,
  });
}

/** The .txt body for the client-side recovery-codes download (§1.72). */
export function recoveryCodesText(codes: string[], username: string): string {
  return [
    `Bored Chat recovery codes for @${username}`,
    '',
    'Each code works exactly once. Using one signs you out everywhere and',
    'asks for a new password. Keep these somewhere safe and offline.',
    '',
    ...codes.map((c) => `  ${c}`),
    '',
  ].join('\n');
}

/** Trigger a client-side download of a small text file (recovery codes). */
export function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---- §1.73 TOTP ---------------------------------------------------------------

export function totpSetup(): Promise<TotpSetupResponse> {
  return api.post<TotpSetupResponse>('/api/auth/totp/setup');
}

export function totpEnable(code: string): Promise<{ user: UserPrivate }> {
  return api.post<{ user: UserPrivate }>('/api/auth/totp/enable', { code });
}

export function totpVerify(totpToken: string, code: string): Promise<{ user: UserPrivate }> {
  return api.post<{ user: UserPrivate }>('/api/auth/totp', { totp_token: totpToken, code });
}

export function totpDisable(req: TotpDisableRequest): Promise<{ user: UserPrivate }> {
  return api.post<{ user: UserPrivate }>('/api/auth/totp/disable', req);
}

// ---- shared presentation helpers ----------------------------------------------

/** "Chrome on Linux" from a UA string — the §1.71 approve sheet's one-liner.
 * Best-effort client-side parse; falls back to the raw prefix. */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown browser';
  let browser = 'A browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chromium\//.test(ua)) browser = 'Chromium';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'Safari';
  let os = '';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return os ? `${browser} on ${os}` : browser;
}

/** Known quick-tunnel suffixes (ADR-021): passkeys bind to the rpID domain,
 * and these domains change per run — enrolling against one orphans the
 * credential on the next tunnel. */
const QUICK_TUNNEL_SUFFIXES = [
  '.trycloudflare.com',
  '.ngrok-free.app',
  '.ngrok-free.dev',
  '.ngrok.app',
  '.ngrok.dev',
  '.ngrok.io',
  '.loca.lt',
  '.serveo.net',
  '.localhost.run',
  '.lhr.life',
];

/** Non-null = the quick-tunnel warning for this hostname (§1.70/ADR-021). */
export function quickTunnelWarning(hostname: string): string | null {
  const h = hostname.toLowerCase();
  if (!QUICK_TUNNEL_SUFFIXES.some((s) => h.endsWith(s))) return null;
  return (
    `This server is running on a quick tunnel (${h}). Passkeys bind to the ` +
    'domain they were made on — the next tunnel gets a NEW domain and every ' +
    'passkey enrolled here stops working. Enroll passkeys only on a stable domain.'
  );
}

/** mm:ss countdown text for link/setup expiries. */
export function countdown(expiresAtIso: string, nowMs: number): string {
  const left = Math.max(0, Math.floor((new Date(expiresAtIso).getTime() - nowMs) / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function isExpired(expiresAtIso: string, nowMs: number): boolean {
  return new Date(expiresAtIso).getTime() <= nowMs;
}
