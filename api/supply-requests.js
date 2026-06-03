// Vercel Serverless Function — proxies the two Connecteam "Supplies Workflows"
// forms (Supply Request + Requerimiento Material de Trabajo) for Launchpad.
// Mirrors the auth/util pattern of the time-activities handler.

const CONNECTEAM_API = 'https://api.connecteam.com';
const API_KEY = process.env.CONNECTEAM_API_KEY;

// Matched by name (case-insensitive). Add/adjust names here if they change.
const TARGET_FORMS = ['Supply Request', 'Requerimiento Material de Trabajo'];

async function connecteamFetch(path, params = {}) {
  const url = new URL(`${CONNECTEAM_API}${path}`);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  const res = await fetch(url.toString(), {
    headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' },
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Connecteam API ${res.status}: ${t}`); }
  return res.json();
}

// Flatten a Connecteam answer value across the shapes it might use.
function answerValue(a) {
  const v = a?.value ?? a?.answer ?? a?.text ?? a?.values ?? a?.selectedOptions ?? a?.options ?? a?.attachments;
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => (typeof x === 'object' ? (x.label ?? x.name ?? x.text ?? JSON.stringify(x)) : x)).join(', ');
  if (typeof v === 'object') return v.label ?? v.name ?? v.text ?? JSON.stringify(v);
  return String(v);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!API_KEY) return res.status(500).json({ error: 'CONNECTEAM_API_KEY not configured' });

  try {
    const { days = '14' } = req.query;
    const sinceMs = Date.now() - parseInt(days, 10) * 86400000;

    // 1) List forms, match our two by name.
    const formsRes = await connecteamFetch('/forms/v1/forms', { limit: 200, offset: 0 });
    const allForms = formsRes?.data?.forms || formsRes?.data || [];
    const wanted = (Array.isArray(allForms) ? allForms : []).filter(f =>
      TARGET_FORMS.some(t => (f.name || f.title || '').trim().toLowerCase() === t.toLowerCase()));

    // 2) Resolve user names (same pagination as the time-clock handler).
    const userMap = {};
    try {
      const LIMIT = 200; let offset = 0; let page = 0;
      while (page < 25) {
        const u = await connecteamFetch('/users/v1/users', { limit: LIMIT, offset });
        const users = u?.data?.users || [];
        if (!Array.isArray(users) || users.length === 0) break;
        users.forEach(usr => {
          const uid = usr.userId || usr.id; if (!uid) return;
          userMap[uid] = `${usr.firstName || ''} ${usr.lastName || ''}`.trim() || usr.email || `User ${uid}`;
        });
        const next = u?.paging?.offset;
        if (typeof next !== 'number' || users.length < LIMIT) break;
        offset = next; page++;
      }
    } catch (e) { console.error('user resolve failed', e.message); }

    // 3) For each matched form: question titles + submissions, normalized.
    const submissions = [];
    for (const form of wanted) {
      const formId = form.id || form.formId;
      if (!formId) continue;

      const qMap = {};
      try {
        const def = await connecteamFetch(`/forms/v1/forms/${formId}`);
        const questions = def?.data?.form?.questions || def?.data?.questions || def?.data?.form?.fields || [];
        (Array.isArray(questions) ? questions : []).forEach(q => {
          const qid = q.questionId || q.id; if (qid != null) qMap[qid] = q.title || q.label || q.name || String(qid);
        });
      } catch (e) { console.error('form def failed', formId, e.message); }

      let offset = 0; let page = 0;
      while (page < 25) {
        let subsRes;
        try { subsRes = await connecteamFetch(`/forms/v1/forms/${formId}/form-submissions`, { limit: 100, offset }); }
        catch (e) { console.error('submissions fetch failed', formId, e.message); break; }
        const subs = subsRes?.data?.formSubmissions || subsRes?.data?.submissions || subsRes?.data || [];
        if (!Array.isArray(subs) || subs.length === 0) break;

        subs.forEach(s => {
          const id = s.formSubmissionId || s.id || s.submissionId;
          const ts = s.submissionTimestamp || s.timestamp || s.createdAt;
          const submittedAt = ts ? new Date(String(ts).length > 12 ? ts : ts * 1000).toISOString() : null;
          if (submittedAt && new Date(submittedAt).getTime() < sinceMs) return;
          const userId = s.userId || s.submittedBy?.userId || s.creatorId || (Array.isArray(s.userIds) ? s.userIds[0] : null);
          const rawAnswers = s.answers || s.formAnswers || s.questions || [];
          const answers = (Array.isArray(rawAnswers) ? rawAnswers : []).map(a => ({
            question: qMap[a.questionId || a.id] || a.title || a.question || a.label || String(a.questionId ?? ''),
            answer: answerValue(a),
          })).filter(qa => qa.answer !== '');
          submissions.push({
            id,
            form: form.name || form.title,
            submittedAt: submittedAt || new Date().toISOString(),
            user: userMap[userId] || (userId ? `User ${userId}` : 'Level 1'),
            answers,
            raw: s,
          });
        });

        const next = subsRes?.paging?.offset;
        if (typeof next !== 'number' || subs.length < 100) break;
        offset = next; page++;
      }
    }

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      success: true,
      formsMatched: wanted.map(f => ({ id: f.id || f.formId, name: f.name || f.title })),
      submissions,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('supply-requests proxy error:', err);
    return res.status(500).json({ error: 'Failed to fetch Connecteam forms', message: err.message });
  }
}
