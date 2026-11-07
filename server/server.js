
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Existing health-check route
app.get('/', (req, res) => {
  res.json({
    message: 'AgentCart backend is running!'
  });
});

// Generate a PayPal OAuth access token
async function generatePayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const baseUrl = process.env.PAYPAL_BASE_URL;

  if (!clientId || !clientSecret || !baseUrl) {
    throw new Error('PayPal credentials are not configured.');
  }

  const auth = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString('base64');

  const response = await fetch(
    `${baseUrl}/v1/oauth2/token`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error('PayPal authentication failed.');
  }

  return data.access_token;
}

// Test PayPal connection safely
app.get('/api/paypal/test', async (req, res) => {
  try {
    await generatePayPalAccessToken();

    res.json({
      success: true,
      message: 'PayPal Sandbox authentication successful!'
    });
  } catch (error) {
    console.error('PayPal connection error:', error.message);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`AgentCart server running on port ${PORT}`);
});
