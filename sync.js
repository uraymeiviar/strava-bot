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
  
  const athleteSheet = doc.sheetsByTitle['Athletes'];
  const statsSheet = doc.sheetsByTitle['Stats'];
  const leaderboardSheet = doc.sheetsByTitle['Leaderboard']; 

  // --- PREVENT DUPLICATES ---
  // Wipe Stats so we re-push a fresh, unique list every time
  await statsSheet.clearRows(); 

  const athleteRows = await athleteSheet.getRows();

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
      const after = Math.floor(new Date('2026-02-01').getTime() / 1000); 
      const activities = await axios.get(`https://www.strava.com/api/v3/athlete/activities?after=${after}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      for (const act of activities.data) {
          await statsSheet.addRow({
              athlete_id: athleteId,
              name: name,
              type: act.type,
              distance_meters: act.distance,         
              moving_time: act.moving_time,           
              elevation_gain: act.total_elevation_gain,
              date: act.start_date_local 
          });
      }
      console.log(`Synced: ${name}`);
    } catch (err) { console.error(`Error for ${name}:`, err.message); }
  }

  // --- UPDATE TIMESTAMPS IN E2/F2 ---
  try {
    await leaderboardSheet.loadCells('E2:F2'); 
    const now = new Date();
    const next = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2h interval
    const options = { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' };

    leaderboardSheet.getCellByA1('E2').value = now.toLocaleString('en-GB', options);
    leaderboardSheet.getCellByA1('F2').value = next.toLocaleString('en-GB', options);

    await leaderboardSheet.saveUpdatedCells();
  } catch (err) { console.error("Metadata update failed:", err.message); }
}

sync();