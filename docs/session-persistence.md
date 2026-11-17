# Session persistence

> Implementation status: the persistence guard and background session authority are proposed in [PR #2](https://github.com/vychivsky/twitch-friends/pull/2), not yet merged. Registration/friend caches, stored tab selection, and automatic one-minute background retries additionally depend on the unmerged presence refactor. This document is a design and code-path analysis, not proof of a reproduced production incident.

This document explains how Twitch Friends keeps a user signed in across service-worker restarts,
browser restarts, and extension updates. It also covers what can still end a session.

## Identity layers

A user is recognised through three independent layers. All three must agree.

| Layer                   | What it is                                | Where it lives                                                                                                       | How it is proven                                                      |
| ----------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Firebase anonymous user | UID plus refresh token                    | Extension-origin IndexedDB (`firebaseLocalStorageDb`)                                                                | Firebase ID token (RS256, one hour), refreshed with the refresh token |
| Twitch account mapping  | `users.firebase_uid` to `users.twitch_id` | Cloudflare D1                                                                                                        | Twitch OAuth, verified once by the Worker                             |
| Presence identity       | ECDH P-256 key pair                       | Private key: extension IndexedDB (`twitch-friends`) as a non-extractable `CryptoKey`. Public key: D1 `identity_keys` | Possession of the private key; friends encrypt to the public key      |

Nothing is hashed in place of a secret. The private key is stored with IndexedDB's structured-clone
support for `CryptoKey` objects. It was generated with `extractable: false`, so script code cannot
export it, including extension code. A hash could not restore it. The Firebase refresh token is
stored by the Firebase SDK in the extension's own IndexedDB. Twitch web pages and content scripts
cannot open that database, because content scripts use the page origin for IndexedDB.

## Root cause of earlier session loss

A changed Firebase UID can explain why a previously connected user must connect Twitch again. The following paths are risks identified in the earlier implementation, not a confirmed diagnosis for every production logout. The D1 mapping is keyed
by UID, so a new UID looks like a user who never connected.

1. **The SDK deletes the saved user on non-network restore errors.** On every start, Firebase Auth
   reloads the saved user. If the reload fails with any error other than
   `auth/network-request-failed`, it calls `directlySetCurrentUser(null)`, which removes the saved
   user from IndexedDB. Examples are `auth/too-many-requests`, `auth/internal-error`, and quota
   errors. This is in `@firebase/auth` `reloadAndSetCurrentUserOrClear`.
2. **The extension then created a replacement user.** The old `initializeAnonymousAuth` signed in
   anonymously whenever `currentUser` was `null` after `authStateReady()`. This created and
   persisted a brand-new UID, which made the loss permanent.
3. **Several contexts could create users.** The popup and the background each ran that logic. On
   first run, when consent was accepted, both could call `signInAnonymously` at the same time. The
   last IndexedDB write won, and the OAuth mapping could be bound to the other UID.
4. **Unavailable IndexedDB fell back to memory.** If IndexedDB could not be opened, the SDK fell
   back to in-memory persistence. The extension then created a temporary UID for that worker's
   lifetime. Connecting Twitch in that state moved the mapping to a UID that was gone after the
   next restart.

## Fix

- `src/infrastructure/firebase/protectedPersistence.ts` subclasses the SDK's IndexedDB persistence.
  It refuses to delete the saved credential unless the extension explicitly allows it. Explicit
  removal happens only for account deletion and for user-initiated replacement of an unusable
  credential. Other keys behave normally. A unit test checks that the installed SDK still exposes
  the overridden methods, so an SDK upgrade cannot silently disable the guard.
- `src/infrastructure/firebase/firebaseAuth.ts`:
  - Only the background (`setFirebaseSessionAuthority`) may create an anonymous user. Popups ask
    the background with a `firebase-session:ensure` message, which is only accepted from extension
    pages, and then wait for the shared IndexedDB state.
  - A new user is created only when no credential is saved.
  - If a credential is saved but could not be restored, startup fails with `restore-failed`. The
    next attempt re-initializes the Firebase app and reloads the credential. Attempts happen at
    most once per minute, on heartbeats.
  - **Connect Twitch** passes `replaceUnrestorable: true`. This is the only path that replaces an
    unusable credential, and it immediately re-proves Twitch ownership through OAuth.
  - If storage cannot be read, startup fails closed (`unavailable`) and does not create an
    in-memory user.
- `src/security/identity/localIdentity.ts` validates the stored key record. A corrupted record is
  replaced. A read error is surfaced and never causes a new key to be generated.
- `src/features/presence/presenceSync.ts` caches the identity registration (UID and public key, for
  12 hours) and the friend list (30 minutes, plus change notifications). A restart therefore does
  not call rate-limited Worker endpoints. Previously, frequent restarts could exhaust the
  10-per-hour identity limit and leave presence stopped.

## Lifecycle

| Scenario                                     | Behaviour                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| ID token expiry                              | `getIdToken()` refreshes silently. Realtime Database re-authenticates on token change.                |
| Service-worker restart                       | Auth and identity are reloaded from IndexedDB. Tab state comes from `storage.session`.                |
| Browser restart                              | Same as a worker restart. `storage.session` starts empty and tabs re-report.                          |
| Extension update or reload                   | IndexedDB and `storage.local` are kept. `storage.session` is cleared.                                 |
| Offline start                                | The SDK keeps the user. Presence start is retried every minute until the network returns.             |
| Firebase outage or rate limit during restore | The credential is kept. Startup reports `restore-failed` and retries.                                 |
| Firebase user deleted or disabled            | The credential can never be restored. The popup reports it, and Connect Twitch replaces it.           |
| Disconnect Twitch                            | The D1 mapping and presence are removed. The UID and private key are kept for a later reconnect.      |
| Delete my data                               | Server data, the Firebase user, the saved credential, the private key, and local storage are deleted. |
| Uninstall or clearing extension data         | Everything local is lost. This cannot be recovered without reconnecting Twitch.                       |

## Limits that cannot be removed safely

- An anonymous Firebase user has no second factor. If its refresh token is lost, the UID cannot be
  recovered. Twitch OAuth is the recovery path, and it is intentionally not bypassed.
- A non-extractable private key cannot be backed up. A new key is generated after data loss, and
  friends see the new public key after their next friend refresh.
- Firebase projects with Identity Platform's automatic anonymous-account cleanup enabled delete
  inactive anonymous users on the server. This is a project setting, not something the code can
  prevent.
