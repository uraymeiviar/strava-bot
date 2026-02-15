Technical Architecture

This project is a high-performance leaderboard for the strava custom challenge. It automates the collection of activity data from Strava and uses Google Sheets as a serverless database and calculation engine.

---

## 🏗 System Architecture

The project follows a decoupled, event-driven architecture designed to minimize server costs and maximize data transparency.

### 1. Registration & Auth (Google Cloud Function)
The **Google Cloud Function** serves as the initial gateway for participants.
* **OAuth Handler**: When a user clicks "Connect with Strava," they are redirected to the Cloud Function URL.
* **Token Exchange**: The function receives the authorization code, exchanges it for a permanent `refresh_token`, and retrieves the athlete's basic profile info.
* **Database Entry**: It writes the athlete's name, ID, and refresh token into the **'Athletes'** tab of the Google Sheet.

### 2. The Data Plumber (`sync.js`)
This Node.js script acts as a "dumb pusher," responsible only for the movement of raw data.
* **Scheduled Execution**: It runs every 2 hours via a GitHub Actions cron job.
* **Strava Synchronization**: It iterates through every registered athlete, uses their refresh tokens to get fresh access tokens, and pulls all activities recorded after Feb 1, 2026.
* **Raw Data Dump**: The script appends every activity detail (distance, moving time, elevation, date, and type) to the **'Stats'** tab. It does not perform any calculations.
* **Status Updates**: Upon a successful sync, it updates cells **E2** (Last Sync) and **F2** (Next Sync) in the **'Leaderboard'** tab to provide live status updates for the frontend.

### 3. The Backend (Google Sheets)
The Google Sheet is the central "Brain" and Database of the project.
* **Storage**: Holds the permanent registry of athletes and the massive log of raw activities.
* **Calculation Engine**: All aggregation, filtering, and ranking are handled by native spreadsheet formulas (like `QUERY` and `ARRAYFORMULA`).
* **Web API**: The **'Leaderboard'** tab is published as a CSV file, allowing the frontend to read the data without complex API keys or database drivers.

### 4. The Frontend (`index.html`)
A static, responsive dashboard hosted on GitHub Pages.
* **CSV Reader**: On every page load, it fetches the Published CSV link from Google Sheets.
* **Live UI Rendering**: It parses the CSV to display the current ranks, name, points, and the time of the last recorded activity for each athlete.
* **Sync Labels**: It extracts metadata from Row 2 of the CSV to display exactly when the data was last updated and when the next run is scheduled.
* **Session Management**: Uses `localStorage` to toggle between the "Connect with Strava" registration button and a "You're Connected" status for returning users.

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

## 📂 Sheet Tab Definitions

| Tab Name | Managed By | Description |
| :--- | :--- | :--- |
| **Athletes** | Cloud Function | Registry of athlete names, IDs, and OAuth refresh tokens. |
| **Stats** | `sync.js` | Raw, uncalculated list of every activity distance and date. |
| **Leaderboard** | Sheet Formulas | Aggregated view of ranks, points, and sync timing headers. |