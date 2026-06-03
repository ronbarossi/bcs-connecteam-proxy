// Connecteam Forms proxy for Launchpad — v4.
// Root cause fixed: form objects use `formName` (not name/title). The prior
// match treated an empty name as "matches everything", pulling all 51 forms and
// tripping Connecteam's rate limit. Now we read formName, match ONLY the two
// target forms, and reuse the questions returned by the forms list (no per-form
// definition calls), so it's fast and rate-limit-safe.

const CONNECTEAM_API = 'https://api.connecteam.com';
const API_KEY = process.env.CONNECTEAM_API_KEY;
const TARGET_FORMS = ['Supply Request', 'Requerimiento Material de Trabajo'];
const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ct(path, params = {}, tries = 4) {
  const url = new URL(`${CONNECTEAM_API}${path}`);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  let last;
  for (let i = 0; i < tries; i++) {
    let res;
    try { res = await fetch(url.toString(), { headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(12000) }); }
    catch (e) { last = new Error('fetch:' + (e.message || e)); await sleep(400 * (i + 1)); continue; }
    if ([429, 502, 503].includes(res.status)) { last = new Error(res.status + ': busy'); await sleep(700 * (i + 1)); continue; }
    if (!res.ok) { const t = await res.text(); throw new Error(`${res.status}: ${t.slice(0, 160)}`); }
    return res.json();
  }
  throw last || new Error('failed');
}

function answerValue(a) {
  if (Array.isArray(a?.selectedAnswers)) return a.selectedAnswers.map(x => x.text ?? x.label ?? x.name ?? '').filter(Boolean).join(', ');
  const v = a?.value ?? a?.answer ?? a?.text ?? a?.values ?? a?.selectedOptions ?? a?.options;
  if (v == null) { if (a?.timestamp) { try { return new Date((String(a.timestamp).length > 12 ? a.timestamp : a.timestamp * 1000)).toISOString().slice(0, 10); } catch { return ''; } } return ''; }
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

  // 1) Forms list (one call) — objects carry formId, formName, questions.
  let allForms = [];
  try {
    const fr = await ct('/forms/v1/forms', { limit: 200, offset: 0 });
    allForms = fr?.data?.forms || (Array.isArray(fr?.data) ? fr.data : []) || [];
    debug.formCount = allForms.length;
    debug.allFormNames = allForms.map(f => f.formName || f.name || f.title || '?');
  } catch (e) { debug.formsError = String(e.message || e); }

  const targets = TARGET_FORMS.map(norm);
  const wanted = allForms.filter(f => { const n = norm(f.formName || f.name || f.title); return n && targets.some(t => n === t || n.includes(t)); });
  debug.matchedNames = wanted.map(f => f.formName || f.name || f.title);

  // 2) Users — one page (resolve submitter names).
  const userMap = {};
  try {
    const u = await ct('/users/v1/users', { limit: 200, offset: 0 });
    (u?.data?.users || []).forEach(usr => { const uid = usr.userId || usr.id; if (uid) userMap[uid] = `${usr.firstName || ''} ${usr.lastName || ''}`.trim() || usr.email || ('User ' + uid); });
  } catch (e) { debug.usersError = String(e.message || e); }

  // 3) Submissions for the matched forms only.
  const submissions = [];
  for (const form of wanted) {
    const formId = form.formId || form.id;
    if (!formId) continue;
    const qMap = {};
    (Array.isArray(form.questions) ? form.questions : []).forEach(q => { const qid = q.questionId || q.id; if (qid != null) qMap[qid] = q.title || q.label || q.name || q.questionTitle || q.text || String(qid); });

    let offset = 0;
    for (let page = 0; page < 4; page++) {
      let sr;
      try { sr = await ct(`/forms/v1/forms/${formId}/form-submissions`, { limit: 100, offset }); }
      catch (e) { debug['subsError_' + formId] = String(e.message || e); break; }
      const subs = sr?.data?.formSubmissions || sr?.data?.submissions || sr?.data || [];
      if (!Array.isArray(subs) || subs.length === 0) break;
      subs.forEach(s => {
        const id = s.formSubmissionId || s.id || s.submissionId;
        const ts = s.submissionTimestamp || s.timestamp || s.createdAt;
        const submittedAt = ts ? new Date(String(ts).length > 12 ? ts : ts * 1000).toISOString() : null;
        if (submittedAt && new Date(submittedAt).getTime() < sinceMs) return;
        const userId = s.submittingUserId || s.userId || s.submittedBy?.userId || s.creatorId || (Array.isArray(s.userIds) ? s.userIds[0] : null);
        const raw = s.answers || s.formAnswers || s.questions || [];
        const answers = (Array.isArray(raw) ? raw : []).map(a => ({ question: qMap[a.questionId || a.id] || a.title || a.question || a.label || String(a.questionId ?? ''), answer: answerValue(a) })).filter(qa => qa.answer !== '');
        submissions.push({ id, form: form.formName || form.name || form.title, submittedAt: submittedAt || new Date().toISOString(), user: userMap[userId] || (userId ? ('User ' + userId) : 'Level 1'), answers });
      });
      const next = sr?.paging?.offset;
      if (typeof next !== 'number' || subs.length < 100) break;
      offset = next;
    }
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json({ success: true, formsMatched: wanted.map(f => ({ id: f.formId || f.id, name: f.formName || f.name || f.title })), submissions, debug, fetchedAt: new Date().toISOString() });
}
