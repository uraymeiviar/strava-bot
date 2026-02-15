const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const fs = require('fs');

async function sync() {
  console.log('Starting Sync Process...');
  try {
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.split(String.raw`\n`).join('\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    
    const athleteSheet = doc.sheetsByTitle['Athletes'];
    const rows = await athleteSheet.getRows();
    console.log(`Found ${rows.length} athletes to sync.`);
    
    let leaderboard = [];

    for (const row of rows) {
      const name = row.get('name');
      const refreshToken = row.get('refresh_token');
      
      console.log(`Syncing data for: ${name}...`);

      try {
        const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
          client_id: process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        });

        const accessToken = tokenRes.data.access_token;
        const after = Math.floor(new Date('2026-01-01').getTime() / 1000);
        
        const activityRes = await axios.get(`https://www.strava.com/api/v3/athlete/activities?after=${after}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });

        const totalDistance = activityRes.data.reduce((sum, act) => sum + act.distance, 0);
        const points = Math.floor(totalDistance / 1000);

        leaderboard.push({
          name: name,
          distance: (totalDistance / 1000).toFixed(2),
          points: points
        });
      } catch (innerErr) {
        console.error(`Failed to fetch Strava data for ${name}:`, innerErr.message);
      }
    }

    // Sort and Save with the NEW structure for index.html
    leaderboard.sort((a, b) => b.points - a.points);
    const finalOutput = {
      last_synced: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false }),
      data: leaderboard
    };

    fs.writeFileSync('scoreboard.json', JSON.stringify(finalOutput, null, 2));
    console.log('Successfully generated scoreboard.json');

  } catch (err) {
    console.error('CRITICAL ERROR:', err.message);
    process.exit(1); // Tells GitHub that the script failed
  }
}

sync();