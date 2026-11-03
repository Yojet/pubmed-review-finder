/* Shared PubMed client for the site's pages, built on NCBI's E-utilities. */

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const TOOL = 'pubmed-review-finder';
const MAX_IDS = 9999;   // PubMed's hard limit on IDs per search
const BATCH = 200;      // records per download request
const MAX_ATTEMPTS = 6;

const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} }
};

/* Pages hand over a function that returns the viewer's NCBI API key, if any. */
let apiKey = () => '';
function useApiKey(fn) { apiKey = fn; }

/* ---------- Dates ---------- */

const dayMs = 86400000;
const toDay = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / dayMs);
function dayLabel(day) {
  const d = new Date(day * dayMs);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
}
const dated = (base, a, b) => `(${base}) AND ${dayLabel(a)}:${dayLabel(b)}[Date - Publication]`;

/* ---------- Requests ---------- */

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('Stopped', 'AbortError'));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
});

let nextSlot = 0;
async function throttle(signal) {
  const gap = apiKey() ? 110 : 350;
  const now = Date.now(), at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  if (at > now) await sleep(at - now, signal);
}

class FatalError extends Error {}

async function request(endpoint, params, signal, parse) {
  const body = new URLSearchParams({ db: 'pubmed', tool: TOOL, ...params });
  const key = apiKey();
  if (key) body.set('api_key', key);
  let last;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await throttle(signal);
    try {
      const res = await fetch(EUTILS + endpoint, { method: 'POST', body, signal });
      const text = await res.text();
      if (res.status === 400 || res.status === 403) {
        throw new FatalError(/api key/i.test(text) ? 'NCBI rejected the API key. Check it, or clear the field.' : `PubMed refused the request (${res.status}).`);
      }
      if (!res.ok) throw new Error(`PubMed returned ${res.status}`);
      return parse(text);
    } catch (e) {
      if (e.name === 'AbortError' || e instanceof FatalError) throw e;
      last = e;
    }
    await sleep(1000 * 2 ** attempt, signal);
  }
  throw new Error(`PubMed did not respond after ${MAX_ATTEMPTS} tries (${last?.message || 'network error'}).`);
}

function parseSearch(text) {
  const d = JSON.parse(text);
  if (d.error) throw new Error(d.error);                     // usually the rate limit; retried
  const r = d.esearchresult;
  if (!r) throw new Error('Unexpected reply from PubMed');
  if (r.ERROR) throw new FatalError(`PubMed could not run this query: ${r.ERROR}`);
  return { count: parseInt(r.count, 10), ids: r.idlist || [] };
}

const search = (term, retmax, signal, extra = {}) =>
  request('esearch.fcgi', { term, retmax, retmode: 'json', ...extra }, signal, parseSearch);

/* Collect IDs for a date range, halving the range until each piece fits PubMed's limit.
   Papers with separate print and online dates can land in two pieces, so IDs go in a Set. */
async function collectIds(base, a, b, ids, onStep, signal) {
  const { count } = await search(dated(base, a, b), 0, signal);
  if (!count) return;
  if (count <= MAX_IDS || a === b) {
    const r = await search(dated(base, a, b), MAX_IDS, signal);
    r.ids.forEach(id => ids.add(id));
    onStep();
    return;
  }
  const mid = Math.floor((a + b) / 2);
  await collectIds(base, a, mid, ids, onStep, signal);
  await collectIds(base, mid + 1, b, ids, onStep, signal);
}

/* ---------- Parsing PubMed XML ---------- */

const txt = (el, sel) => el?.querySelector(sel)?.textContent.trim() || '';
const kids = (el, sel) => el ? [...el.querySelectorAll(sel)] : [];

function authorsOf(list) {
  return kids(list, ':scope > Author')
    .filter(a => a.getAttribute('ValidYN') !== 'N')
    .map(a => txt(a, 'CollectiveName') || [txt(a, 'LastName'), txt(a, 'Initials')].filter(Boolean).join(' '))
    .filter(Boolean);
}

function abstractOf(el) {
  return kids(el, ':scope > Abstract > AbstractText').map(p => {
    const label = p.getAttribute('Label');
    return (label ? `${label}: ` : '') + p.textContent.trim();
  }).join('\n');
}

function yearOf(dateEl) {
  const m = (txt(dateEl, 'Year') || txt(dateEl, 'MedlineDate')).match(/\d{4}/);
  return m ? parseInt(m[0], 10) : null;
}

function parseArticle(node) {
  const art = node.querySelector(':scope > MedlineCitation > Article');
  const journal = art?.querySelector(':scope > Journal');
  const issue = journal?.querySelector(':scope > JournalIssue');
  const doi = txt(node, ':scope > PubmedData > ArticleIdList > ArticleId[IdType="doi"]')
    || txt(art, ':scope > ELocationID[EIdType="doi"]');
  return {
    pmid: txt(node, ':scope > MedlineCitation > PMID'),
    title: txt(art, ':scope > ArticleTitle') || txt(art, ':scope > VernacularTitle'),
    authors: authorsOf(art?.querySelector(':scope > AuthorList')),
    year: yearOf(issue?.querySelector(':scope > PubDate')) ?? yearOf(art?.querySelector(':scope > ArticleDate')),
    journal: txt(journal, ':scope > Title'),
    volume: txt(issue, ':scope > Volume'),
    issue: txt(issue, ':scope > Issue'),
    pages: txt(art, ':scope > Pagination > MedlinePgn'),
    doi,
    types: kids(art, ':scope > PublicationTypeList > PublicationType').map(t => t.textContent.trim()),
    abstract: abstractOf(art),
  };
}

function parseBook(node) {
  const doc = node.querySelector(':scope > BookDocument');
  const book = doc?.querySelector(':scope > Book');
  return {
    book: true,
    pmid: txt(doc, ':scope > PMID'),
    title: txt(doc, ':scope > ArticleTitle') || txt(book, ':scope > BookTitle'),
    authors: authorsOf(doc?.querySelector(':scope > AuthorList') || book?.querySelector(':scope > AuthorList')),
    year: yearOf(book?.querySelector(':scope > PubDate')),
    journal: txt(book, ':scope > BookTitle') || txt(book, 'PublisherName'),
    volume: '', issue: '', pages: '',
    doi: txt(doc, ':scope > ArticleIdList > ArticleId[IdType="doi"]'),
    types: kids(doc, ':scope > PublicationType').map(t => t.textContent.trim()),
    abstract: abstractOf(doc),
  };
}

function parseRecords(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Incomplete reply from PubMed');
  return [...doc.documentElement.children].flatMap(n =>
    n.localName === 'PubmedArticle' ? [parseArticle(n)] :
    n.localName === 'PubmedBookArticle' ? [parseBook(n)] : []);
}

const fetchRecords = (ids, signal) => request('efetch.fcgi', { id: ids.join(','), retmode: 'xml' }, signal, parseRecords);

/* ---------- Showing and exporting records ---------- */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function shortAuthors(a) {
  if (!a.length) return 'No authors listed';
  return a.length > 3 ? `${a.slice(0, 3).join(', ')} et al.` : a.join(', ');
}

function citation(r) {
  const parts = [r.volume && (r.issue ? `${r.volume}(${r.issue})` : r.volume), r.pages].filter(Boolean);
  return parts.length ? ` ${parts.join(':')}` : '';
}

function recordRow(r, chipPattern = /review|meta-analysis/i) {
  const li = el('li');
  li.append(el('span', 'yr', r.year ?? '—'));
  const body = el('div', 'rec');
  const ttl = el('div', 'ttl');
  const link = el('a', '', r.title || '(No title)');
  link.href = `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`;
  link.target = '_blank'; link.rel = 'noopener';
  ttl.append(link);
  const meta = el('div', 'meta', `${shortAuthors(r.authors).replace(/\.$/, '')}. `);
  meta.append(el('i', '', r.journal), citation(r));
  const chips = el('div', 'chips');
  r.types.filter(t => chipPattern.test(t)).forEach(t => chips.append(el('span', 'chip', t)));
  chips.append(el('span', 'pmid', `PMID ${r.pmid}`));
  body.append(ttl, meta, chips);
  if (r.abstract) {
    const d = el('details');
    d.append(el('summary', '', 'Abstract'), el('p', '', r.abstract));
    body.append(d);
  }
  li.append(body);
  return li;
}

function saveFile(text, type, filename) {
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;   // stop spreadsheets reading text as a formula
  return `"${s.replace(/"/g, '""')}"`;
}

const csvTable = (head, rows) => '﻿' + [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');

function toCsv(rows) {
  const head = ['PMID', 'Title', 'Authors', 'Year', 'Journal', 'Volume', 'Issue', 'Pages', 'DOI', 'Publication types', 'Abstract', 'PubMed URL'];
  return csvTable(head, rows.map(r => [r.pmid, r.title, r.authors.join('; '), r.year, r.journal, r.volume, r.issue, r.pages, r.doi,
    r.types.join('; '), r.abstract, `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`]));
}

function toRis(rows) {
  const flat = s => String(s).replace(/\s+/g, ' ').trim();
  return rows.map(r => {
    const out = [`TY  - ${r.book ? 'CHAP' : 'JOUR'}`, `TI  - ${flat(r.title)}`];
    r.authors.forEach(a => out.push(`AU  - ${flat(a)}`));
    if (r.year) out.push(`PY  - ${r.year}`);
    if (r.journal) out.push(`JO  - ${flat(r.journal)}`);
    if (r.volume) out.push(`VL  - ${flat(r.volume)}`);
    if (r.issue) out.push(`IS  - ${flat(r.issue)}`);
    if (r.pages) out.push(`SP  - ${flat(r.pages)}`);
    if (r.doi) out.push(`DO  - ${flat(r.doi)}`);
    if (r.abstract) out.push(`AB  - ${flat(r.abstract)}`);
    out.push(`AN  - ${r.pmid}`, `UR  - https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`, 'ER  - ');
    return out.join('\r\n');
  }).join('\r\n\r\n') + '\r\n';
}
