// Vercel Serverless Function — proxies Connecteam Time Clock API
const CONNECTEAM_API = 'https://api.connecteam.com';
const API_KEY = process.env.CONNECTEAM_API_KEY;

async function connecteamFetch(path, params = {}) {
  const url = new URL(CONNECTEAM_API + path);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  const res = await fetch(url.toString(), {
    headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' }
  });
  if (!res.ok) { const text = await res.text(); throw new Error('Connecteam API ' + res.status + ': ' + text); }
  return res.json();
}

// userId -> "First Last". Falls back to "Staff" if the users call ever fails.
async function buildUserMap() {
  const map = {};
  try {
    let offset = 0; const limit = 200;
    for (let guard = 0; guard < 25; guard++) {
      const res = await connecteamFetch('/users/v1/users', { limit, offset });
      const users = (res.data && res.data.users) || [];
      users.forEach(u => { map[u.userId] = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || ('User ' + u.userId); });
      const total = (res.paging && res.paging.total) || users.length;
      offset += limit;
      if (offset >= total || users.length === 0) break;
    }
  } catch (err) {
    console.error('buildUserMap failed (taps will say "Staff"):', err.message);
  }
  return map;
}

const tsToIso = (t) => (t ? new Date(t * 1000).toISOString() : '');

// Flatten Connecteam's nested time-activities (data.timeActivitiesByUsers[].shifts[])
// into the flat clock-in/out shape Launchpad's nfc-tap-sync + UI expect.
function flattenActivities(byUsers, clock, userMap) {
  const out = [];
  (byUsers || []).forEach(u => {
    const userName = userMap[u.userId] || 'Staff';
    (u.shifts || []).forEach(s => {
      const i = s.start || {}, o = s.end || {};
      out.push({
        id: s.id,
        userId: u.userId,
        userName,
        timeClockId: clock.id,
        timeClockName: clock.name || clock.title || String(clock.id),
        clockInSource: (i.source && i.source.type) || null,
        clockInSourceName: (i.source && i.source.name) || '',
        clockInSourceId: (i.source && i.source.id) || '',
        clockInTime: tsToIso(i.timestamp),
        clockOutSource: (o.source && o.source.type) || null,
        clockOutSourceName: (o.source && o.source.name) || '',
        clockOutSourceId: (o.source && o.source.id) || '',
        clockOutTime: tsToIso(o.timestamp),
      });
    });
  });
  return out;
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

    const userMap = await buildUserMap();

    let timeClocks;
    if (timeclockId) {
      timeClocks = [{ id: timeclockId, name: timeclockId }];
    } else {
      const clocksRes = await connecteamFetch('/time-clock/v1/time-clocks');
      timeClocks = (clocksRes.data && clocksRes.data.timeClocks) || [];
    }
    timeClocks = (Array.isArray(timeClocks) ? timeClocks : []).filter(c => !c.isArchived);

    const allActivities = [];
    for (const clock of timeClocks) {
      try {
        const activitiesRes = await connecteamFetch(
          '/time-clock/v1/time-clocks/' + clock.id + '/time-activities',
          { startDate: startDateStr, endDate: endDateStr }
        );
        const byUsers = (activitiesRes.data && activitiesRes.data.timeActivitiesByUsers) || [];
        allActivities.push(...flattenActivities(byUsers, clock, userMap));
      } catch (err) {
        console.error('Failed to fetch activities for clock ' + clock.id + ':', err.message);
      }
    }

    return res.status(200).json({
      success: true,
      timeClocks: timeClocks.map(c => ({ id: c.id, name: c.name || c.title || c.id })),
      activities: allActivities,
      dateRange: { start: startDateStr, end: endDateStr },
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Connecteam proxy error:', err);
    return res.status(500).json({ error: 'Failed to fetch from Connecteam', message: err.message });
  }
}
