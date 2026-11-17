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

The plugin sends the secret in the `x-relay-secret` header.

## Settings (environment variables)

| Name | Required | Value |
|---|---|---|
| `RELAY_SECRET` | Yes | Long random string, same one the plugin holds |
| `ANTHROPIC_API_KEY` | Recommended | Claude API key. Without it the tablet's own reading is used unchanged |
| `CLICKUP_TOKEN` | Yes | ClickUp personal API token (starts with `pk_`) |
| `CLICKUP_LIST_ID` | Yes | List that captured tasks go into |
| `CALENDAR_ICS_URL` | For the Meeting button | The calendar's "Secret address in iCal format" from Google Calendar settings |
| `MY_EMAIL` | No | Your calendar email. Hides you from attendee lists and skips meetings you declined |
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
