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
      // Normalize headers to lowercase to avoid Key vs key issues
      await configSheet.loadHeaderRow();
      const origHeaders = configSheet.headerValues;

      // Only attempt to read rows if the sheet isn't completely empty
      if (origHeaders && origHeaders.length > 0) {
        const rows = await configSheet.getRows();
        const findHeader = (name) => origHeaders.find(h => h.trim().toLowerCase() === name.toLowerCase());

        const keyCol = findHeader('Key');
        const valCol = findHeader('Value');
        const startCol = findHeader('START_DATE');
        const endCol = findHeader('END_DATE');

        let foundVertical = false;

        // Check Vertical Layout (Key/Value)
        if (keyCol && valCol) {
          for (const row of rows) {
            const key = row.get(keyCol);
            const value = row.get(valCol);

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
        }

        // Check Horizontal Layout
        if (!foundVertical && rows.length > 0) {
          const firstRow = rows[0];
          if (startCol) {
            const horizontalStart = firstRow.get(startCol);
            if (horizontalStart) {
              START_DATE = new Date(horizontalStart);
              console.log(`Updated START_DATE (Horizontal) to ${START_DATE.toISOString()}`);
            }
          }
          if (endCol) {
            const horizontalEnd = firstRow.get(endCol);
            if (horizontalEnd) {
              END_DATE = new Date(horizontalEnd);
              console.log(`Updated END_DATE (Horizontal) to ${END_DATE.toISOString()}`);
            }
          }
        }
      }
    } catch (err) {
      console.warn('Error reading config sheet, using defaults.', err.message);
    }
  } else {
    console.log('No Config sheet found, using default dates.');
  }

  // --- PREVENT DUPLICATES ---
  // We will wipe Stats right before we push the new list to minimize downtime

  const athleteRows = await athleteSheet.getRows();
  let allActivities = [];

  const afterTimestamp = Math.floor(START_DATE.getTime() / 1000);
  const beforeTimestamp = Math.floor(END_DATE.getTime() / 1000);
  console.log(`\nGlobal Filter Range: \n  AFTER:  ${afterTimestamp} (${START_DATE.toISOString()})\n  BEFORE: ${beforeTimestamp} (${END_DATE.toISOString()})\n`);

  // --- 2. Load Whitelist (from 'participants' sheet) ---
  let whitelist = null;
  // Find the participants sheet case-insensitively
  const whitelistSheet = doc.sheetsByIndex.find(s => s.title.trim().toLowerCase() === 'participants');
  if (whitelistSheet) {
    console.log('Reading Whitelist from participants sheet...');
    try {
      await whitelistSheet.loadHeaderRow();
      const rows = await whitelistSheet.getRows();
      
      // Look for a column containing "User Name Strava" (ignoring case and spaces)
      let stravaNameCol = whitelistSheet.headerValues.find(h => {
        if (!h) return false;
        const normalized = h.toLowerCase().replace(/\s+/g, '');
        return normalized.includes('usernamestrava');
      });
      
      // Fallback: If not found, use the 3rd column (index 2) as requested
      if (!stravaNameCol && whitelistSheet.headerValues.length >= 3) {
        stravaNameCol = whitelistSheet.headerValues[2];
        console.log(`Could not find "User Name Strava" column. Falling back to 3rd column: "${stravaNameCol}"`);
      } else if (!stravaNameCol) {
        stravaNameCol = 'User Name Strava'; // Final fallback
      }
      
      whitelist = rows
        .map(r => r.get(stravaNameCol))
        .filter(name => name)
        .map(name => name.trim().toLowerCase());
        
      console.log(`Loaded ${whitelist.length} approved users from whitelist.`);
    } catch (err) {
      console.warn('Error reading whitelist, skipping filter.', err.message);
    }
  } else {
    console.log('No participants sheet found, whitelist filtering disabled.');
  }

  for (const row of athleteRows) {
    const name = row.get('name');
    const athleteId = row.get('athlete_id');
    const refreshToken = row.get('refresh_token');

    if (!refreshToken) continue;

    // --- Whitelist Filter ---
    let isVerified = true; // Default to true if whitelist is disabled
    if (whitelist !== null) {
      isVerified = whitelist.includes(name.trim().toLowerCase());
    }

    try {
      // Try to update the 'verified' column, but ONLY if it changed to prevent Google API rate limits (Error 429)
      const newStatus = isVerified ? 'TRUE' : 'FALSE';
      if (row.get('verified') !== newStatus) {
        row.set('verified', newStatus);
        await row.save();
      }
    } catch (e) {
      // Ignore error if the 'verified' column doesn't exist yet in the Google Sheet
    }

    if (!isVerified) {
      console.log(`Skipping ${name}: Not found in the participants whitelist.`);
      continue;
    }

    let isAuthorized = true;

    try {
      const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      });

      const accessToken = tokenRes.data.access_token;

      // Fetch Activities for individual
      const actsRes = await axios.get(`https://www.strava.com/api/v3/athlete/activities`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { after: afterTimestamp, before: beforeTimestamp, per_page: 100 }
      });

      const userActs = actsRes.data;

      if (userActs.length > 0) {
        console.log(`Synced data for: ${name}. Found ${userActs.length} activities.`);

        for (const act of userActs) {
          allActivities.push({
            athlete_id: athleteId,
            name: name,
            // Use 'sport_type' which contains newer sports like Padel/Pilates. Fallback to 'type' for older data.
            type: act.sport_type || act.type,
            distance_meters: act.distance,
            moving_time: act.moving_time,
            elevation_gain: act.total_elevation_gain,
            date: act.start_date_local // ISO format from Strava
          });
        }
      } else {
        // Extra log for zero activities to help debug
        console.log(`Synced data for: ${name}. Found 0 activities extending between ${START_DATE.toISOString().split('T')[0]} and ${END_DATE.toISOString().split('T')[0]}.`);
      }

    } catch (err) {
      console.error(`Error for ${name}:`, err.message);
      if (err.response && err.response.status === 401) {
        isAuthorized = false;
      }
    }

    try {
      const authStatusStr = isAuthorized ? 'TRUE' : 'FALSE';
      let needsSave = false;

      if (row.get('strava authorized') !== authStatusStr) {
        row.set('strava authorized', authStatusStr);
        needsSave = true;
      }

      // If they synced successfully, update the 'last sync' timestamp
      if (isAuthorized) {
        row.set('last sync', new Date().toISOString());
        needsSave = true;
      }

      if (needsSave) {
        await row.save();
        // Add a 1.5-second delay to prevent Google Sheets 429 Quota limit!
        // (Google only allows 60 write requests per minute)
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      // Ignore error if column doesn't exist
    }
  }

  // Sort globally by date descending
  allActivities.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Add all to Stats sheet
  if (allActivities.length > 0) {
    // Wipe Stats right before adding new rows to prevent long empty periods on the website
    await statsSheet.clearRows();
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