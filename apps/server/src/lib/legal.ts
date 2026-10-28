// Wave 1 (AUDIT-PLAN §1.1, 2026-10-28): the shipped legal defaults. The
// operator edits each page as markdown in Admin → Settings (instance_settings
// key 'legal'); an empty string means "render this default". Plain, honest,
// and specific to how THIS software actually works — the audit's bar: email
// and IPs are stored (IPs for IP_RETENTION_DAYS), messages and media sit in
// plaintext in a database the operator holds, no admin route reads chats
// (only a report with the reporter's explicit context consent opens a slice),
// reports forward exactly what is named, no ads, no contact sync.
import { IP_RETENTION_DAYS, AGE_MIN, type LegalTexts } from '@socialchat/shared';

export const LEGAL_DEFAULTS: LegalTexts = {
  terms: `# Terms of use

These terms cover your use of this Bored Chat server — a small, self-hosted chat run by the person or group named on the About page ("the operator"), not by a company.

## Who can use it

You must be at least ${AGE_MIN} years old. You attest to that when you sign up; no date of birth is stored. The operator may close accounts that break these terms or the community guidelines, and may suspend or remove an account without notice where safety requires it.

## Your account

Keep your password to yourself. You are responsible for what happens under your account. You can see every signed-in device and sign any of them out from Settings → Devices & security.

## What you post

You keep the rights to what you post. By posting you allow the operator to store it and show it to the people you chose to share it with, and to anyone holding a link you created for a public share page. Don't post what you don't have the right to share.

## Deleting your account

You can delete your account from Settings → Account. Deletion is scheduled with a short grace period, during which signing in again cancels it. After that your profile, posts, listings, plans, stories and media are removed; messages you sent in other people's chats stay, attributed to "Deleted account".

## No warranty

This is community-run software provided as is. The operator does not promise uptime, backups, or that nothing is ever lost. If that matters to you, keep your own copy (Settings → Account → Download my data).

## Changes

The operator may update these terms; the current version is always at this address.`,

  privacy: `# Privacy

This server is run by the operator named on the About page. Here is exactly what it stores and who can see it.

## What is stored

- **Your email address** — used to sign in and, if the operator has set up mail, to verify or recover your account. Never shown to other members.
- **IP addresses** — the address you registered from and the address of each signed-in device, kept for up to ${IP_RETENTION_DAYS} days, then erased automatically. Used for rate limits and abuse response.
- **Messages and media** — stored in plain text in the server's database and media store. **Chats are not end-to-end encrypted**: the operator holds the database and could technically read it. There is no admin screen that reads chats; the only way a moderator sees message text is when a reporter chooses to include it with a report.
- **Profile and settings** — what you fill in, plus the privacy choices you make.
- **Reports** — when you report something, the moderators receive what you named (the person, message, post or page), the category you picked, your note, and — only if you ticked the box — the few messages around a reported message.

## What is not done here

- No advertising, no ad tracking, no analytics beyond the server's own logs.
- No contact-list upload or address-book matching.
- No sale or sharing of your data with anyone. The operator may be required to hand data to authorities under the law that applies to them.

## Who can see what

What other members see is governed by your settings: who may message you, whether your last-seen shows, what a logged-out visitor sees of your profile, and so on. Blocking someone hides you from each other everywhere.

## Your data

Download a copy of your data from Settings → Account at any time, and delete your account from the same place. Questions go to the operator contact on the About page.`,

  guidelines: `# Community guidelines

Bored Chat is for when the group chat is dead — small groups of people who mostly know each other, plus the occasional stranger who was bored too. A few rules keep that fun.

- **Be a person.** No impersonation, no bots pretending to be people, no fake accounts.
- **Take no for an answer.** If someone leaves a chat, blocks you, or doesn't reply, that is the end of it.
- **No harassment, hate or threats.** Not as a joke, not in a private chat.
- **No sexual content involving minors, ever.** This is reported to the authorities.
- **No nudity in public spaces**, and nothing sexual sent to anyone who didn't ask for it.
- **No scams.** The local board is a bulletin board: it does not vet listings, hold money or process payments. Meet in public, bring a friend, and never pay before you've seen the thing.
- **No spam.** Don't post the same thing everywhere or push people to other platforms with links.
- **Only post what you have the right to share.**

Report anything that breaks these from the ⋯ menu on the thing itself. Reports go to the moderators only; no one is told who reported them. Moderators may warn, remove content, suspend or ban. Appeals go to the operator contact on the About page.`,
};
