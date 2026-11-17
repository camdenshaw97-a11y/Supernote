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
| `GET /oauth/start` | No (browser page) | One-time: connect Google Calendar by signing in |

The plugin sends the secret in the `x-relay-secret` header.

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
