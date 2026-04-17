import { chatPageHtml } from '../templates/chat.js';

export function chatPageRoute(baseUrl) {
  return (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(chatPageHtml(baseUrl, req.params.token));
  };
}
