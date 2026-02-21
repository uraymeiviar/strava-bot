const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');

async function sync() {
  const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.split(String.raw`\n`).join('\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(process.env.SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();

  const configSheet = doc.sheetsByTitle['Config'];
  const athleteSheet = doc.sheetsByTitle['Athletes'];
  const statsSheet = doc.sheetsByTitle['Stats'];
  const leaderboardSheet = doc.sheetsByTitle['Leaderboard'];

  // --- 1. Read Configuration (Dates) ---
  let START_DATE = new Date('2026-02-01T00:00:00Z');
  let END_DATE = new Date('2026-12-31T23:59:59Z');

  if (configSheet) {
    console.log('Reading Config sheet...');
    try {
      const rows = await configSheet.getRows();

      let foundVertical = false;
      for (const row of rows) {
        const key = row.get('Key');
        const value = row.get('Value');

        if (key === 'START_DATE' && value) {
          START_DATE = new Date(value);
          console.log(`Updated START_DATE to ${START_DATE.toISOString()}`);
          foundVertical = true;
        }
        if (key === 'END_DATE' && value) {
          END_DATE = new Date(value);
          console.log(`Updated END_DATE to ${END_DATE.toISOString()}`);
          foundVertical = true;
        }
      }

      if (!foundVertical && rows.length > 0) {
        const firstRow = rows[0];
        const horizontalStart = firstRow.get('START_DATE');
        const horizontalEnd = firstRow.get('END_DATE');

        if (horizontalStart) {
          START_DATE = new Date(horizontalStart);
          console.log(`Updated START_DATE (Horizontal) to ${START_DATE.toISOString()}`);
        }
        if (horizontalEnd) {
          END_DATE = new Date(horizontalEnd);
          console.log(`Updated END_DATE (Horizontal) to ${END_DATE.toISOString()}`);
        }
      }
    } catch (err) {
      console.warn('Error reading config sheet, using defaults.', err.message);
    }
  } else {
    console.log('No Config sheet found, using default dates.');
  }

  // --- PREVENT DUPLICATES ---
  // Wipe Stats so we re-push a fresh, unique list every time
  await statsSheet.clearRows();

  const athleteRows = await athleteSheet.getRows();
  let allActivities = [];

  for (const row of athleteRows) {
    const name = row.get('name');
    const athleteId = row.get('athlete_id');
    const refreshToken = row.get('refresh_token');

    if (!refreshToken) continue;

    try {
      const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      });

      const accessToken = tokenRes.data.access_token;
      const after = Math.floor(START_DATE.getTime() / 1000);
      const before = Math.floor(END_DATE.getTime() / 1000);

      // Fetch Activities for individual
      const actsRes = await axios.get(`https://www.strava.com/api/v3/athlete/activities`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { after: after, before: before, per_page: 100 }
      });

      const userActs = actsRes.data;
      console.log(`Synced data for: ${name}. Found ${userActs.length} activities.`);

      for (const act of userActs) {
        allActivities.push({
          athlete_id: athleteId,
          name: name,
          type: act.type,
          distance_meters: act.distance,
          moving_time: act.moving_time,
          elevation_gain: act.total_elevation_gain,
          date: act.start_date_local // ISO format from Strava
        });
      }
    } catch (err) { console.error(`Error for ${name}:`, err.message); }
  }

  // Sort globally by date descending
  allActivities.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Add all to Stats sheet
  if (allActivities.length > 0) {
    await statsSheet.addRows(allActivities);
    console.log(`Total ${allActivities.length} activities added to Stats.`);
  }

  // --- UPDATE TIMESTAMPS IN E2:H2 (Standard ISO Format + Period) ---
  try {
    await leaderboardSheet.loadCells('E2:H2');
    const now = new Date();
    const next = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2h interval

    // Write raw ISO strings so the browser can parse them into any timezone
    leaderboardSheet.getCellByA1('E2').value = now.toISOString();
    leaderboardSheet.getCellByA1('F2').value = next.toISOString();

    // Store period for frontend reading
    leaderboardSheet.getCellByA1('G2').value = START_DATE.toISOString();
    leaderboardSheet.getCellByA1('H2').value = END_DATE.toISOString();

    await leaderboardSheet.saveUpdatedCells();
    console.log('Metadata updated.');
  } catch (err) { console.error("Metadata update failed:", err.message); }
}

sync();