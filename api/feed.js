// Feed RSS de la Bolsa de Trabajo XAcademy.
// Lo lee Mailchimp (campaña RSS) para mandar a egresados las ofertas activas.
// Se publica en /feed.xml (ver vercel.json) y en /api/feed.
//
// Toma los datos de la misma API de Apps Script que usa index.html,
// así que solo incluye ofertas públicas (Estado "Activo").

const API_URL =
  'https://script.google.com/macros/s/AKfycbzuuMIb4O4iaWsAkqSPo7T_PBUeH7fsPrreqhAS955kh70irwTU6-Ovwab4ZEtBWt66Xw/exec';
const SITIO = 'https://bolsa-xacademy.vercel.app/';
const DIAS_PUBLICACION = 30; // las ofertas vencen 30 días después de la Fecha de carga

const MESES = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6,
  agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
};

function escaparXml(texto) {
  return String(texto == null ? '' : texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Fecha de publicación de la oferta. Prueba el texto de la fecha de carga
// (dd/mm/aaaa, aaaa-mm-dd o "26 de octubre de 2026") y, si no puede,
// la reconstruye a partir de los días que le quedan antes de vencer.
function fechaPublicacion(o, ahora) {
  const t = String(o.fechaCargaTexto || o.fechaCarga || '').trim().toLowerCase();
  let m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    const anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return mediodiaArgentina(anio, Number(m[2]) - 1, Number(m[1]));
  }
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return mediodiaArgentina(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = t.match(/(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?/);
  if (m && MESES[m[2]] !== undefined) {
    return mediodiaArgentina(Number(m[3] || ahora.getUTCFullYear()), MESES[m[2]], Number(m[1]));
  }
  const restantes = Number(o.diasRestantes);
  if (Number.isFinite(restantes)) {
    return new Date(ahora.getTime() - (DIAS_PUBLICACION - restantes) * 86400000);
  }
  return ahora;
}

// 12:00 en Argentina (UTC-3) = 15:00 UTC, para que la fecha no cambie de día.
function mediodiaArgentina(anio, mes, dia) {
  return new Date(Date.UTC(anio, mes, dia, 15, 0, 0));
}

function itemRss(o, ahora) {
  const titulo = [o.puesto, o.empresa].filter(Boolean).join(' · ');
  const detalles = [
    ['Rol', o.rol],
    ['Perfil', o.perfil],
    ['Modalidad', o.modalidad],
    ['Ubicación', o.ubicacion],
  ].filter(([, v]) => v && String(v).trim() && v !== 'No especificado');

  const descripcion =
    '<p><strong>' + escaparXml(o.empresa) + '</strong></p>' +
    (detalles.length
      ? '<p>' + detalles.map(([k, v]) => escaparXml(k) + ': ' + escaparXml(v)).join(' · ') + '</p>'
      : '');

  const link = o.link && /^https?:\/\//i.test(o.link) ? o.link : SITIO;
  const guid = o.id ? 'xacademy-oferta-' + o.id : link + '#' + (o.rowIndex || titulo);

  return [
    '<item>',
    '<title>' + escaparXml(titulo) + '</title>',
    '<link>' + escaparXml(link) + '</link>',
    '<guid isPermaLink="false">' + escaparXml(guid) + '</guid>',
    '<pubDate>' + fechaPublicacion(o, ahora).toUTCString() + '</pubDate>',
    o.rol ? '<category>' + escaparXml(o.rol) + '</category>' : '',
    '<description><![CDATA[' + descripcion + ']]></description>',
    '</item>',
  ].join('');
}

function armarRss(ofertas, ahora, limite) {
  const items = ofertas
    .map((o) => ({ o, fecha: fechaPublicacion(o, ahora) }))
    .sort((a, b) => b.fecha - a.fecha)
    .slice(0, limite > 0 ? limite : undefined)
    .map(({ o }) => itemRss(o, ahora))
    .join('\n');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n' +
    '<channel>\n' +
    '<title>Bolsa de Trabajo XAcademy</title>\n' +
    '<link>' + SITIO + '</link>\n' +
    '<atom:link href="' + SITIO + 'feed.xml" rel="self" type="application/rss+xml"/>\n' +
    '<description>Oportunidades laborales para egresados de XAcademy, un programa de Technology with Purpose Foundation.</description>\n' +
    '<language>es-ar</language>\n' +
    '<lastBuildDate>' + ahora.toUTCString() + '</lastBuildDate>\n' +
    items + '\n' +
    '</channel>\n' +
    '</rss>\n'
  );
}

async function obtenerOfertas() {
  const r = await fetch(API_URL + '?api=ofertas', { redirect: 'follow' });
  if (!r.ok) throw new Error('La API respondió ' + r.status);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Error en la API');
  return Array.isArray(j.data) ? j.data : [];
}

module.exports = async function handler(req, res) {
  try {
    const ofertas = await obtenerOfertas();
    // ?limite=5 → solo las 5 ofertas más recientes (para el mail mensual)
    const limite = parseInt((req.query && req.query.limite) || '', 10);
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    // Cache de 1 hora en Vercel; Mailchimp lo lee una vez por envío.
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    res.status(200).send(armarRss(ofertas, new Date(), limite));
  } catch (e) {
    // Si falla, devolvemos error (y no un feed vacío) para que Mailchimp no mande nada.
    res.status(502).send('No se pudo generar el feed: ' + e.message);
  }
};

module.exports.armarRss = armarRss;
module.exports.fechaPublicacion = fechaPublicacion;
