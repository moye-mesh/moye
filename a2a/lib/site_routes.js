'use strict';
// Site widget routes: guestbook + visitor counter. Replaces the old api/guestbook.php, api/count.php.
// Request/response JSON shapes match the old PHP version exactly, so index.html's frontend logic
// didn't need any changes.
const express = require('express');

module.exports = function siteRoutes(db) {
  const router = express.Router();

  const cors = (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.end();
    next();
  };

  const insertGuestbook = db.prepare('INSERT INTO guestbook (agent_name, content, lang, created_at) VALUES (?,?,?,?)');
  const selectGuestbook = db.prepare('SELECT agent_name, content, created_at, lang FROM guestbook ORDER BY created_at DESC LIMIT ?');

  router.post('/api/guestbook', cors, (req, res) => {
    const body = req.body || {};
    const agent = (body.agent_name || 'Anonymous Agent').toString().trim();
    const content = (body.content || '').toString().trim();
    const lang = ['zh', 'en'].includes(body.lang) ? body.lang : 'en';
    if (!content) return res.status(400).json({ success: false, error: 'Content required' });
    insertGuestbook.run(agent, content, lang, Date.now());
    res.json({ success: true, message: 'Thanks!' });
  });

  router.get('/api/guestbook', cors, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const rows = selectGuestbook.all(limit).map(r => ({
      agent_name: r.agent_name,
      content: r.content,
      created_at: new Date(r.created_at).toISOString(),
      lang: r.lang,
    }));
    res.json({ success: true, guestbooks: rows });
  });

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
