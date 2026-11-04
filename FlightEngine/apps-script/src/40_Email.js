/**
 * Email di alert per le run schedulate (MailApp, dall'account proprietario dello script).
 * Stessi dati del template Firebase (cluster, destinazione, date, aeroporti, compagnie,
 * orari, durate, scali, totale e per persona, link Google Flights) con un layout a "carta
 * d'imbarco": stili inline e tabelle per la compatibilità con Gmail, Outlook e Apple Mail.
 */

var FE_MAIL_ = {
  ink: '#0F172A', muted: '#64748B', faint: '#94A3B8', line: '#E2E8F0', page: '#EEF2F7', card: '#FFFFFF',
  navy: '#0B1B3F', blue: '#1F4FE0', teal: '#12B5A6',
  good: '#047857', goodBg: '#E6F6EF', warn: '#9A5B00', warnBg: '#FFF3DC', chip: '#EEF2FF', chipInk: '#3730A3'
};
var FE_WEEKDAYS_ = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
var FE_MONTHS_ = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

function escapeHtml_(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

function mailMoney_(n, currency) {
  try { return new Intl.NumberFormat('it-IT', { style: 'currency', currency: currency || 'EUR' }).format(n); }
  catch (e) { return Number(n).toFixed(2).replace('.', ',') + ' ' + (currency || ''); }
}

function mailDay_(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return escapeHtml_(formatDate_(iso || '')) || '—';
  var d = new Date(iso + 'T12:00:00Z');
  return FE_WEEKDAYS_[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + FE_MONTHS_[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

function mailNights_(a, b) {
  var n = Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
  return Number.isFinite(n) && n > 0 ? n + (n === 1 ? ' notte' : ' notti') : '';
}

/** "12/03/2027 10:30" -> { date: "12/03/2027", time: "10:30" } */
function mailSplitTime_(text) {
  var s = String(text || '').trim(), m = /^(\S+)\s+(.+)$/.exec(s);
  return m ? { date: m[1], time: m[2] } : { date: s, time: '' };
}

function mailStops_(n) { n = Number(n); return n === 0 ? 'Diretto' : n === 1 ? '1 scalo' : n + ' scali'; }

function mailBadge_(text, fg, bg) {
  return '<span style="display:inline-block;padding:4px 10px;margin:0 6px 6px 0;border-radius:999px;background:' + bg + ';color:' + fg + ';font-size:11px;font-weight:700;letter-spacing:.3px;text-transform:uppercase">' + escapeHtml_(text) + '</span>';
}

function mailButton_(label, url, primary) {
  var bg = primary ? FE_MAIL_.blue : FE_MAIL_.card, fg = primary ? '#FFFFFF' : FE_MAIL_.blue;
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;margin:6px 8px 0 0"><tr><td style="border-radius:10px;background:' + bg + ';border:1.5px solid ' + FE_MAIL_.blue + '">' +
    '<a href="' + escapeHtml_(url) + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:10px 16px;font-size:13px;font-weight:700;color:' + fg + ';text-decoration:none;border-radius:10px">' + escapeHtml_(label) + ' &rarr;</a></td></tr></table>';
}

/** Riga di una tratta: aeroporto/orario di partenza, durata e scali, aeroporto/orario di arrivo. */
function mailLegRow_(label, raw, date, origin, destination) {
  var c = FE_MAIL_, leg = legDetails_(raw), hasFlights = !!(raw && Array.isArray(raw.flights) && raw.flights.length);
  var dep = mailSplitTime_(leg.origin.time), arr = mailSplitTime_(leg.destination.time);
  var duration = raw && (raw.total_duration != null || raw.duration != null) ? durationText_(leg.duration) : '';
  var stops = raw && (raw.stops != null || hasFlights) ? mailStops_(leg.stops) : '';
  var layover = raw && Array.isArray(raw.layovers) && leg.layoverMinutes ? 'scali ' + durationText_(leg.layoverMinutes) : '';
  var airlines = leg.airlines.filter(Boolean);
  var endpoint = function (code, name, time, align) {
    return '<td width="30%" valign="top" style="text-align:' + align + '">' +
      '<div style="font-size:26px;line-height:30px;font-weight:800;color:' + c.ink + ';letter-spacing:.5px">' + escapeHtml_(code || '—') + '</div>' +
      '<div style="font-size:15px;font-weight:700;color:' + c.ink + '">' + (escapeHtml_(time) || '&nbsp;') + '</div>' +
      '<div style="font-size:11px;line-height:15px;color:' + c.muted + '">' + escapeHtml_(name) + '</div></td>';
  };
  return '<tr><td style="padding:14px 0 4px">' +
    '<div style="font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:' + c.blue + ';margin-bottom:6px">' + escapeHtml_(label) + ' · ' + mailDay_(date) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    endpoint(leg.origin.code || origin, leg.origin.name, dep.time, 'left') +
    '<td width="40%" valign="middle" style="text-align:center;padding:0 8px">' +
    '<div style="font-size:12px;font-weight:700;color:' + c.ink + '">' + (escapeHtml_(duration) || '&nbsp;') + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0"><tr><td style="border-top:2px dashed ' + c.faint + ';font-size:0;line-height:0">&nbsp;</td><td width="22" style="font-size:16px;line-height:16px;color:' + c.blue + ';text-align:center">&#9992;</td><td style="border-top:2px dashed ' + c.faint + ';font-size:0;line-height:0">&nbsp;</td></tr></table>' +
    '<div style="font-size:11px;color:' + c.muted + '">' + escapeHtml_([stops, layover].filter(Boolean).join(' · ')) + '</div></td>' +
    endpoint(leg.destination.code || destination, leg.destination.name, arr.time, 'right') +
    '</tr></table>' +
    (airlines.length ? '<div style="font-size:12px;color:' + c.muted + ';margin-top:6px">' + airlines.map(escapeHtml_).join(' &middot; ') + '</div>' : '') +
    '</td></tr>';
}

function mailOfferCard_(offer, currency, meta, highlight) {
  var c = FE_MAIL_, threshold = meta.thresholds ? meta.thresholds[offer.searchId] : undefined;
  var badges = '';
  if (highlight) badges += mailBadge_('Miglior affare', '#FFFFFF', c.blue);
  if (Number.isFinite(threshold) && offer.pricePerPerson <= threshold) {
    var pct = threshold > 0 ? Math.round((1 - offer.pricePerPerson / threshold) * 100) : 0;
    badges += mailBadge_('Sotto soglia' + (pct > 0 ? ' −' + pct + '%' : ''), c.good, c.goodBg);
  } else {
    badges += mailBadge_('Prezzo in calo' + (meta.dropAlertPercent ? ' ≥' + meta.dropAlertPercent + '%' : ''), c.warn, c.warnBg);
  }
  badges += mailBadge_(offer.priceType === 'SEPARATE_ONE_WAY' ? 'Open jaw · 2 voli singoli' : 'Andata e ritorno', c.chipInk, c.chip);
  var nights = mailNights_(offer.departureDate, offer.returnDate);
  var returnBlock = ['UNAVAILABLE', 'NOT_REQUESTED'].indexOf(offer.returnDetailsStatus) >= 0
    ? '<tr><td style="padding:12px 0 2px"><div style="font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:' + c.blue + ';margin-bottom:4px">Ritorno · ' + mailDay_(offer.returnDate) + '</div><div style="font-size:13px;color:' + c.muted + '">' + escapeHtml_(returnDescription_(offer)) + '</div></td></tr>'
    : mailLegRow_('Ritorno', offer.return, offer.returnDate, offer.returnOrigin || offer.destination, offer.returnDestination || offer.origin);
  var links = googleFlightsLinks_(offer, currency).map(function (l, i) { return mailButton_(l.label, l.url, i === 0); }).join('');
  var threshold_line = Number.isFinite(threshold) ? 'soglia ' + mailMoney_(threshold, currency) + ' a persona' : '';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;background:' + c.card + ';border:1px solid ' + c.line + ';border-radius:16px;border-collapse:separate;overflow:hidden">' +
    '<tr><td style="padding:18px 20px 6px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td valign="top"><div>' + badges + '</div>' +
    '<div style="font-size:20px;line-height:26px;font-weight:800;color:' + c.ink + '">' + escapeHtml_(offer.destinationName) + '</div>' +
    '<div style="font-size:13px;color:' + c.muted + ';margin-top:2px">' + mailDay_(offer.departureDate) + ' &rarr; ' + mailDay_(offer.returnDate) + (nights ? ' · ' + nights : '') + '</div></td>' +
    '<td valign="top" align="right" style="text-align:right;white-space:nowrap;padding-left:12px">' +
    '<div style="font-size:30px;line-height:34px;font-weight:800;color:' + c.blue + '">' + escapeHtml_(mailMoney_(offer.pricePerPerson, currency)) + '</div>' +
    '<div style="font-size:11px;color:' + c.muted + ';text-transform:uppercase;letter-spacing:.6px">a persona A/R</div></td>' +
    '</tr></table></td></tr>' +
    '<tr><td style="padding:0 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
    mailLegRow_('Andata', offer.outbound, offer.departureDate, offer.origin, offer.destination) + returnBlock +
    '</table></td></tr>' +
    '<tr><td style="padding:14px 20px 0"><div style="border-top:2px dashed ' + c.line + ';font-size:0;line-height:0">&nbsp;</div></td></tr>' +
    '<tr><td style="padding:12px 20px 18px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td valign="middle" style="font-size:12px;color:' + c.muted + ';line-height:18px">Totale <b style="color:' + c.ink + ';font-size:15px">' + escapeHtml_(mailMoney_(offer.totalPrice, currency)) + '</b>' +
    (offer.travelers ? ' per ' + escapeHtml_(offer.travelers) + (Number(offer.travelers) === 1 ? ' viaggiatore' : ' viaggiatori') : '') +
    '<br>' + escapeHtml_([threshold_line, offer.provider ? 'via ' + offer.provider : ''].filter(Boolean).join(' · ')) + '</td>' +
    '</tr></table>' + (links ? '<div style="margin-top:8px">' + links + '</div>' : '') +
    '</td></tr></table>';
}

function mailKpi_(label, value, sub) {
  return '<td width="33%" valign="top" style="padding:14px 12px;text-align:center">' +
    '<div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#C7D2FE">' + escapeHtml_(label) + '</div>' +
    '<div style="font-size:22px;line-height:28px;font-weight:800;color:#FFFFFF;margin-top:2px">' + escapeHtml_(value) + '</div>' +
    '<div style="font-size:11px;color:#C7D2FE">' + escapeHtml_(sub || '') + '</div></td>';
}

/** HTML dell'email. offers = documenti flight_results con alert=true. */
function renderAlertEmailV2_(offers, currency, meta) {
  meta = meta || {};
  var c = FE_MAIL_;
  var sorted = offers.slice().sort(function (a, b) { return Number(a.pricePerPerson) - Number(b.pricePerPerson) || String(a.departureDate).localeCompare(String(b.departureDate)); });
  var best = sorted[0];
  var groups = new Map();
  sorted.forEach(function (o) { var k = o.cluster || o.period || 'Senza cluster'; groups.set(k, (groups.get(k) || []).concat([o])); });
  var destinations = unique_(sorted.map(function (o) { return o.destinationName; })).length;
  var when = meta.startedAt instanceof Date ? meta.startedAt : new Date();
  var whenText = mailDay_(when.toISOString().slice(0, 10));
  var preheader = sorted.length + (sorted.length === 1 ? ' nuova occasione' : ' nuove occasioni') + ' · da ' + mailMoney_(best.pricePerPerson, currency) + ' a persona per ' + best.destinationName;
  var sections = Array.from(groups.entries()).sort(function (a, b) { return a[0].localeCompare(b[0]); }).map(function (entry) {
    return '<tr><td style="padding:22px 0 10px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
      '<td style="width:4px;background:' + c.teal + ';border-radius:4px">&nbsp;</td>' +
      '<td style="padding-left:10px;font-size:13px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:' + c.navy + '">' + escapeHtml_(entry[0]) + '</td>' +
      '<td style="padding-left:8px;font-size:12px;color:' + c.muted + '">' + entry[1].length + (entry[1].length === 1 ? ' offerta' : ' offerte') + '</td></tr></table></td></tr>' +
      '<tr><td>' + entry[1].map(function (o) { return mailOfferCard_(o, currency, meta, o === best); }).join('') + '</td></tr>';
  }).join('');
  return '<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>Flight Engine</title></head>' +
    '<body style="margin:0;padding:0;background:' + c.page + ';font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:' + c.ink + '">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">' + escapeHtml_(preheader) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + c.page + '"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:660px">' +
    // Hero
    '<tr><td style="border-radius:20px;background:' + c.navy + ';background-image:linear-gradient(135deg,' + c.navy + ' 0%,' + c.blue + ' 62%,' + c.teal + ' 100%);padding:26px 24px 8px">' +
    '<div style="font-size:12px;font-weight:800;letter-spacing:2.4px;text-transform:uppercase;color:#A5F3FC">&#9992;&nbsp; Flight Engine · Alert prezzi</div>' +
    '<div style="font-size:30px;line-height:36px;font-weight:800;color:#FFFFFF;margin-top:10px">' + sorted.length + (sorted.length === 1 ? ' nuova occasione' : ' nuove occasioni') + '</div>' +
    '<div style="font-size:14px;color:#DBEAFE;margin-top:4px">Controllo automatico di ' + escapeHtml_(whenText) + '. Prezzi per persona, andata e ritorno.</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;background:rgba(255,255,255,.10);border-radius:14px"><tr>' +
    mailKpi_('Da', mailMoney_(best.pricePerPerson, currency), best.destinationName) +
    mailKpi_('Offerte', String(sorted.length), groups.size + ' cluster') +
    mailKpi_('Destinazioni', String(destinations), 'con prezzi in alert') +
    '</tr></table><div style="height:18px;line-height:18px">&nbsp;</div></td></tr>' +
    // Sezioni
    '<tr><td style="padding:0 2px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + sections + '</table></td></tr>' +
    // Footer
    '<tr><td style="padding:10px 8px 0;font-size:11px;line-height:17px;color:' + c.muted + ';text-align:center">' +
    'I prezzi provengono dai provider al momento del controllo e possono variare.<br>Soglie, destinatario e orari si modificano dalla dashboard Flight Engine.' +
    (meta.runId ? '<br><span style="color:' + c.faint + '">Esecuzione schedulata ' + escapeHtml_(meta.runId) + '</span>' : '') +
    '</td></tr></table></td></tr></table></body></html>';
}

function renderAlertText_(offers, currency) {
  return offers.slice().sort(function (a, b) { return a.pricePerPerson - b.pricePerPerson; }).map(function (o) {
    return '• ' + o.destinationName + ' (' + (o.cluster || 'Senza cluster') + '): ' + formatDate_(o.departureDate) + ' → ' + formatDate_(o.returnDate) + ', ' +
      routeCodes_(o) + ' / ' + routeCodes_(o, true) + ' — ' + mailMoney_(o.pricePerPerson, currency) + ' a persona (totale ' + mailMoney_(o.totalPrice, currency) + ')';
  }).join('\n');
}

function sendAlertEmail_(to, offers, currency, meta) {
  var best = offers.reduce(function (m, o) { return !m || o.pricePerPerson < m.pricePerPerson ? o : m; }, null);
  MailApp.sendEmail({
    to: to,
    name: 'Flight Engine',
    subject: '✈ Flight Engine: ' + offers.length + (offers.length === 1 ? ' nuova occasione' : ' nuove occasioni') + ' da ' + mailMoney_(best.pricePerPerson, currency),
    htmlBody: renderAlertEmailV2_(offers, currency, meta),
    body: 'Flight Engine – nuove occasioni\n\n' + renderAlertText_(offers, currency)
  });
}
