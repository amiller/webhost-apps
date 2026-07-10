# feedling-web

Doomscroll notifier — a "feedling" pet whose mood tracks your YouTube Shorts watching.
Reads your YouTube watch history through the oauth3 **youtube** plugin (a user-approved,
scoped, per-subject token — see below), computes an energy/vibe/state, writes a diary via
an LLM, and sends web-push nudges (VAPID) when you've been scrolling too long.

Deno app, deployed as a tee-daemon project on the pod. Live: https://pod.dstack.soc1024.com/feedling-web/

## How it reads YouTube
- Connects to `OAUTH3_NODE` (`https://pod.dstack.soc1024.com/oauth3`) and calls the `youtube`
  plugin's `list()`.
- **Token binding matters:** feedling must hold a token bound to *your* subject (the one the
  extension syncs cookies to), NOT `owner`. Leave `OAUTH3_TOKEN` **unset** so it runs the
  connect handshake and you approve it while signed in — that binds it to your jar. A pinned
  owner token reads the wrong (owner) jar and shows "cookies expired".
- The youtube plugin captures **`.youtube.com` cookies only** — including `.google.com` causes
  a flat-jar domain collision that overwrites youtube's session cookies (see oauth3-server).

## Env
`OAUTH3_NODE`, (optional) `OAUTH3_TOKEN` — leave unset to use the handshake, `OPENROUTER_API_KEY`,
`DIARY_MODEL`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`, `TZ` (e.g. `America/New_York`
— day-boundary + night-owl logic runs in the container clock, so set it), and (optional)
`FEEDLING_VERBOSE=1`.

## Test / verbose mode (`FEEDLING_VERBOSE=1`)
For testing, you want to know the next time you watch **anything** — including a regular
(non-short) video, even briefly. Verbose mode widens activity to growth in **total history
items** (not just shorts), polls idle every **60s** (instead of 5min) so a short watch isn't
missed, and fires a `watch_detected` push on the **first new item of a session**
(`"you watched something just now — N new item(s)"`). Toggle it without a redeploy from the UI
("test mode" button) or `POST /api/verbose {"enabled":true}` / `GET /api/verbose`; default is
off and normal-mode behavior is unchanged.

## Deploy
Source-tarball deploy to the pod's tee-daemon (`POST /_api/projects`, Bearer `TEE_DAEMON_TOKEN`),
`runtime: deno`, `entry: server.ts`, `isolation: container`, `oci_runtime: runc`.

## Known gaps
- YouTube history items carry **no per-item watch date** (the plugin's `parseHistory` discards
  YouTube's day-section headers), so feedling cannot honestly compute "today". It refuses to
  mislabel: when items lack `date`, `todayHonest` is false, `videosToday` is the whole recent
  page, and the UI card reads "what you watched (all history)" — never "today". When the plugin
  stamps items with dates (tracked upstream in oauth3-server), `videosToday`/the shorts list
  become real start-of-day-filtered counts and the card relabels to "today". `shortsToday` stays
  a since-midnight delta either way.
