// Health check — verifies API key is configured and Connecteam is reachable
const CONNECTEAM_API = 'https://api.connecteam.com';
const API_KEY = process.env.CONNECTEAM_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const checks = { apiKeyConfigured: !!API_KEY, connecteamReachable: false, timeClockCount: 0, timestamp: new Date().toISOString() };

  if (API_KEY) {
    try {
      const response = await fetch(CONNECTEAM_API + '/time-clock/v1/time-clocks', {
        headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' }
      });
      checks.connecteamReachable = response.ok;
      checks.connecteamStatus = response.status;
      if (response.ok) {
        const data = await response.json();
        const clocks = data.data || data || [];
        checks.timeClockCount = Array.isArray(clocks) ? clocks.length : 0;
      } else { checks.error = await response.text(); }
    } catch (err) { checks.error = err.message; }
  }
  return res.status(200).json(checks);
}
