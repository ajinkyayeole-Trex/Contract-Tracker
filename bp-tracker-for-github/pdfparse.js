/*
 * Reads FlixBus India contract PDFs (Lines Annex, Vehicles Annex, or a full DocuSign envelope)
 * and pulls out the tracker fields. Runs entirely in the browser: the PDF is never uploaded anywhere.
 * Also loadable in Node for testing (parseContractText only).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PdfParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NUM = /\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
  const toNum = (s) => (s === null || s === undefined ? null : Number(String(s).replace(/,/g, '')));
  const round2 = (n) => Math.round(n * 100) / 100;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const title = (s) => clean(s).replace(/\w\S*/g, (w) => (w.length > 2 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w[0].toUpperCase() + w.slice(1)));
  const SOUTH = /bangalore|bengaluru|hyderabad|chennai|nellore|visakhapatnam|vizag|tirunelveli|madurai|coimbatore|kochi|cochin|mysore|mysuru|mangalore|mangaluru|vijayawada|tirupati|nagercoil|puducherry|pondicherry|ananthapur|kurnool|trichy|salem|hubli|belgaum|kerala|goa/i;

  const DOCS = [
    ['framework', 'Framework Agreement', /Framework Agreement(?: With .{1,90}?)?\s+Version/i, /Framework[\s_]+Agreement/i],
    ['lines', 'Lines Annex', /Lines Annex\s+Version/i, /Lines[\s_]+Annex/i],
    ['vehicles', 'Vehicles Annex', /Vehicles Annex\s+Version/i, /Vehicles[\s_]+Annex/i],
    ['commercial', 'Commercial Annex', /Commercial Annex\s+Version/i, /Commercial[\s_]+Annex/i],
    ['addendum', 'Addendum', /Addendum(?: Agreement)?\s+Version/i, /Addendum/i],
    ['attachments', 'Attachments', /Attachments\s+Version/i, /Attachments/i],
  ];
  const RANK = { copy: 1, sent: 2, pending: 2, surya: 3, signed: 4 };

  // Pick the distance that fits "RT amount ÷ RT kms = Reference Rate". Handles text like
  // "Round Trip Kms: 1,160.50 km", "round trip 1041km km", "Round trip KM - 1342.5 km" or a broken "123 5.3".
  function pickKms(txt, amt, rate) {
    const t = String(txt || '');
    const cands = (t.match(NUM) || []).map(toNum);
    const joined = t.replace(/(\d)\s+(?=[\d.])/g, '$1').match(NUM);
    if (joined) joined.map(toNum).forEach((n) => cands.push(n));
    const ok = cands.filter((n) => n > 50);
    if (!ok.length) return { kms: null, sure: false };
    if (amt && rate) {
      const best = ok.map((n) => ({ n, err: Math.abs(amt / n - rate) / rate })).sort((a, b) => a.err - b.err)[0];
      if (best.err < 0.015) return { kms: best.n, sure: true };
      return { kms: ok[0], sure: false };
    }
    return { kms: ok[0], sure: true };
  }

  function lineRoutes(text) {
    const routes = {};
    const re = /Line No\.\s*(IN[0-9A-Z]+)\s*[–-]\s*from\s+(.+?)\s+to\s+(.+?)(?=\s+\d+\.\d|\s+Line No\.|$)/gi;
    let m;
    while ((m = re.exec(text))) if (!routes[m[1].toUpperCase()]) routes[m[1].toUpperCase()] = title(m[2]) + ' – ' + title(m[3]);
    return routes;
  }

  function signers(text) {
    const a = text.search(/Signer Events Signature Timestamp/i);
    if (a < 0) return [];
    let sec = text.slice(a + 32);
    const b = sec.search(/In Person Signer Events/i);
    if (b >= 0) sec = sec.slice(0, b);
    const out = [];
    const re = /([A-Za-z][A-Za-z .'&-]{1,60}?)\s+([\w.+-]+@[\w.-]+\.\w+)(.*?)(?=Electronic Record and Signature Disclosure|$)/g;
    let m;
    while ((m = re.exec(sec))) {
      const signed = /Signed:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(m[3]);
      out.push({ name: clean(m[1]), email: m[2].toLowerCase(), signedOn: signed ? `${signed[3]}-${signed[1].padStart(2, '0')}-${signed[2].padStart(2, '0')}` : null });
    }
    return out;
  }

  const dmy = (m) => (m ? `${m[3]}-${m[2]}-${m[1]}` : null);

  function parseContractText(raw, fileName) {
    const text = clean(raw);
    const r = { bpName: '', lines: [], annualMileage: null, effectiveFrom: null, envelopeId: null, envelopeStatus: null, stage: null, signedOn: null, region: null, docs: [], warnings: [], fileName: fileName || '' };

    // BP name: the partner's name next to FlixBus in the signature block
    const names = {};
    const nre = /FlixBus India Private Limited\s+(.{2,90}?)\s+represented by/gi;
    let m;
    while ((m = nre.exec(text))) { const n = clean(m[1]).replace(/^represented by\s*/i, ''); if (n && !/flixbus/i.test(n)) names[n] = (names[n] || 0) + 1; }
    const best = Object.keys(names).sort((a, b) => names[b] - names[a])[0];
    if (best) r.bpName = /[a-z]/.test(best) ? best : title(best);
    else if (fileName) {
      const f = /^(.+?)[\s_]+(Lines|Vehicles|Commercial|Framework|Addendum|Attachments)[\s_]+(Annex|Agreement)/i.exec(fileName);
      if (f) r.bpName = title(f[1].replace(/_/g, ' '));
    }

    // Which documents are inside
    // Which of the six contract documents are inside (by their title page, or by the file name)
    r.docKeys = [];
    DOCS.forEach(([key, name, re, fileRe]) => { if (re.test(text) || fileRe.test(fileName || '')) { r.docs.push(name); r.docKeys.push(key); } });

    // Lines: "For Line IN0211D: 67,500.00 INR per Round Trip (agreed Round Trip Distance: … km; Reference Rate: 67.50 INR /km)"
    const routes = lineRoutes(text);
    const seen = {};
    const lre = /For\s+Line\s+(IN[0-9A-Z]+)\s*:\s*([\d,]+(?:\.\d+)?)\s*INR\s+per\s+Round\s+Trip\s*\(\s*agreed\s+Round\s+Trip\s+Distance\s*:?(.*?);\s*Reference\s+Rate\s*:\s*([\d,]+(?:\.\d+)?)\s*INR/gi;
    while ((m = lre.exec(text))) {
      const code = m[1].toUpperCase(), amt = toNum(m[2]), rate = toNum(m[4]);
      const k = pickKms(m[3], amt, rate);
      const line = { code, route: routes[code] || '', rtAmt: amt, minG: rate, rtKms: k.kms };
      if (!k.kms) { line.rtKms = rate ? round2(amt / rate) : null; line.kmsWorkedOut = true; r.warnings.push(`${code}: the contract leaves the RT distance blank, so ${line.rtKms} km is worked out from RT amount ÷ MinG. Please check.`); }
      else if (!k.sure) r.warnings.push(`${code}: RT kms (${k.kms}) doesn't match RT amount ÷ MinG. Please check against the PDF.`);
      if (seen[code]) {
        const p = seen[code];
        if (p.rtAmt !== line.rtAmt || p.minG !== line.minG || p.rtKms !== line.rtKms) r.warnings.push(`${code} appears twice with different numbers; the first one is used.`);
        continue;
      }
      seen[code] = line; r.lines.push(line);
    }
    // Same layout, but the RT amount is left blank and/or the text is split by a page break
    // ("For Line IN4305A: INR per Round Trip (agreed Round Trip Distance: Round Trip Kms: 809.1 … km; Reference Rate: 63.96 INR /km)")
    const fre = /For\s+Line\s+(IN[0-9A-Z]+)\s*:/gi;
    while ((m = fre.exec(text))) {
      const code = m[1].toUpperCase();
      if (seen[code]) continue;
      const rest = text.slice(m.index + m[0].length);
      const next = rest.search(/For\s+Line\s+IN[0-9A-Z]+\s*:|\bb\)\s/i);
      const seg = next > 0 ? rest.slice(0, next) : rest.slice(0, 1500);
      if (!/INR\s+per\s+Round\s+Trip/i.test(seg)) continue;
      const amt = toNum((/^\s*([\d,]+(?:\.\d+)?)\s*INR\s+per\s+Round\s+Trip/i.exec(seg) || [])[1]);
      const kms = toNum((/Round\s*Trip\s*K(?:ms|m)\s*:?\s*([\d,]+(?:\.\d+)?)/i.exec(seg) || [])[1]);
      // The rate may be pushed past a page break (signature block in between): take the first "xx.xx INR /km" after "Reference Rate:"
      const rate = toNum((/Reference\s+Rate\s*:\s*([\d,]+(?:\.\d+)?)\s*INR/i.exec(seg) || /Reference\s+Rate\s*:[\s\S]{0,1500}?(\d{1,3}\.\d{1,2})\s*INR\s*\/\s*km/i.exec(seg) || [])[1]);
      if (!amt && !kms && !rate) continue;
      const line = { code, route: routes[code] || '', rtAmt: amt, minG: rate, rtKms: kms };
      if (!amt && kms && rate) { line.rtAmt = round2(kms * rate); line.amtWorkedOut = true; r.warnings.push(`${code}: the contract leaves the RT amount blank, so ₹${line.rtAmt.toLocaleString('en-IN')} is worked out from ${kms} km × ₹${rate}/km. Please check.`); }
      else if (!amt && !kms && rate) r.warnings.push(`${code}: the contract only prints the MinG (₹${rate}/km); RT kms and RT amount are left blank. They are filled in automatically from the next Revenue Share Report (or straight away if one is already saved).`);
      else if (!amt || !kms || !rate) r.warnings.push(`${code}: ${[!kms && 'RT kms', !rate && 'MinG', !amt && 'RT amount'].filter(Boolean).join(' and ')} not found in the contract. Please check against the PDF.`);
      seen[code] = line; r.lines.push(line);
    }
    // Older Lines Annex layout: "Round Trip Amount- 75900 Round trip KM - 1384" + "For Line IN2310B with vehicles …: 54.84 INR"
    Object.keys(routes).filter((c) => !seen[c]).forEach((code) => {
      const at = text.search(new RegExp('Line No\\.\\s*' + code + '\\b', 'i'));
      // Up to the next line's section ("2.2 Line No. …"), not the "Line No. … is part of the Line Bundle" mention inside this one
      const seg = text.slice(at, at + 1500).split(/\s\d+\.\d+\s+Line No\.\s*IN|\bArt\.\s*\d+\s/i)[0];
      const amt = toNum((/Round Trip Amount\s*[-:]?\s*([\d,]+(?:\.\d+)?)/i.exec(seg) || [])[1]);
      const kms = toNum((/Round\s*trip\s*K(?:M|ms)\s*[-:]?\s*([\d,]+(?:\.\d+)?)/i.exec(seg) || [])[1]);
      let rate = toNum((new RegExp('For Line ' + code + '\\s+with vehicles[^:]{0,200}:\\s*([\\d.,]+)\\s*INR(?!\\s*per\\s*Round)', 'i').exec(text) || [])[1]);
      if (rate && rate > 200) rate = null; // that's an amount, not a ₹/km rate
      if (!amt && !rate) { r.warnings.push(`${code} is listed but no RT amount or MinG was found for it. Please add it by hand.`); r.lines.push({ code, route: routes[code], rtAmt: null, minG: null, rtKms: kms }); return; }
      r.lines.push({ code, route: routes[code], rtAmt: amt, minG: rate, rtKms: kms });
      r.warnings.push(`${code}: read from the older Lines Annex layout. Please check the numbers.`);
    });
    r.lines.forEach((l) => { if (l.rtAmt && l.rtKms && l.minG && Math.abs(round2(l.rtAmt / l.rtKms) - l.minG) >= 0.01) l.printedRate = true; });

    // Vehicles Annex Art. 2.1
    const am = /combined\s+annual\s*\(\s*12\s*month\s*\)\s*mileage\s+of\s+approximately\s+([\d,]+)\s*km/i.exec(text);
    if (am) r.annualMileage = toNum(am[1]);

    const eff = /This Lines Annex shall be valid with effect from\s*(\d{2})\.(\d{2})\.(\d{4})/i.exec(text) || /valid with effect from\s*(\d{2})\.(\d{2})\.(\d{4})/i.exec(text);
    r.effectiveFrom = dmy(eff);

    // DocuSign: envelope ID, status and who has signed
    const env = /Envelope\s*Id:?\s*([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/i.exec(text);
    if (env) r.envelopeId = env[1].toUpperCase();
    const st = /Status:\s*(Completed|Sent|Delivered|Voided|Declined)/i.exec(text);
    if (st) r.envelopeStatus = st[1][0].toUpperCase() + st[1].slice(1).toLowerCase();
    // Who has signed? Flix routing: the BP signs first, then Surya.
    // 1) The DocuSign certificate ("Signer Events"), when the PDF includes it.
    const sg = signers(text);
    const flix = sg.filter((s) => /@flix(bus)?\.com$/.test(s.email));
    const bp = sg.filter((s) => !/@flix(bus)?\.com$/.test(s.email));
    r.signedBy = { bp: null, surya: null, source: null };
    if (sg.length) {
      r.signedBy = { bp: bp.length && bp.every((s) => s.signedOn) ? bp.map((s) => s.signedOn).sort().pop() : null,
        surya: flix.length && flix.every((s) => s.signedOn) ? flix.map((s) => s.signedOn).sort().pop() : null, source: 'certificate',
        bpName: bp.map((s) => s.name.replace(/^.*?(?:Docusign|^p)\s+/i, '')).join(', ') };
    }
    // 2) No certificate: the signing dates DocuSign stamps on each signature page, right after "Docusign Envelope ID: …"
    //    (one date = only the BP has signed, two dates = BP and Surya).
    if (!sg.length && r.envelopeId) {
      // Each date may carry a time: "23.07.2026 | 08:14 CEST 23.07.2026 | 10:32 CEST"
      const re = /Docusign Envelope ID:?\s*[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}((?:\s+\d{2}\.\d{2}\.\d{4}(?:\s*\|\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:[AP]M))?(?:\s*[A-Z]{2,5})?)?){1,2})(?![.\d])/gi;
      const pages = []; let mm;
      while ((mm = re.exec(text))) pages.push((mm[1].match(/\d{2}\.\d{2}\.\d{4}/g) || []).map((d) => d.split('.').reverse().join('-')));
      // A signature page with no date at all: the stamp is followed by text, so it isn't matched; count those too
      const sigPages = (text.match(/\(Signature\)\s*\(Signature\)/gi) || []).length;
      if (pages.length) {
        const min = pages.length >= sigPages ? Math.min(...pages.map((d) => d.length)) : 0;
        const firsts = pages.map((d) => d[0]).sort(); const seconds = pages.map((d) => d[1]).filter(Boolean).sort();
        r.signedBy = { bp: min >= 1 ? firsts.pop() : null, surya: min >= 2 ? seconds.pop() : null, source: 'dates' };
      } else if (sigPages) r.signedBy = { bp: null, surya: null, source: 'dates' };
      if (r.signedBy.source && !r.envelopeStatus) r.envelopeStatus = r.signedBy.bp && r.signedBy.surya ? 'Completed' : 'Sent';
    }
    if (r.envelopeStatus === 'Voided' || r.envelopeStatus === 'Declined') { r.stage = null; r.warnings.push(`The DocuSign envelope was ${r.envelopeStatus.toLowerCase()}.`); }
    else if (r.envelopeStatus === 'Completed' || (r.signedBy.bp && r.signedBy.surya)) { r.stage = 'Signed'; r.envelopeStatus = 'Completed'; r.signedOn = r.signedBy.surya || r.signedBy.bp || null; }
    else if (r.signedBy.source) {
      if (r.signedBy.bp) { r.stage = 'Surya signature pending'; r.signedOn = r.signedBy.bp; }
      else r.stage = 'Merchant signature pending';
    }
    r.signers = sg;
    // RCM (Reverse Charge Mechanism) clause in the Commercial Annex: Art. 8.12.7 "GST Charge Mechanism" (b) in template v1.1
    if (r.docKeys.includes('commercial')) {
      r.rcm = /Reverse\s+Charge\s+Mechanism|\(\s*[“"]?RCM[”"]?\s*\)/i.test(text) ? 'yes' : 'no';
      const cl = /(\d+\.\d+\.\d+)\s+GST\s+Charge\s+Mechanism/i.exec(text);
      r.rcmClause = r.rcm === 'yes' ? (cl ? cl[1] : '') : '';
    }
    // Signature status of the documents in this PDF
    const st2 = r.stage === 'Signed' ? 'signed' : r.stage === 'Surya signature pending' ? 'surya' : r.envelopeId ? 'sent' : 'copy';
    r.docMap = {}; r.docKeys.forEach((k) => { r.docMap[k] = st2; });

    // Region guess from the routes
    if (r.lines.length) {
      const south = r.lines.filter((l) => SOUTH.test(l.route)).length;
      r.region = south > r.lines.length / 2 ? 'South' : 'N/W';
    }
    if (!r.docs.includes('Lines Annex') && !r.lines.length) r.warnings.push('No Lines Annex found in this PDF.');
    if (!r.annualMileage) r.warnings.push('No Vehicles Annex annual mileage found in this PDF.');
    return r;
  }

  // Combine several PDFs (e.g. Lines Annex + Vehicles Annex uploaded separately)
  function merge(results, keyFn) {
    const key = keyFn || ((n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
    // Only combine PDFs for the same BP; anything for another BP is left out
    const main = (results.find((r) => r.bpName) || {}).bpName;
    const skipped = main ? results.filter((r) => r.bpName && key(r.bpName) !== key(main)) : [];
    results = results.filter((r) => !skipped.includes(r));
    const out = { bpName: '', lines: [], annualMileage: null, effectiveFrom: null, envelopeId: null, envelopeStatus: null, stage: null, signedOn: null, region: null, docs: [], docMap: {}, warnings: [], files: [] };
    const order = ['Merchant signature pending', 'Surya signature pending', 'Signed'];
    results.forEach((r) => {
      out.files.push(r.fileName);
      if (!out.bpName && r.bpName) out.bpName = r.bpName;
      r.lines.forEach((l) => { if (!out.lines.some((x) => x.code === l.code)) out.lines.push(l); });
      if (r.annualMileage) out.annualMileage = r.annualMileage;
      if (r.effectiveFrom && r.lines.length) out.effectiveFrom = r.effectiveFrom;
      else if (!out.effectiveFrom) out.effectiveFrom = r.effectiveFrom;
      if (r.envelopeId && !out.envelopeId) { out.envelopeId = r.envelopeId; out.envelopeStatus = r.envelopeStatus; }
      // A partly signed envelope holds the stage back
      if (r.stage && (!out.stage || order.indexOf(r.stage) < order.indexOf(out.stage))) { out.stage = r.stage; out.signedOn = r.signedOn; out.signedBy = r.signedBy; }
      r.docs.forEach((d) => { if (!out.docs.includes(d)) out.docs.push(d); });
      Object.keys(r.docMap || {}).forEach((k) => { if (!out.docMap[k] || RANK[r.docMap[k]] > RANK[out.docMap[k]]) out.docMap[k] = r.docMap[k]; });
      out.region = out.region || r.region;
      if (r.rcm === 'yes' || (r.rcm && !out.rcm)) { out.rcm = r.rcm; out.rcmClause = r.rcmClause; }
    });
    const all = results.flatMap((r) => r.warnings);
    out.warnings = all.filter((w, i) => all.indexOf(w) === i && !(/^No Lines Annex found/.test(w) && out.lines.length) && !(/^No Vehicles Annex annual mileage/.test(w) && out.annualMileage));
    skipped.forEach((r) => out.warnings.unshift(`“${r.fileName}” is for ${r.bpName}, not ${main}, so it was left out. Add it separately.`));
    return out;
  }

  // Browser only: read the text out of a PDF file with pdf.js
  async function readPdf(file) {
    const lib = (typeof window !== 'undefined' && window.pdfjsLib) || null;
    if (!lib) throw new Error('The PDF reader did not load. Refresh the page and try again.');
    if (!lib.GlobalWorkerOptions.workerSrc) {
      const inline = document.getElementById('pdfjs-worker-src');
      lib.GlobalWorkerOptions.workerSrc = inline ? URL.createObjectURL(new Blob([inline.textContent], { type: 'text/javascript' })) : 'vendor/pdf.worker.min.js';
    }
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      pages.push(tc.items.map((it) => it.str).join(' '));
    }
    const text = pages.join(' ');
    if (clean(text).length < 50) throw new Error(`“${file.name}” has no readable text (it may be a scan). Enter the details by hand.`);
    return parseContractText(text, file.name);
  }

  return { parseContractText, merge, readPdf, pickKms, DOCS };
});
