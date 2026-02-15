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
  
  let summary = {}; 

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
      // Filter activities after Feb 1st, 2026
      const after = Math.floor(new Date('2026-02-01').getTime() / 1000);
      const activities = await axios.get(`https://www.strava.com/api/v3/athlete/activities?after=${after}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      if (!summary[athleteId]) {
        summary[athleteId] = { 
            name, 
            points: 0, 
            last_activity_time: null,
            _internal_ts: 0 
        };
      }

      for (const act of activities.data) {
          // Point Logic: Run (1.0), Ride (0.3), Others (0.5)
          let weight = act.type === 'Run' ? 1.0 : (act.type === 'Ride' ? 0.3 : 0.5);
          summary[athleteId].points += Math.floor((act.distance / 1000) * weight);

          // Find the most recent activity timestamp
          const activityTs = new Date(act.start_date_local).getTime();
          if (activityTs > summary[athleteId]._internal_ts) {
              summary[athleteId]._internal_ts = activityTs;
              
              // Format the timestamp for the frontend
              const dateObj = new Date(act.start_date_local);
              summary[athleteId].last_activity_time = dateObj.toLocaleString('en-GB', { 
                  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
              });
          }

          // Log to Google Sheet
          await statsSheet.addRow({
              athlete_id: athleteId,
              name: name,
              type: act.type,
              distance_meters: act.distance,
              date: act.start_date_local
          });
      }
    } catch (err) {
      console.error(`Error for ${name}:`, err.message);
    }
  }

  const leaderboard = Object.values(summary).sort((a, b) => b.points - a.points);
  const finalOutput = {
    last_synced: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' }),
    data: leaderboard
  };

  fs.writeFileSync('scoreboard.json', JSON.stringify(finalOutput, null, 2));
}

sync();