const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const fs = require('fs');

async function sync() {
  // 1. Setup Auth
  const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.split(String.raw`\n`).join('\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(process.env.SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  
  const athleteSheet = doc.sheetsByTitle['Athletes'];
  const rows = await athleteSheet.getRows();
  
  let leaderboard = [];

  // 2. Process each athlete
  for (const row of rows) {
    try {
      // Refresh the token to get a fresh access_token
      const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        refresh_token: row.get('refresh_token'),
        grant_type: 'refresh_token'
      });

      const accessToken = tokenRes.data.access_token;

      // Fetch activities (since Feb 1st, 2026)
      const after = Math.floor(new Date('2026-02-01').getTime() / 1000);
      const activityRes = await axios.get(`https://www.strava.com/api/v3/athlete/activities?after=${after}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      // Calculate totals
      const totalDistance = activityRes.data.reduce((sum, act) => sum + act.distance, 0);
      const points = Math.floor(totalDistance / 1000); // 1 point per km

      leaderboard.push({
        name: row.get('name'),
        distance: (totalDistance / 1000).toFixed(2),
        points: points
      });

    } catch (err) {
      console.error(`Error syncing ${row.get('name')}:`, err.message);
    }
  }

  // 3. Save the results with a timestamp
  leaderboard.sort((a, b) => b.points - a.points);
  
  const finalOutput = {
    // Creates a "Last Updated" timestamp in GMT+7
    last_synced: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false }),
    data: leaderboard
  };

  fs.writeFileSync('scoreboard.json', JSON.stringify(finalOutput, null, 2));
  console.log('Leaderboard updated with timestamp!');
}

sync();