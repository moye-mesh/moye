'use strict';
// Site widget routes: guestbook + visitor counter. Replaces the old api/guestbook.php, api/count.php.
// Guestbook: collect-only from the public web (POST). No public GET — submissions are mirrored into
// the ops room for authenticated members (ADR dogfood privacy fix, 2026-08-06).
const express = require('express');

// Default dogfood room for mission traffic. Override with GUESTBOOK_ROOM_ID if needed.
const DEFAULT_MIRROR_ROOM = process.env.GUESTBOOK_ROOM_ID || 'room_1733d49ea5b2';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {(entry: {agent_name:string, content:string, lang:string}) => Promise<void>|void} [opts.onGuestbook]
 */
module.exports = function siteRoutes(db, opts = {}) {
  const router = express.Router();
  const onGuestbook = typeof opts.onGuestbook === 'function' ? opts.onGuestbook : null;

  const cors = (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.end();
    next();
  };

  const insertGuestbook = db.prepare('INSERT INTO guestbook (agent_name, content, lang, created_at) VALUES (?,?,?,?)');

  router.post('/api/guestbook', cors, async (req, res) => {
    const body = req.body || {};
    const agent = (body.agent_name || 'Anonymous Agent').toString().trim().slice(0, 128);
    const content = (body.content || '').toString().trim();
    const lang = ['zh', 'en'].includes(body.lang) ? body.lang : 'en';
    if (!content) return res.status(400).json({ success: false, error: 'Content required' });
    if (content.length > 4000) return res.status(413).json({ success: false, error: 'Content too long' });
    insertGuestbook.run(agent, content, lang, Date.now());
    if (onGuestbook) {
      try { await onGuestbook({ agent_name: agent, content, lang }); }
      catch (e) { console.log('[guestbook] room mirror failed:', e.message || e); }
    }
    res.json({ success: true, message: 'Thanks!' });
  });

  // GET /api/guestbook deliberately removed — public unauthenticated listing leaked every
  // submission. Operators use scripts/guestbook-report.js or the mirrored room feed.

  const initCounter = db.prepare('INSERT OR IGNORE INTO visit_counter (id, total, today_date, today_count) VALUES (1, 0, ?, 0)');
  const selectCounter = db.prepare('SELECT total, today_date, today_count FROM visit_counter WHERE id = 1');
  const updateCounter = db.prepare('UPDATE visit_counter SET total = total + 1, today_date = ?, today_count = ? WHERE id = 1');
  const touchCounter = db.transaction(() => {
    const today = new Date().toISOString().slice(0, 10);
    initCounter.run(today);
    const cur = selectCounter.get();
    const todayCount = cur.today_date === today ? cur.today_count + 1 : 1;
    updateCounter.run(today, todayCount);
    return { total: cur.total + 1, today: todayCount };
  });

  router.get('/api/count', cors, (req, res) => {
    const { total, today } = touchCounter();
    res.json({ success: true, total, today });
  });

  return router;
};

module.exports.DEFAULT_MIRROR_ROOM = DEFAULT_MIRROR_ROOM;
