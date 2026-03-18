// Vercel Serverless Function — proxies Connecteam Time Clock API
const CONNECTEAM_API = 'https://api.connecteam.com';
const API_KEY = process.env.CONNECTEAM_API_KEY;

async function connecteamFetch(path, params = {}) {
  const url = new URL(CONNECTEAM_API + path);
  Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
  const res = await fetch(url.toString(), {
    headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' }
  });
  if (!res.ok) { const text = await res.text(); throw new Error('Connecteam API ' + res.status + ': ' + text); }
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!API_KEY) return res.status(500).json({ error: 'CONNECTEAM_API_KEY not configured' });

  try {
    const { days = '7', timeclockId } = req.query;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    let timeClocks;
    if (timeclockId) {
      timeClocks = [{ id: timeclockId }];
    } else {
      const clocksRes = await connecteamFetch('/time-clock/v1/time-clocks');
      timeClocks = clocksRes.data || clocksRes || [];
    }

    const allActivities = [];
    for (const clock of (Array.isArray(timeClocks) ? timeClocks : [])) {
      try {
        const activitiesRes = await connecteamFetch(
          '/time-clock/v1/time-clocks/' + clock.id + '/time-activities',
          { startDate: startDateStr, endDate: endDateStr }
        );
        const activities = activitiesRes.data || activitiesRes || [];
        if (Array.isArray(activities)) {
          activities.forEach(a => {
            allActivities.push({ ...a, timeClockId: clock.id, timeClockName: clock.name || clock.title || clock.id });
          });
        }
      } catch (err) {
        console.error('Failed to fetch activities for clock ' + clock.id + ':', err.message);
      }
    }

    return res.status(200).json({
      success: true,
      timeClocks: Array.isArray(timeClocks) ? timeClocks.map(c => ({ id: c.id, name: c.name || c.title || c.id })) : [],
      activities: allActivities,
      dateRange: { start: startDateStr, end: endDateStr },
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Connecteam proxy error:', err);
    return res.status(500).json({ error: 'Failed to fetch from Connecteam', message: err.message });
  }
}
