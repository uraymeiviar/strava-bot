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

    // 2. Authenticate & Fetch Verified Users Data (Hybrid Mode)
    // We fetch this FIRST so we can prioritize it over Club data.
    const verifiedActivities = [];
    const verifiedAthletes = new Set(); // To store names/ids to exclude from Club feed

    // HELPER: Convert full name to "Firstname L." format for loose matching
    const toClubName = (fullName) => {
        if (!fullName) return '';
        const parts = fullName.trim().split(' ');
        if (parts.length === 1) return parts[0];
        const lastInitial = parts[parts.length - 1].charAt(0);
        return `${parts[0]} ${lastInitial}.`;
    };

    const athleteSheet = doc.sheetsByTitle['Athletes'];
    if (athleteSheet) {
        console.log('Fetching verified athlete activities...');
        try {
            const athleteRows = await athleteSheet.getRows();
            for (const row of athleteRows) {
                const name = row.get('name');
                const refreshToken = row.get('refresh_token');

                if (!refreshToken) continue;

                try {
                    // Auth as Individual
                    const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
                        client_id: process.env.STRAVA_CLIENT_ID,
                        client_secret: process.env.STRAVA_CLIENT_SECRET,
                        refresh_token: refreshToken,
                        grant_type: 'refresh_token'
                    });
                    const userAccessToken = tokenRes.data.access_token;

                    // Fetch Activities
                    const after = Math.floor(START_DATE.getTime() / 1000);
                    const before = Math.floor(END_DATE.getTime() / 1000);

                    const actsRes = await axios.get(`https://www.strava.com/api/v3/athlete/activities`, {
                        headers: { Authorization: `Bearer ${userAccessToken}` },
                        params: { after: after, before: before, per_page: 100 }
                    });

                    const userActs = actsRes.data;
                    console.log(`  - ${name}: Found ${userActs.length} activities.`);

                    for (const act of userActs) {
                        // Tag this activity as "Verified" so we know the source
                        act._isVerified = true;
                        act._athleteName = name; // Store full name
                        verifiedActivities.push(act);
                    }

                    // Add to exclusion list (both full name and club-formatted name)
                    verifiedAthletes.add(name);
                    verifiedAthletes.add(toClubName(name));

                } catch (err) {
                    console.error(`  - Failed to sync ${name}:`, err.message);
                }
            }
        } catch (err) {
            console.warn('Error reading Athletes sheet:', err.message);
        }
    } else {
        console.warn('Athletes sheet not found! Skipping hybrid sync.');
    }

    // 3. Authenticate with Strava (Club Admin Token)
    let clubAccessToken;
    try {
        const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
            client_id: process.env.STRAVA_CLUB_CLIENT_ID,
            client_secret: process.env.STRAVA_CLUB_CLIENT_SECRET,
            refresh_token: process.env.STRAVA_CLUB_REFRESH_TOKEN,
            grant_type: 'refresh_token'
        });
        clubAccessToken = tokenRes.data.access_token;
    } catch (err) {
        console.error('Failed to authenticate with Strava Club:', err.message);
        process.exit(1);
    }

    // 4. Fetch All Club Activities (Paginated)
    let allActivities = [...verifiedActivities]; // Start with verified ones
    let page = 1;
    const perPage = 200;
    let keepFetching = true;

    console.log(`Fetching Club activities (ID: ${STRAVA_CLUB_ID}) since ${START_DATE.toISOString()}...`);

    while (keepFetching) {
        try {
            const afterTimestamp = Math.floor(START_DATE.getTime() / 1000);
            const res = await axios.get(`https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/activities`, {
                headers: { Authorization: `Bearer ${clubAccessToken}` },
                params: {
                    page: page,
                    per_page: perPage,
                    after: afterTimestamp
                }
            });

            const activities = res.data;
            if (!activities || activities.length === 0) {
                keepFetching = false;
                break;
            }

            let addedFromPage = 0;
            let skippedDuplicates = 0;

            for (const act of activities) {
                const clubName = `${act.athlete.firstname} ${act.athlete.lastname}`;

                // DEDUPLICATION LOGIC:
                // If we already have this athlete in our Verified list, ignore the Club version.
                // We prefer the Verified version because it has the Date and ID.
                if (verifiedAthletes.has(clubName)) {
                    skippedDuplicates++;
                    continue;
                }

                // If not verified, add it (Unverified User)
                allActivities.push(act);
                addedFromPage++;
            }

            console.log(`Page ${page}: Fetched ${activities.length}. Kept ${addedFromPage} (New). Skipped ${skippedDuplicates} (Targeted).`);

            if (activities.length < perPage) {
                keepFetching = false;
            }

            page++;
            if (page > 10) keepFetching = false;

        } catch (err) {
            console.error(`Error fetching page ${page}:`, err.message);
            keepFetching = false;
        }
    }

    console.log(`Total activities to sync: ${allActivities.length}`);

    // 5. Update Stats Sheet
    if (allActivities.length > 0) {
        await statsSheet.clearRows();

        // Sort by Date Descending (Newest First)
        // Verified acts have `start_date_local`. Club acts don't (use fallback).
        allActivities.sort((a, b) => {
            const dateA = a.start_date_local ? new Date(a.start_date_local) : START_DATE;
            const dateB = b.start_date_local ? new Date(b.start_date_local) : START_DATE;
            return dateB - dateA; // Descending
        });

        const rowsToAdd = allActivities.map(act => {
            let athleteId, athleteName, dateStr;

            if (act._isVerified) {
                // High Quality Data
                athleteId = act.athlete.id;
                athleteName = act._athleteName; // Full Name from Sheet
                dateStr = act.start_date_local;
            } else {
                // Low Quality Data (Club Feed)
                athleteName = `${act.athlete.firstname} ${act.athlete.lastname}`;
                athleteId = act.athlete.id || athleteName.replace(/\s+/g, '_').toLowerCase();
                dateStr = act.start_date_local || START_DATE.toISOString(); // Fallback
            }

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
        console.log('No activities found.');
    }

    // 6. Update Metadata
    try {
        await leaderboardSheet.loadCells('E2:H2');
        const now = new Date();
        const next = new Date(now.getTime() + 2 * 60 * 60 * 1000);

        leaderboardSheet.getCellByA1('E2').value = now.toISOString();
        leaderboardSheet.getCellByA1('F2').value = next.toISOString();
        leaderboardSheet.getCellByA1('G2').value = START_DATE.toISOString();
        leaderboardSheet.getCellByA1('H2').value = END_DATE.toISOString();

        await leaderboardSheet.saveUpdatedCells();
        console.log('Timestamps updated.');
    } catch (err) { console.error("Metadata update failed:", err.message); }
}

syncClub();
