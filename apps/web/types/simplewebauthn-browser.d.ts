// Ambient FALLBACK declaration for @simplewebauthn/browser (v0.9 — ADR-021:
// the one sanctioned dependency exception, pinned 13.1.0 in package.json).
// TypeScript only consults an ambient `declare module` when the import does
// not resolve to real files — once `pnpm install` has run, the package's own
// (richer) types win and this file is inert. It exists so the workspace
// typechecks before the integration install, and it declares only the v13
// surface lib/webauthn.ts actually touches, with deliberately loose JSON
// shapes (the shared contract treats WebAuthn JSON as opaque — WebAuthnJson).
declare module '@simplewebauthn/browser' {
  export function startRegistration(options: {
    optionsJSON: Record<string, unknown>;
    useAutoRegister?: boolean;
  }): Promise<Record<string, unknown>>;
  export function startAuthentication(options: {
    optionsJSON: Record<string, unknown>;
    useBrowserAutofill?: boolean;
    verifyBrowserAutofillInput?: boolean;
  }): Promise<Record<string, unknown>>;
  export function browserSupportsWebAuthn(): boolean;
  export function browserSupportsWebAuthnAutofill(): Promise<boolean>;
}
