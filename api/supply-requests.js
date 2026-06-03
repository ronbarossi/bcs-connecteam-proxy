// Connecteam Forms proxy for Launchpad — v3: per-call timeouts + tight caps so
// it can never hang. Returns the two "Supplies Workflows" forms' recent
// submissions + a debug block.

const CONNECTEAM_API = 'https://api.connecteam.com';
const API_KEY = process.env.CONNECTEAM_API_KEY;
const TARGET_FORMS = ['Supply Request', 'Requerimiento Material de Trabajo'];
const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function ct(path, params = {}) {
  const url = new URL(`${CONNECTEAM_API}${path}`);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  const res = await fetch(url.toString(), {
    headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(12000), // never hang on one call
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`${res.status}: ${t.slice(0, 160)}`); }
  return res.json();
}

function answerValue(a) {
  const v = a?.value ?? a?.answer ?? a?.text ?? a?.values ?? a?.selectedOptions ?? a?.options ?? a?.attachments;
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => (typeof x === 'object' ? (x.label ?? x.name ?? x.text ?? JSON.stringify(x)) : x)).join(', ');
  if (typeof v === 'object') return v.label ?? v.name ?? v.text ?? JSON.stringify(v);
  return String(v);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); return res.status(200).end(); }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!API_KEY) return res.status(500).json({ error: 'CONNECTEAM_API_KEY not configured' });

  const debug = {};
  const { days = '14' } = req.query;
  const sinceMs = Date.now() - parseInt(days, 10) * 86400000;

  // 1) Forms list (one call).
  let allForms = [];
  try {
    const fr = await ct('/forms/v1/forms', { limit: 200, offset: 0 });
    debug.formsDataKeys = fr?.data ? Object.keys(fr.data) : Object.keys(fr || {});
    allForms = fr?.data?.forms || fr?.data?.formsList || (Array.isArray(fr?.data) ? fr.data : []) || [];
    debug.formCount = Array.isArray(allForms) ? allForms.length : 0;
    debug.allFormNames = (Array.isArray(allForms) ? allForms : []).map(f => f.name || f.title || ('keys=' + Object.keys(f).join(',')));
  } catch (e) { debug.formsError = String(e.message || e); }

  const targets = TARGET_FORMS.map(norm);
  const wanted = (Array.isArray(allForms) ? allForms : []).filter(f => { const n = norm(f.name || f.title); return targets.some(t => n === t || n.includes(t) || t.includes(n)); });
  debug.matchedNames = wanted.map(f => f.name || f.title);

  // 2) Users — ONE page only (fast). Most rosters fit in 200.
  const userMap = {};
  try {
    const u = await ct('/users/v1/users', { limit: 200, offset: 0 });
    (u?.data?.users || []).forEach(usr => { const uid = usr.userId || usr.id; if (uid) userMap[uid] = `${usr.firstName || ''} ${usr.lastName || ''}`.trim() || usr.email || `User ${uid}`; });
  } catch (e) { debug.usersError = String(e.message || e); }

  // 3) Submissions — at most 2 pages of 50 per form.
  const submissions = [];
  for (const form of wanted) {
    const formId = form.id || form.formId;
    if (!formId) continue;
    const qMap = {};
    try {
      const def = await ct(`/forms/v1/forms/${formId}`);
      const qs = def?.data?.form?.questions || def?.data?.questions || def?.data?.form?.fields || [];
      (Array.isArray(qs) ? qs : []).forEach(q => { const qid = q.questionId || q.id; if (qid != null) qMap[qid] = q.title || q.label || q.name || String(qid); });
    } catch (e) { debug['formDefError_' + formId] = String(e.message || e); }

    let offset = 0;
    for (let page = 0; page < 2; page++) {
      let sr;
      try { sr = await ct(`/forms/v1/forms/${formId}/form-submissions`, { limit: 50, offset }); }
      catch (e) { debug['subsError_' + formId] = String(e.message || e); break; }
      const subs = sr?.data?.formSubmissions || sr?.data?.submissions || sr?.data || [];
      if (!debug.sampleSubmission && Array.isArray(subs) && subs[0]) debug.sampleSubmission = JSON.stringify(subs[0]).slice(0, 1200);
      if (!Array.isArray(subs) || subs.length === 0) break;
      subs.forEach(s => {
        const id = s.formSubmissionId || s.id || s.submissionId;
        const ts = s.submissionTimestamp || s.timestamp || s.createdAt;
        const submittedAt = ts ? new Date(String(ts).length > 12 ? ts : ts * 1000).toISOString() : null;
        if (submittedAt && new Date(submittedAt).getTime() < sinceMs) return;
        const userId = s.userId || s.submittedBy?.userId || s.creatorId || (Array.isArray(s.userIds) ? s.userIds[0] : null);
        const raw = s.answers || s.formAnswers || s.questions || [];
        const answers = (Array.isArray(raw) ? raw : []).map(a => ({ question: qMap[a.questionId || a.id] || a.title || a.question || a.label || String(a.questionId ?? ''), answer: answerValue(a) })).filter(qa => qa.answer !== '');
        submissions.push({ id, form: form.name || form.title, submittedAt: submittedAt || new Date().toISOString(), user: userMap[userId] || (userId ? `User ${userId}` : 'Level 1'), answers });
      });
      const next = sr?.paging?.offset;
      if (typeof next !== 'number' || subs.length < 50) break;
      offset = next;
    }
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json({ success: true, formsMatched: wanted.map(f => ({ id: f.id || f.formId, name: f.name || f.title })), submissions, debug, fetchedAt: new Date().toISOString() });
}
