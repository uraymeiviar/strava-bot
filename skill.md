---
name: strava-challenge-manager
description: Handles the end-to-end workflow for syncing Strava activities, refreshing OAuth tokens, and updating the Google Sheets leaderboard.
---

# Strava Challenge Management Skill

## When to use this skill
Use this skill when you need to:
* Debug the daily sync script (`sync.js`).
* Manually trigger a data refresh for a specific athlete.
* Update the scoring logic for the monthly challenge.
* Troubleshoot Google Sheets API connection issues.

## Procedural Workflows

### 1. Refreshing Athlete Tokens
If a sync fails due to 401 Unauthorized:
1. Locate the athlete in the `Athletes` tab of the Google Sheet.
2. Use the `refresh_token` to call `POST https://www.strava.com/oauth/token`.
3. Overwrite the old `refresh_token` with the new one returned by Strava.

### 2. Updating Scoring Logic
When modifying `sync.js`, ensure the math aligns with:
* **Running:** 10 points per km.
* **Cycling:** 2 points per km.
* **Elevation:** 1 bonus point per 50m of gain.

## Key Constraints
* **Never** log the `STRAVA_CLIENT_SECRET` or `GOOGLE_PRIVATE_KEY` to the console.
* **Always** use `after` timestamps in API calls to avoid duplicate data.
* **Batch Writes:** When updating Google Sheets, batch the updates to avoid rate limits.

## Reference Files
* `.github/workflows/sync.yml` - The cron configuration.
* `sync.js` - The core processing engine.
* `plan.md` - The architectural source of truth.