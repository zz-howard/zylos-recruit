import { chatPageHtml } from '../templates/chat.js';
import { browserBaseFromRequest } from '../lib/browser-base.js';

export function chatPageRoute(baseUrl) {
  return (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(chatPageHtml(browserBaseFromRequest(req, baseUrl), req.params.token));
  };
}
