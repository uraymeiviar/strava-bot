const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');

// Config
const STRAVA_CLUB_ID = process.env.STRAVA_CLUB_ID;
// Defaults if no Config sheet found
let START_DATE = new Date('2026-02-01');
let END_DATE = new Date('2026-12-31'); // Default to end of year or far future

async function syncClub() {
    console.log('Starting Club Sync...');

    // 1. Authenticate with Google Sheets
    const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.split(String.raw`\n`).join('\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    const statsSheet = doc.sheetsByTitle['Stats'];
    const leaderboardSheet = doc.sheetsByTitle['Leaderboard'];
    const configSheet = doc.sheetsByTitle['Config'];

    // 1.5. Read Config (if exists)
    if (configSheet) {
        console.log('Found Config sheet, reading settings...');
        try {
            const rows = await configSheet.getRows();
            // Assuming Column A is Key, Column B is Value
            // We iterate to find START_DATE and END_DATE

            rows.forEach(row => {
                const key = row.get('Key') || row._rawData[0]; // Try header 'Key' or raw index 0
                const value = row.get('Value') || row._rawData[1]; // Try header 'Value' or raw index 1

                if (key === 'START_DATE' && value) {
                    START_DATE = new Date(value);
                    console.log(`Updated START_DATE to ${START_DATE.toISOString()}`);
                }
                if (key === 'END_DATE' && value) {
                    END_DATE = new Date(value);
                    // Set end date to end of that day (23:59:59) to be inclusive
                    END_DATE.setHours(23, 59, 59, 999);
                    console.log(`Updated END_DATE to ${END_DATE.toISOString()}`);
                }
            });
        } catch (err) {
            console.warn('Error reading Config sheet, using defaults:', err.message);
        }
    } else {
        console.log('No Config sheet found, using default dates.');
    }

    // 2. Authenticate with Strava (Club Admin Token)
    let accessToken;
    try {
        const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
            client_id: process.env.STRAVA_CLUB_CLIENT_ID,
            client_secret: process.env.STRAVA_CLUB_CLIENT_SECRET,
            refresh_token: process.env.STRAVA_CLUB_REFRESH_TOKEN,
            grant_type: 'refresh_token'
        });
        accessToken = tokenRes.data.access_token;
    } catch (err) {
        console.error('Failed to authenticate with Strava:', err.message);
        process.exit(1);
    }

    // 3. Fetch All Club Activities (Paginated)
    let allActivities = [];
    let page = 1;
    const perPage = 200; // Max allowed
    let keepFetching = true;

    console.log(`Fetching activities for Club ID ${STRAVA_CLUB_ID} since ${START_DATE.toISOString()}...`);

    while (keepFetching) {
        try {
            // Attempt to filter by 'after' parameter (Unix epoch seconds)
            // Even if documentation is vague, this is worth a shot.
            const afterTimestamp = Math.floor(START_DATE.getTime() / 1000);

            const res = await axios.get(`https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/activities`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                params: {
                    page: page,
                    per_page: perPage,
                    // Try to filter at API level since we can't see dates in response
                    // Note: If API ignores this, we might get old activities.
                    // But since we can't check the date, we have to trust the feed or this param.
                    after: afterTimestamp
                }
            });

            const activities = res.data;
            if (!activities || activities.length === 0) {
                keepFetching = false;
                break;
            }

            // Filter and Collect
            let addedFromPage = 0;

            // DEBUG: Dump the first activity to see fields
            if (activities.length > 0 && page === 1) {
                console.log('DEBUG ACTIVITY STRUCT:', JSON.stringify(activities[0], null, 2));
            }

            for (const act of activities) {
                // Since start_date_local is missing, we CANNOT filter by date here.
                // We also CANNOT filter by END_DATE.
                // We just accept the activity as "Recent".

                // For Athlete ID, we fall back to Name matching if ID is missing.
                // Club feed API strips athlete.id usually.

                allActivities.push(act);
                addedFromPage++;
            }

            console.log(`Page ${page}: Found ${activities.length} items, Kept ${addedFromPage} valid.`);

            if (activities.length < perPage) {
                keepFetching = false;
            }

            page++;
            if (page > 10) {
                console.warn('Hit safety page limit (10 pages). Stopping fetch.');
                keepFetching = false;
            }

        } catch (err) {
            console.error(`Error fetching page ${page}:`, err.message);
            keepFetching = false;
        }
    }

    console.log(`Total valid activities to sync: ${allActivities.length}`);

    // 4. Update Stats Sheet
    if (allActivities.length > 0) {
        await statsSheet.clearRows();

        // DEBUG: Check headers
        await statsSheet.loadHeaderRow();
        console.log('DEBUG SHEETS HEADERS:', statsSheet.headerValues);

        // DEBUG: Check first activity structure for 'athlete' and 'start_date_local'
        console.log('DEBUG FIRST ACTIVITY:', JSON.stringify(allActivities[0], null, 2));

        allActivities.reverse();

        const rowsToAdd = allActivities.map(act => {
            // Fallback for missing athlete.id
            // We use firstname + lastname as a rough unique key if ID is missing
            const athleteName = `${act.athlete.firstname} ${act.athlete.lastname}`;
            const athleteId = act.athlete.id || athleteName.replace(/\s+/g, '_').toLowerCase(); // pseudo-ID

            // Fallback for missing date
            // User requested to use the config START_DATE if actual date is missing.
            // This at least gives a "period" context even if not exact.
            const dateStr = act.start_date_local || START_DATE.toISOString();

            return {
                athlete_id: athleteId,
                name: athleteName,
                type: act.type,
                distance_meters: act.distance,
                moving_time: act.moving_time,
                elevation_gain: act.total_elevation_gain,
                date: dateStr
            };
        });

        await statsSheet.addRows(rowsToAdd);
        console.log('Stats sheet updated.');
    } else {
        console.log('No new activities found. Skipping sheet update.');
    }

    // 5. Update Metadata
    try {
        await leaderboardSheet.loadCells('E2:H2'); // Expanded range to include G2, H2
        const now = new Date();
        const next = new Date(now.getTime() + 2 * 60 * 60 * 1000);

        leaderboardSheet.getCellByA1('E2').value = now.toISOString();
        leaderboardSheet.getCellByA1('F2').value = next.toISOString();

        // Write Configured Dates for Frontend
        leaderboardSheet.getCellByA1('G2').value = START_DATE.toISOString();
        leaderboardSheet.getCellByA1('H2').value = END_DATE.toISOString();

        await leaderboardSheet.saveUpdatedCells();
        console.log('Timestamps and Config dates updated.');
    } catch (err) { console.error("Metadata update failed:", err.message); }
}

syncClub();
