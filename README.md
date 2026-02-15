Technical Architecture

This project is a leaderboard for the strava custom challenge. It automates the collection of activity data from Strava and uses Google Sheets as a serverless database and calculation engine.

---

## 🏗 System Architecture

The project follows a decoupled, event-driven architecture designed to minimize server costs and maximize data transparency.

### 1. Registration & Auth (Google Cloud Function)
The **Google Cloud Function** serves as the initial gateway for participants.
* **OAuth Handler**: When a user clicks "Connect with Strava," they are redirected to the Cloud Function URL.
* **Token Exchange**: The function receives the authorization code, exchanges it for a permanent `refresh_token`, and retrieves the athlete's basic profile info.
* **Database Entry**: It writes the athlete's name, ID, and refresh token into the **'Athletes'** tab of the Google Sheet.
* **cloudfunction** folder: as the reference of what the cloud function run

### 2. The Data Plumber (`sync.js`)
This Node.js script acts as a "dumb pusher," responsible only for the movement of raw data.
* **Scheduled Execution**: It runs every 2 hours via a GitHub Actions cron job.
* **Strava Synchronization**: It iterates through every registered athlete, uses their refresh tokens to get fresh access tokens, and pulls all activities recorded after Feb 1, 2026.
* **Raw Data Dump**: The script appends every activity detail (distance, moving time, elevation, date, and type) to the **'Stats'** tab. It does not perform any calculations.
* **Status Updates**: Upon a successful sync, it updates cells **E2** (Last Sync) and **F2** (Next Sync) in the **'Leaderboard'** tab to provide live status updates for the frontend.

### 3. Automation Orchestrator (`.github/workflows/`)
The YAML files in this directory define the **GitHub Actions** that keep the leaderboard alive without manual intervention.
* **Cron Scheduling**: A `schedule` event triggers the workflow at specific intervals (e.g., every 2 hours).
* **Environment Provisioning**: GitHub spins up a virtual runner, installs **Node.js**, and runs `npm install` to prepare the dependencies.
* **Secret Management**: The workflow securely injects GitHub Secrets (like `STRAVA_CLIENT_ID` and `GOOGLE_PRIVATE_KEY`) as environment variables so `sync.js` can authenticate safely.
* **Workflow Logic**: It executes `node sync.js`, triggering the entire data pipeline from Strava to Google Sheets.

### 4. The Backend (Google Sheets)
The Google Sheet is the central "Brain" and Database of the project.
* **Storage**: Holds the permanent registry of athletes and the cumulative log of raw activities.
* **Logic Hub**: All aggregation, filtering, and ranking are handled by native spreadsheet formulas (such as `QUERY`) within the sheet itself.
* **Web API**: The **'Leaderboard'** tab is published as a CSV file, allowing the frontend to read live data without requiring complex API keys.

### 5. The Frontend (`index.html`)
A static, responsive dashboard hosted on GitHub Pages.
* **CSV Parsing**: On every page load, it fetches the Published CSV from Google Sheets and parses the rows into a readable format.
* **State Management**: Uses `localStorage` to check if a user has already registered, toggling between the "Connect" button and a "You're Connected" status.

---

## 🖥 What the Web Page Shows

The user interface is designed for clarity and real-time tracking of the challenge.

### 1. Header & Identity
* **Title**: "ITB Challenge Leaderboard" with sports emojis.
* **Subtitle**: "Track your progress, compete with peers".

### 2. Join the Challenge (Left Card)
* **Unregistered State**: Displays a "Connect with Strava" button that initiates the OAuth flow.
* **Registered State**: Displays a "You're Connected!" message with a checkmark icon, hiding the registration button.

### 3. Live Standings (Right Card)
* **Sync Metadata**: Located at the top right of the standings. It shows the **Last Updated** time (from cell E2) and the **Next Update Scheduled** time (from cell F2) in WIB.
* **Leaderboard Table**: A ranked list showing:
    * **Rank**: 🥇, 🥈, 🥉 icons for the top three, followed by numerical ranks (#4, etc.).
    * **Athlete**: The name of the participant.
    * **Points**: The total calculated score.
    * **Last Recorded**: The timestamp of the athlete's most recent activity synced from Strava.

### 4. Notifications
* **Success Alert**: An animated blue alert bar that appears only after a successful registration to confirm the connection was established.

---

## 📊 Data Flow Summary

1. **Athlete Registration**: Website -> Strava -> Cloud Function -> **'Athletes' Sheet**.
2. **Activity Sync**: GitHub Action -> `sync.js` -> Strava API -> **'Stats' Sheet**.
3. **Data Aggregation**: **'Stats' Sheet** -> Spreadsheet Formulas -> **'Leaderboard' Sheet**.
4. **Display**: Website -> **'Leaderboard' CSV** -> Live Standings.

---

## 📂 Sheet Tab & Column Definitions

### 1. **'Athletes' Tab**
*Managed by: Google Cloud Function*.
This is the participant registry.
| Column | Description |
| :--- | :--- |
| **name** | The full name of the athlete from their Strava profile. |
| **athlete_id** | Unique Strava identifier used for API requests. |
| **refresh_token** | Persistent token used to generate temporary access tokens during sync. |

### 2. **'Stats' Tab**
*Managed by: `sync.js` (Rows 2+) and Header Formulas (Row 1)*.
The raw activity log where every exercise is recorded.
| Column | Description |
| :--- | :--- |
| **athlete_id** | Links the activity to a specific participant. |
| **name** | Athlete name for easy reading in raw logs. |
| **type** | The activity category (e.g., Run, Ride, Swim, Walk). |
| **distance_meters** | The raw distance in meters as reported by Strava. |
| **moving_time** | Total active duration in seconds. |
| **elevation_gain** | Total vertical gain in meters. |
| **points** | **(Calculated)** Distance converted to km and multiplied by specific activity weights. |
| **date** | The ISO timestamp of when the activity started. |

### 3. **'Leaderboard' Tab**
*Managed by: Spreadsheet Formulas (A-C) and `sync.js` (E-F)*.
The aggregated data published to the frontend.
| Column | Description |
| :--- | :--- |
| **Name (A)** | Aggregated unique athlete names from the Stats tab. |
| **Points (B)** | Sum total of all points earned by the athlete. |
| **Last Activity (C)** | The most recent timestamp found for that athlete. |
| **Last Update (E)** | Raw ISO timestamp of the most recent successful script run. |
| **Next Update (F)** | Calculated timestamp for the next scheduled synchronization. |

### 4. **'Mapping' Tab**
*Managed by: Manual Input (The "Control Panel")*.
This tab defines how much each activity is worth. Adding a new row here automatically updates the points for all athletes.
| Column | Description |
| :--- | :--- |
| **Activity Type** | The exact name of the activity from Strava (e.g., Run, Ride, Swim). |
| **Weight** | The multiplier applied to the distance in kilometers. |