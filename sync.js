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
  
  // Clear Stats sheet (optional: keep history and just append new)
  // await statsSheet.clearRows(); 

  let summary = {}; // To group totals for the website

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

      if (!summary[athleteId]) summary[athleteId] = { name, distance: 0, points: 0, activities: [] };

      for (const act of activities.data) {
          // 1. Push Raw Data to Stats Tab
          await statsSheet.addRow({
              athlete_id: athleteId,
              name: name,
              type: act.type,
              distance_meters: act.distance,         // Raw meters
              moving_time: act.moving_time,           // Raw seconds
              elevation_gain: act.total_elevation_gain, // Raw meters
              // We leave 'points' blank so the Spreadsheet Formula can handle it
          });

          // 2. We still need to calculate a temporary sum for the scoreboard.json
          // Use the same logic as your spreadsheet formula here
          let weight = act.type === 'Run' ? 1.0 : (act.type === 'Ride' ? 0.3 : 0.5);
          let pts = (act.distance / 1000) * weight;

          summary[athleteId].distance += (act.distance / 1000);
          summary[athleteId].points += Math.floor(pts);
          summary[athleteId].activities.push(act.type);
      }
    } catch (err) {
      console.error(`Error for ${name}:`, err.message);
    }
  }

  // 3. Save for Website
  const leaderboard = Object.values(summary).sort((a, b) => b.points - a.points);
  const finalOutput = {
    last_synced: new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta', hour12: false }),
    data: leaderboard
  };

  fs.writeFileSync('scoreboard.json', JSON.stringify(finalOutput, null, 2));
}

sync();