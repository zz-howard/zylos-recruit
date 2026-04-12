// Kanban board page template for zylos-recruit.

const ASSET_VERSION = Date.now();

export function kanbanPageHtml(baseUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recruit — Zylos</title>
<link rel="stylesheet" href="${baseUrl}/_assets/style.css?v=${ASSET_VERSION}">
<link rel="stylesheet" href="${baseUrl}/_assets/kanban.css?v=${ASSET_VERSION}">
</head>
<body>
  <header class="topbar">
    <div class="topbar-left">
      <strong>Zylos Recruit</strong>
      <span class="sep">·</span>
      <select id="company-switcher" title="Active company">
        <option value="">(no company)</option>
      </select>
      <button id="btn-manage-companies" class="btn btn-ghost" title="Manage companies">⚙</button>
    </div>
    <div class="topbar-right">
      <select id="role-filter">
        <option value="">All roles</option>
      </select>
      <button id="btn-manage-roles" class="btn btn-ghost" title="Manage roles">☰</button>
      <button id="btn-new-role" class="btn">+ Role</button>
      <button id="btn-new-candidate" class="btn btn-primary">+ Candidate</button>
      <form id="logout-form" method="POST" action="${baseUrl}/logout" style="display:inline">
        <button type="submit" class="btn btn-ghost">Logout</button>
      </form>
    </div>
  </header>

  <main id="board" class="board" data-base-url="${baseUrl}">
    <div class="col" data-state="pending"><h3>待处理</h3><div class="col-body"></div></div>
    <div class="col" data-state="scheduled"><h3>已预约</h3><div class="col-body"></div></div>
    <div class="col" data-state="interviewed"><h3>已完成</h3><div class="col-body"></div></div>
    <div class="col" data-state="passed"><h3>可推进</h3><div class="col-body"></div></div>
    <div class="col" data-state="rejected"><h3>人才库</h3><div class="col-body"></div></div>
  </main>

  <div id="modal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-content">
      <button class="modal-close" id="modal-close">×</button>
      <div id="modal-body"></div>
    </div>
  </div>

  <template id="tpl-card">
    <div class="card" data-id="">
      <div class="card-name"></div>
      <div class="card-role"></div>
      <div class="card-brief"></div>
    </div>
  </template>

  <script src="${baseUrl}/_assets/pdf.min.js"></script>
  <script>if(window.pdfjsLib){pdfjsLib.GlobalWorkerOptions.workerSrc='${baseUrl}/_assets/pdf.worker.min.js';}</script>
  <script src="${baseUrl}/_assets/kanban.js?v=${ASSET_VERSION}"></script>
</body>
</html>`;
}
