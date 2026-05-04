import { kanbanPageHtml } from '../templates/kanban.js';
import { browserBaseFromRequest } from '../lib/browser-base.js';

export function uiRoute(baseUrl) {
  return (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(kanbanPageHtml(browserBaseFromRequest(req, baseUrl)));
  };
}
