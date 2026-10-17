-- 0011_auth — v0.9: the auth pack (ADR-021; API.md §1.70–§1.74; FEATURES
-- #82–#86). Passkeys (WebAuthn), QR cross-device login, recovery codes,
-- optional TOTP 2FA, and the OTP-ready admin Authentication settings.
-- Mirrors nothing new in docs/SCHEMA.sql (frozen at v0.4); Drizzle twin in
-- src/db/schema.ts.
--
-- HARD RULES carried by this schema: the ADR-001 session layer is UNTOUCHED —
-- every new method only changes how a sessions row gets MINTED (opaque
-- sha256-stored token in the httpOnly sid cookie, sliding expiry, revocation
-- closes sockets 4401, X-Requested-With CSRF — all exactly as before); no
-- secret is ever stored recoverable where a hash will do (login-link codes
-- and recovery codes are sha256 rows, the ADR-001 token doctrine) — the ONE
-- exception is users.totp_secret, which verification must read back, so it is
-- AES-256-GCM-encrypted with a SESSION_SECRET-derived key (ADR-021 documents
-- the tradeoff); WebAuthn challenges and half-login TOTP tokens are Redis
-- TTL state, never rows; login links are single-use, 120-second, and record
-- the laptop's UA/IP so the PHONE decides with eyes open; recovery is
-- scorched-earth by design (all sessions revoked + forced password reset);
-- the SMTP password lives OUTSIDE the admin-readable settings json, in its
-- own encrypted instance_settings key that serializes only as password_set.

-- ===================== users: optional TOTP second factor ====================
-- §1.73 (#85). totp_secret is the RFC 6238 shared secret, encrypted at rest
-- (v1:<iv>:<ciphertext>:<tag>, base64url parts, key = HKDF-SHA256 of
-- SESSION_SECRET with info 'totp:'). NEVER serialized — not in UserPrivate,
-- not in the §1.41 export (totp_enabled booleans only). Both columns move
-- together: enabling writes both in one tx, disabling nulls both.

ALTER TABLE users
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_enabled_at timestamptz,
  ADD CONSTRAINT users_totp_shape_check
    CHECK ((totp_secret IS NULL) = (totp_enabled_at IS NULL));

-- ====================== passkeys (§1.70, #82, WebAuthn) ======================
-- One row per registered credential. credential_id / public_key are the
-- base64url strings @simplewebauthn/server emits (ADR-021 pins the library) —
-- the public key is a COSE blob we verify signatures against, not a secret.
-- counter is the authenticator's signature counter: a verify that comes back
-- LOWER than the stored value is a cloned-credential signal and the login is
-- refused (401 bad_credentials) + ring-logged. Cap PASSKEYS_MAX (10) per user
-- is route-enforced under pg_advisory_xact_lock(hashtextextended(user_id, 82))
-- (the 0010 counter-race rule — never check-then-insert).

CREATE TABLE passkey_credentials (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL,                  -- base64url, globally unique
  public_key    text NOT NULL,                  -- base64url COSE public key
  counter       bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports    text[] NOT NULL DEFAULT '{}',   -- hints only ('internal','hybrid','usb','ble','nfc')
  device_type   text NOT NULL DEFAULT 'singleDevice'
                  CHECK (device_type IN ('singleDevice','multiDevice')),
  backed_up     boolean NOT NULL DEFAULT false, -- synced/multi-device credential
  nickname      text CHECK (char_length(nickname) BETWEEN 1 AND 32), -- PASSKEY_NICKNAME_MAX_CHARS
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE UNIQUE INDEX passkey_credentials_credential_idx ON passkey_credentials (credential_id);
CREATE INDEX passkey_credentials_user_idx ON passkey_credentials (user_id, created_at);

-- ================== QR / cross-device login links (§1.71, #83) ==============
-- Pure first-party, WhatsApp-Web style, built ON the sessions table: the
-- logged-out laptop mints a link, renders it as a QR of <origin>/link/<code>
-- plus a 6-char human code, and POLLS with the full code; the logged-in phone
-- opens /link/<code> (or types the short code), sees the laptop's UA/IP, and
-- approves. The laptop's NEXT poll after approval mints a standard session —
-- the token is minted ON the laptop's own request and never transits the
-- phone or a row. TWO hashed codes per row: code_hash (32-byte secret — the
-- QR payload AND the poll/redeem capability) and display_code_hash (6 chars
-- from LOGIN_LINK_DISPLAY_ALPHABET — approve-only, never enough to poll or
-- redeem, so its small keyspace only lets a guesser APPROVE a stranger's
-- laptop into the GUESSER'S OWN account, rate-limited to irrelevance).
-- No user_id at creation (the laptop is anonymous); approved_by is the phone.
-- Single-use: status is a one-way pending → approved → consumed walk, each
-- step an atomic UPDATE ... WHERE status = '<prev>' RETURNING (the 0010 race
-- rule). TTL LOGIN_LINK_TTL_S (120 s); the gc job deletes rows an hour past
-- expiry (ip/user_agent therefore never outlive IP_RETENTION_DAYS concerns).

CREATE TABLE login_links (
  id                uuid PRIMARY KEY,
  code_hash         text NOT NULL,         -- sha256(full code), base64url
  display_code_hash text NOT NULL,         -- sha256(normalized 6-char code)
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','consumed')),
  approved_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  new_session_id    uuid REFERENCES sessions(id) ON DELETE SET NULL,
  user_agent        text,                  -- the LAPTOP's UA — shown on the phone
  ip                inet,                  -- the LAPTOP's IP — coarse hint on the phone
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL
);

CREATE UNIQUE INDEX login_links_code_idx ON login_links (code_hash);
CREATE UNIQUE INDEX login_links_display_code_idx ON login_links (display_code_hash);
CREATE INDEX login_links_expires_idx ON login_links (expires_at);

-- ====================== recovery codes (§1.72, #84) ==========================
-- RECOVERY_CODES_COUNT (6) per generation, shown ONCE (register response /
-- regenerate response), stored sha256 of the normalized code (lowercased,
-- separators stripped — the ADR-001 token doctrine). used_at marks a consumed
-- code; regeneration DELETEs the user's rows and inserts a fresh set in one
-- tx. Consumption is the atomic UPDATE ... WHERE used_at IS NULL RETURNING —
-- two racing recover attempts can never spend one code twice.

CREATE TABLE recovery_codes (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz
);

CREATE UNIQUE INDEX recovery_codes_code_idx ON recovery_codes (code_hash);
CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id);

-- ============ OTP-ready admin Authentication settings (§1.74, #86) ===========
-- Config-not-code readiness: the instance stores a full SMTP block and
-- per-feature toggles TODAY; every email-dependent flow flags off these at
-- runtime, so when a mailer lands (future release — golden rule 10 means no
-- SMTP client ships in v0.9, documented honestly in ADR-021) enabling OTP /
-- magic links / password-reset mail is configuration, not code. The password
-- is NOT in this json: it lives in its own key below, AES-256-GCM-encrypted
-- with the SESSION_SECRET-derived key (HKDF info 'smtp:'), and serializes to
-- admins ONLY as the boolean password_set. SMTP_PASSWORD env, when set, takes
-- precedence over the stored value (the env-reference option in SPECS #86).

INSERT INTO instance_settings (key, value) VALUES
  ('auth', '{
    "smtp": {"host": null, "port": 587, "secure": true, "username": null, "from": null},
    "features": {
      "email_verification": false,
      "email_otp": false,
      "magic_links": false,
      "password_reset": false
    }
  }'::jsonb),
  ('auth_smtp_password', 'null'::jsonb);

-- =========================== release notes (§1.61) ===========================

UPDATE instance_settings
SET value = '[
  {
    "version": "v0.9",
    "date": "2026-10-17",
    "title": "Sign in your way",
    "items": [
      "Passkeys: sign in with your fingerprint, face or security key — manage them in Settings",
      "Log in on a laptop by scanning its QR code with your phone (or typing a 6-letter code)",
      "Six one-time recovery codes, shown at signup and regenerable — a lost password never means a lost account",
      "Optional authenticator-app 2FA (TOTP) with a copyable setup key; recovery codes always get you back in",
      "Admins: an Authentication page that stores SMTP + email toggles now — sending switches on when the mailer lands"
    ]
  }
]'::jsonb || value,
    updated_at = now()
WHERE key = 'release_notes';
