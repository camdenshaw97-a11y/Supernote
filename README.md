# Nomad Bridge relay

Small service that sits between the Nomad Bridge Supernote plugin and the apps it files things into.

The plugin sends circled handwriting here. The relay asks Claude to clean it up, creates the task, and replies with a short receipt the plugin writes back onto the page.

## Endpoints

| Endpoint | Needs secret | What it does |
|---|---|---|
| `GET /health` | No | Confirms the service is awake |
| `GET /status` | Yes | Shows which keys are configured |
| `POST /capture` | Yes | Handwriting in, task out |
| `GET /meeting/upcoming` | Yes | Calendar events for the next day and a half |
| `POST /meeting/end` | Yes | Pictures of the meeting's pages in; summary out, and the note-taker's own action items filed as tasks |
| `POST /page/save` | Yes | One page picture in; Claude copies out the writing and the page is kept in the notes archive (only when the archive is on) |
| `GET /page/hint` | Yes | Whether the tablet numbers the page on screen from 0 or from 1, once a save has shown which |
| `POST /mcp` | Own token | Read-only connector so Claude can search and read the notes archive (only when the archive is on) |
| `GET /oauth/start` | No (browser page) | One-time: connect Google Calendar by signing in |

The plugin sends the secret in the `x-relay-secret` header.

### Meeting → End

The plugin sends up to 8 page pictures and, when it knows it, the meeting they belong to. If it does not, the relay uses the calendar meeting that is running or ended most recently. Claude copies out the handwriting, writes a short summary and separates the note-taker's action items from other people's. Only the note-taker's become tasks. A `requestId` makes a repeated request safe: the same id never files twice.

### Save page

The plugin's "Save page" button sends the picture of one notebook page with its notebook path and page number. Claude copies out everything on it and gives it a short title; the page is saved in the notes archive as a note of kind `page`. Nothing is filed anywhere else. Saving the same page again after adding to it replaces the earlier copy (same notebook, same page number, and most of the earlier writing still there); otherwise it is kept as a new note. If Claude cannot be reached the picture is saved anyway and the reply says so. A relay without `NOTES_DIR` answers 503.

### Notes archive and connector

With `NOTES_DIR` set, every capture, every saved page and every ended meeting is saved there (`records/*.json`, `pages/*.png`). With `NOTES_MCP_TOKEN` also set, `/mcp` serves a small read-only Model Context Protocol connector with four tools: `search_notes`, `list_recent_notes`, `read_note` and `get_note_page_image`. Add it in Claude as a custom connector with the header `Authorization: Bearer <token>`. It cannot file, change or delete anything.

## Settings (environment variables)

| Name | Required | Value |
|---|---|---|
| `RELAY_SECRET` | Yes | Long random string, same one the plugin holds |
| `ANTHROPIC_API_KEY` | Recommended | Claude API key. Without it the tablet's own reading is used unchanged |
| `CLICKUP_TOKEN` | Yes | ClickUp personal API token (starts with `pk_`) |
| `CLICKUP_LIST_ID` | Yes | List that captured tasks go into |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | For the Meeting button | From a Google Cloud OAuth client (type: Web application, redirect URI `<relay address>/oauth/callback`) |
| `GOOGLE_REFRESH_TOKEN` | For the Meeting button | Shown once after signing in at `/oauth/start` |
| `CALENDAR_ICS_URL` | Alternative to the three above | The calendar's "Secret address in iCal format", if your Google account shows one |
| `MY_EMAIL` | No | Only with `CALENDAR_ICS_URL`: hides you from attendee lists and skips meetings you declined |
| `CLICKUP_BRIEF_LIST_ID` | No | ClickUp list holding meeting briefs (written by a scheduled Claude task). When set, each meeting in `/meeting/upcoming` carries a `brief` array |
| `SHOW_ALL_EVENTS` | No | Set to `1` to list every timed calendar entry. By default only entries with another attendee or a video-call link are listed |
| `NOTES_DIR` | No | Folder for the notes archive. Unset = nothing is kept |
| `NOTES_MCP_TOKEN` | No | Long random string. Turns on the `/mcp` connector (needs `NOTES_DIR`) |
| `OWNER_NAME` | No | The note-taker's first name, so their action items can be told apart from other people's |
| `HOST` | No | Address to listen on, e.g. `127.0.0.1`. Default: all addresses |
| `TIMEZONE` | No | Default `America/Los_Angeles` |
| `CLAUDE_MODEL` | No | Default `claude-sonnet-5-5` |
| `DRY_RUN` | No | `1` = do everything except create the task |

Never put keys in this repo. Set them in the host's environment settings.

## Run

Needs Node 22 or newer. Run `npm install` once.

```
node server.js
```

On Render: build command `npm install`, start command `npm start`.
