const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const fs = require('fs');

async function sync() {
  const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.split(String.raw`\n`).join('\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(process.env.SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  
  const athleteSheet = doc.sheetsByTitle['Athletes'];
  const statsSheet = doc.sheetsByTitle['Stats'];
  const athleteRows = await athleteSheet.getRows();

  // --- PHASE 1: WRITE RAW DATA (Columns A-F + Date) ---
  for (const row of athleteRows) {
    const name = row.get('name');
    const athleteId = row.get('athlete_id');

    try {
      const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        refresh_token: row.get('refresh_token'),
        grant_type: 'refresh_token'
      });

      const accessToken = tokenRes.data.access_token;
      const after = Math.floor(new Date('2026-02-01').getTime() / 1000); // Challenge Start
      const activities = await axios.get(`https://www.strava.com/api/v3/athlete/activities?after=${after}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      for (const act of activities.data) {
          // We assume your spreadsheet has headers: 
          // athlete_id, name, type, distance_meters, moving_time, elevation_gain, points, date
          
          // Check for duplicates (simple check based on raw data match could be added here)
          // For now, we append.
          
          await statsSheet.addRow({
              athlete_id: athleteId,
              name: name,
              type: act.type,
              distance_meters: act.distance,         
              moving_time: act.moving_time,           
              elevation_gain: act.total_elevation_gain,
              // We SKIP 'points' (Column G) so the Sheet Formula can calculate it
              date: act.start_date_local // Column H (Needed for "Last Activity" display)
          });
      }
    } catch (err) {
      console.error(`Error processing ${name}:`, err.message);
    }
  }

  // --- PHASE 2: READ & AGGREGATE (Sum up the calculated points) ---
  // Re-load the stats sheet to get the calculated values from Column G
  const statsRows = await statsSheet.getRows(); 
  
  let leaderboardMap = {};

  for (const row of statsRows) {
      const id = row.get('athlete_id');
      const name = row.get('name');
      // Read the point value calculated by your Sheet Formula (Column G)
      const points = parseFloat(row.get('points')) || 0; 
      const activityDate = row.get('date');

      if (!leaderboardMap[id]) {
          leaderboardMap[id] = { name: name, totalPoints: 0, lastActivityTs: 0, lastActivityStr: '---' };
      }

      // Sum the points
      leaderboardMap[id].totalPoints += points;

      // Track latest activity
      if (activityDate) {
          const ts = new Date(activityDate).getTime();
          if (ts > leaderboardMap[id].lastActivityTs) {
              leaderboardMap[id].lastActivityTs = ts;
              // Format: "16 Feb, 09:30"
              leaderboardMap[id].lastActivityStr = new Date(activityDate).toLocaleString('en-GB', { 
                  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' 
              });
          }
      }
  }

  // Convert map to array and sort
  const data = Object.values(leaderboardMap)
      .map(p => ({
          name: p.name,
          points: Math.floor(p.totalPoints), // Round down to whole number
          last_activity: p.lastActivityStr
      }))
      .sort((a, b) => b.points - a.points);

  const finalOutput = {
    last_synced: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' }),
    data: data
  };

  fs.writeFileSync('scoreboard.json', JSON.stringify(finalOutput, null, 2));
}

sync();