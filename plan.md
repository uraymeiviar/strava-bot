# Project Plan: Strava Custom Monthly Challenge Tracker

## 1. Objective
Build a serverless, zero-cost system to track Strava Club members' activities over a specific month. The system will calculate points based on custom logic (e.g., distance, elevation, frequency) and display a leaderboard on a static web page.

---

## 2. Technical Stack
| Layer | Tool | Purpose |
| :--- | :--- | :--- |
| **Storage** | Google Sheets | Acts as the "Admin Database" for athlete tokens and calculated scores. |
| **Auth Handler** | Google Cloud Function (Node.js) | Processes the one-time OAuth2 callback to capture user refresh tokens. |
| **Sync Engine** | GitHub Actions (Cron) | Nightly Node.js script that fetches Strava data and updates the leaderboard. |
| **Frontend** | GitHub Pages (Static) | Displays `scoreboard.json` and hosts the "Join Challenge" button. |

---

## 3. Data Schema (Google Sheets)
### Tab: `Athletes`
* `athlete_id` (Primary Key)
* `name`
* `refresh_token` (The "Golden Ticket" for background sync)

### Tab: `Stats`
* `athlete_id`
* `name`
* `total_distance`
* `total_elevation`
* `total_points`
* `last_updated`

---

## 4. Module 1: The Registration Portal (Registration & Auth)
**Goal:** Convert a one-time user click into a long-term background access token.

1. **The Button:** A link on the GitHub Pages site:
   `https://www.strava.com/oauth/authorize?client_id=[ID]&response_type=code&redirect_uri=[CLOUD_FUNCTION_URL]&scope=read,activity:read_all`
2. **The Callback (Cloud Function):**
   * Receive `code` from Strava.
   * Exchange `code` for `access_token` and `refresh_token` via `POST https://www.strava.com/oauth/token`.
   * Save the `athlete_id`, `name`, and `refresh_token` to the **Athletes** tab in Google Sheets.
   * Redirect user back to the website with a `?status=success` flag.

---

## 5. Module 2: The Nightly Sync Engine (Data Processing)
**Goal:** Automatically update scores while everyone is sleeping.

1. **GitHub Action (.github/workflows/sync.yml):**
   * Scheduled to run via `cron: "0 2 * * *"` (2 AM UTC).
2. **The Sync Script (`sync.js`):**
   * Fetch all rows from the **Athletes** Google Sheet.
   * For each athlete:
     * Refresh the `access_token` using the `refresh_token`.
     * Fetch activities for the current month using `GET /athlete/activities?after=[EPOCH_TIMESTAMP]`.
     * **Logic:** Apply scoring math (e.g., `(distance * 1) + (elevation * 0.5)`).
     * Update the **Stats** tab in Google Sheets.
   * **Output:** Save the final leaderboard as `scoreboard.json` and `git commit` it back to the repository.

---

## 6. Module 3: The Public Dashboard (Frontend)
**Goal:** A fast, professional-looking leaderboard.

1. **`index.html`:**
   * Reads `scoreboard.json` using standard JavaScript `fetch()`.
   * Uses a simple table or card layout (Tailwind CSS recommended) to show the rankings.
   * Displays the "Connect with Strava" button for new participants.

---

## 7. Security & Secrets Management
* **Environment Variables:**
  * `STRAVA_CLIENT_ID`
  * `STRAVA_CLIENT_SECRET`
  * `GOOGLE_SERVICE_ACCOUNT_JSON` (Used to talk to the Sheets API)
* **Storage:** These must be stored in **GitHub Actions Secrets** and **Google Cloud Secret Manager** (or Function Env Vars).

---

## 8. Implementation Steps
1. [ ] Setup Strava API Application.
2. [ ] Setup Google Cloud Project + Service Account + Sheets API.
3. [ ] Deploy Cloud Function for OAuth callback.
4. [ ] Write `sync.js` logic and test locally with one athlete.
5. [ ] Configure GitHub Action to automate `sync.js`.
6. [ ] Build the static UI and enable GitHub Pages.