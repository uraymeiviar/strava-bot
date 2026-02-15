const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');

exports.stravaAuth = async (req, res) => {
  // Capture the temporary code sent by Strava
  const code = req.query.code;

  if (!code) {
    console.error('No code found in request query.');
    return res.status(400).send('No code provided by Strava.');
  }

  try {
    // 1. Exchange the code for permanent tokens
    console.log('Exchanging code for tokens...');
    const tokenResponse = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code'
    });

    const { athlete, refresh_token } = tokenResponse.data;

    // 2. Authenticate with Google Sheets
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      // Fixes multiline private key formatting from env variables
      key: process.env.GOOGLE_PRIVATE_KEY.split(String.raw`\n`).join('\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.SHEET_ID, serviceAccountAuth);
    
    // Critical: You must load document info before accessing sheets
    await doc.loadInfo(); 

    // Find the 'Athletes' tab
    const sheet = doc.sheetsByTitle['Athletes'];
    if (!sheet) {
      throw new Error('Tab named "Athletes" not found in Google Sheet. Check your tab names!');
    }

// ... inside the try block of index.js ...

    // 3. Save or Update athlete data
    const rows = await sheet.getRows();
    const existingRow = rows.find(row => row.get('athlete_id') === athlete.id.toString());

    if (existingRow) {
      console.log(`Updating token for existing athlete: ${athlete.firstname}`);
      existingRow.set('refresh_token', refresh_token);
      existingRow.set('last_registered', new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' }));
      await existingRow.save(); // Saves changes to the existing row instead of adding a new one
    } else {
      console.log(`Adding new athlete: ${athlete.firstname}`);
      await sheet.addRow({
        athlete_id: athlete.id.toString(),
        name: `${athlete.firstname} ${athlete.lastname}`,
        refresh_token: refresh_token,
        last_registered: new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' })
      });
    }

    // 4. Redirect user back to your GitHub Pages leaderboard
    // Replace with your actual GitHub Pages URL
    res.redirect('https://uraymeiviar.github.io/strava-bot/?status=success');

  } catch (error) {
    // Log the detailed error to Google Cloud Logs for debugging
    console.error('REGISTRATION ERROR:', error.response ? error.response.data : error.message);
    
    // Friendly error message for the user
    res.status(500).send(`Authentication failed: ${error.message}`);
  }
};