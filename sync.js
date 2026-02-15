/**
 * sync.js - The Daily Sync Engine
 * Logic: Read Sheet -> Refresh Tokens -> Fetch Data -> Calculate Points -> Update Sheet/JSON
 */

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const fs = require('fs');

// 1. Setup Auth for Google Sheets
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.SHEET_ID, serviceAccountAuth);

async function runSync() {
  await doc.loadInfo();
  const athleteSheet = doc.sheetsByTitle['Athletes'];
  const statsSheet = doc.sheetsByTitle['Stats'];
  
  const athleteRows = await athleteSheet.getRows();
  const leaderboardData = [];

  for (const row of athleteRows) {
    try {
      // 2. Refresh Strava Token
      const tokenResponse = await axios.post('https://www.strava.com/oauth/token', {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        refresh_token: row.get('refresh_token'),
        grant_type: 'refresh_token'
      });

      const { access_token, refresh_token: new_refresh_token } = tokenResponse.data;

      // 3. Update refresh_token in sheet if it changed
      if (new_refresh_token !== row.get('refresh_token')) {
        row.set('refresh_token', new_refresh_token);
        await row.save();
      }

      // 4. Fetch Activities for current month
      // startOfMonth is a Unix timestamp
      const startOfMonth = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000);
      const activities = await axios.get(`https://www.strava.com/api/v3/athlete/activities?after=${startOfMonth}`, {
        headers: { Authorization: `Bearer ${access_token}` }
      });

      // 5. Calculate Points (Your Custom Logic)
      let points = 0;
      let distance = 0;
      
      activities.data.forEach(act => {
        if (act.type === 'Run') {
          distance += act.distance;
          points += (act.distance / 1000) * 10; // 10 pts per KM
        }
      });

      leaderboardData.push({
        name: row.get('name'),
        distance: (distance / 1000).toFixed(2),
        points: Math.floor(points)
      });

      // 6. Sync back to Google Sheet Stats tab
      const statsRows = await statsSheet.getRows();
      const statRow = statsRows.find(r => r.get('athlete_id') === row.get('athlete_id'));
      
      if (statRow) {
        statRow.set('total_points', Math.floor(points));
        statRow.set('total_distance', (distance / 1000).toFixed(2));
        await statRow.save();
      } else {
        await statsSheet.addRow({
          athlete_id: row.get('athlete_id'),
          name: row.get('name'),
          total_points: Math.floor(points),
          total_distance: (distance / 1000).toFixed(2)
        });
      }

    } catch (err) {
      console.error(`Failed to sync athlete ${row.get('name')}:`, err.message);
    }
  }

  // 7. Save to scoreboard.json for the static frontend
  fs.writeFileSync('./scoreboard.json', JSON.stringify(leaderboardData.sort((a,b) => b.points - a.points), null, 2));
  console.log('Sync Complete. Scoreboard updated.');
}

runSync();