const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');

// Config
const STRAVA_CLUB_ID = process.env.STRAVA_CLUB_ID;
const START_DATE = new Date('2026-02-01');

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
            const res = await axios.get(`https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/activities`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                params: {
                    page: page,
                    per_page: perPage
                }
            });

            const activities = res.data;
            if (!activities || activities.length === 0) {
                keepFetching = false;
                break;
            }

            // Filter and Collect
            let addedFromPage = 0;
            for (const act of activities) {
                const actDate = new Date(act.start_date_local);

                if (actDate >= START_DATE) {
                    allActivities.push(act);
                    addedFromPage++;
                } else {
                    // Found an activity older than start date. 
                    // Since API returns reverse-chrono, we can stop.
                    keepFetching = false;
                }
            }

            console.log(`Page ${page}: Found ${activities.length} items, Kept ${addedFromPage} valid.`);

            // Safety break for empty pages or very deep history if API behaves oddly
            if (activities.length < perPage && keepFetching) {
                // If we got fewer than requested, we likely hit the end, 
                // but Strava filtering might hide some, so strictly we rely on the loop condition above.
                // However, in club feed, usually end of list means end of data.
            }

            page++;

            // Safety limit to prevent infinite loops if logic fails
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
    // STRATEGY: Wipe and Replace to ensure consistency and handle edits/deletions
    // NOTE: This assumes club feed provides enough history. 

    if (allActivities.length > 0) {
        await statsSheet.clearRows();

        // Reverse to insert oldest first? Or just insert all. 
        // Order doesn't strictly matter for the Leaderboard formulas, but looks nicer.
        // allActivities is Newest -> Oldest. Let's reverse it to Oldest -> Newest.
        allActivities.reverse();

        const rowsToAdd = allActivities.map(act => ({
            athlete_id: act.athlete.id || '', // Club API usually returns this in summary
            name: `${act.athlete.firstname} ${act.athlete.lastname}`,
            type: act.type,
            distance_meters: act.distance,
            moving_time: act.moving_time,
            elevation_gain: act.total_elevation_gain,
            date: act.start_date_local // ISO format
        }));

        // Batch add might be faster but google-spreadsheet limits batch size sometimes. 
        // addRow is safe. addRows is better for quota.
        await statsSheet.addRows(rowsToAdd);
        console.log('Stats sheet updated.');
    } else {
        console.log('No new activities found. Skipping sheet update.');
    }

    // 5. Update Metadata (Timestamps)
    try {
        await leaderboardSheet.loadCells('E2:F2');
        const now = new Date();
        const next = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2h interval

        leaderboardSheet.getCellByA1('E2').value = now.toISOString();
        leaderboardSheet.getCellByA1('F2').value = next.toISOString();

        await leaderboardSheet.saveUpdatedCells();
        console.log('Timestamps updated.');
    } catch (err) { console.error("Metadata update failed:", err.message); }
}

syncClub();
