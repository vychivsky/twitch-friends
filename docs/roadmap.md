# Roadmap

Planned work. Nothing in this file is implemented yet; see the README for current behavior.

## v0.1.2

- Batch encrypted presence updates into one Firebase request for all friends.
- Support offline, online on Twitch without watching a channel, and watching-a-channel states.
- Style online and offline labels like Twitch category metadata with muted text and a lighter font weight.
- Keep the existing purple channel link when a friend is watching a stream.
- Keep backend refreshes within the existing request limits.
- Update consent, privacy information, and the store description for online presence sharing.

## v0.2.0

- Add a Twitch Friends button and panel to the Twitch top navigation.
- Show the number of active friends on the Twitch navigation button.
- Show incoming friend request notifications together with the full Twitch panel.
- Move Twitch profile, friends, requests, account controls, and settings into the Twitch panel.
- Keep the browser popup focused on security and runtime status.
- Localize the extension based on the Twitch interface language, with English as the fallback.
