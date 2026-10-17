// Thin client bridge over @simplewebauthn/browser (v0.9 — API.md §1.70,
// ADR-021: the ONE sanctioned dependency exception, pinned 13.1.0). The
// library owns the W3C JSON wire shapes; the shared contract treats them as
// opaque (WebAuthnJson), so this module casts the library's typed surface to
// the contract's loose one in exactly one place and the rest of the app never
// mentions W3C types.
import * as swa from '@simplewebauthn/browser';
import type { WebAuthnJson } from '@socialchat/shared';

type StartRegistration = (opts: {
  optionsJSON: WebAuthnJson;
  useAutoRegister?: boolean;
}) => Promise<WebAuthnJson>;

type StartAuthentication = (opts: {
  optionsJSON: WebAuthnJson;
  useBrowserAutofill?: boolean;
  verifyBrowserAutofillInput?: boolean;
}) => Promise<WebAuthnJson>;

const startRegistrationLoose = swa.startRegistration as unknown as StartRegistration;
const startAuthenticationLoose = swa.startAuthentication as unknown as StartAuthentication;

/** Whether this browser can do WebAuthn at all (gates every passkey button). */
export function passkeysSupported(): boolean {
  try {
    return swa.browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** Conditional-UI (autofill) support — the "passkey in the username field" flow. */
export async function passkeyAutofillSupported(): Promise<boolean> {
  try {
    return await swa.browserSupportsWebAuthnAutofill();
  } catch {
    return false;
  }
}

/** Run the registration ceremony; the result posts to POST /api/auth/passkeys. */
export function createPasskey(optionsJSON: WebAuthnJson): Promise<WebAuthnJson> {
  return startRegistrationLoose({ optionsJSON });
}

/** Run the authentication ceremony; the result posts to POST /api/auth/passkey-login. */
export function assertPasskey(
  optionsJSON: WebAuthnJson,
  opts: { autofill?: boolean } = {},
): Promise<WebAuthnJson> {
  return startAuthenticationLoose({
    optionsJSON,
    useBrowserAutofill: opts.autofill === true,
    // The username input doubles as the autofill anchor; it has
    // autocomplete="username webauthn" but not as its own dedicated field.
    verifyBrowserAutofillInput: false,
  });
}

/** True when the user dismissed/cancelled the platform passkey prompt —
 * silence is the right UI response, not an error banner. */
export function isWebAuthnCancel(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'NotAllowedError' ||
    err.name === 'AbortError' ||
    // @simplewebauthn wraps aborted ceremonies in WebAuthnError with a code.
    (err as { code?: string }).code === 'ERROR_CEREMONY_ABORTED'
  );
}
