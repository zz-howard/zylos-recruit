/* zylos-recruit · Kanban board frontend
 * No external dependencies. All logic driven by window.fetch.
 */
(function () {
  'use strict';

  var board = document.getElementById('board');
  var BASE = board.dataset.baseUrl || '';
  var API = BASE + '/api';

  var LS_KEY = 'zylos_recruit_active_company';

  var STATE_LABELS = {
    pending: '待处理',
    scheduled: '已预约',
    interviewed: '已面试',
    passed: '推进中',
    rejected: '人才库',
  };

  var VERDICT_LABELS = {
    yes: '✅ 建议面试',
    no: '❌ 不建议',
    pass: '✅ 通过',
    hold: '⏸ 保留',
    reject: '❌ 淘汰',
  };

  var state = {
    companies: [],
    activeCompanyId: '',
    roles: [],
    candidates: [],
    filterRoleId: '',
    selectedCandidate: null,
    streaming: true, // default; loaded from settings on init
  };

  // ─── HTTP helpers ─────────────────────────────────────────────

  function api(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body != null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(API + path, opts).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return { error: r.statusText }; })
          .then(function (err) { throw new Error(err.error || ('HTTP ' + r.status)); });
      }
      if (r.status === 204) return null;
      return r.json();
    });
  }

  function upload(path, file) {
    var fd = new FormData();
    fd.append('file', file);
    return fetch(API + path, { method: 'POST', body: fd }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return { error: r.statusText }; })
          .then(function (err) { throw new Error(err.error || ('HTTP ' + r.status)); });
      }
      return r.json();
    });
  }

  // ─── Toasts ───────────────────────────────────────────────────

  function toast(msg, kind) {
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 3000);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  // ─── localStorage ─────────────────────────────────────────────

  function loadActiveCompanyFromStorage() {
    try { return localStorage.getItem(LS_KEY) || ''; } catch (e) { return ''; }
  }
  function saveActiveCompanyToStorage(id) {
    try { localStorage.setItem(LS_KEY, id ? String(id) : ''); } catch (e) {}
  }

  // ─── Companies ────────────────────────────────────────────────

  function loadCompanies() {
    return api('GET', '/companies').then(function (r) {
      state.companies = r.companies;
      renderCompanySwitcher();

      var stored = loadActiveCompanyFromStorage();
      var storedValid = stored && state.companies.some(function (c) {
        return String(c.id) === stored;
      });
      if (storedValid) {
        state.activeCompanyId = stored;
      } else if (state.companies.length > 0) {
        state.activeCompanyId = String(state.companies[0].id);
        saveActiveCompanyToStorage(state.activeCompanyId);
      } else {
        state.activeCompanyId = '';
      }
      var sel = document.getElementById('company-switcher');
      sel.value = state.activeCompanyId;
    });
  }

  function renderCompanySwitcher() {
    var sel = document.getElementById('company-switcher');
    sel.innerHTML = '';
    if (state.companies.length === 0) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(no companies — click ⚙ to add)';
      sel.appendChild(opt);
      return;
    }
    state.companies.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = String(c.id);
      opt.textContent = c.name;
      sel.appendChild(opt);
    });
  }

  // ─── Roles + Candidates load ──────────────────────────────────

  function loadRolesAndCandidates() {
    if (!state.activeCompanyId) {
      state.roles = [];
      state.candidates = [];
      renderRoleFilter();
      renderBoard();
      return Promise.resolve();
    }
    var cid = '?company_id=' + encodeURIComponent(state.activeCompanyId);
    return Promise.all([
      api('GET', '/roles' + cid),
      api('GET', '/candidates' + cid),
    ]).then(function (results) {
      state.roles = results[0].roles;
      state.candidates = results[1].candidates;
      renderRoleFilter();
      renderBoard();
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  function loadAll() {
    return loadCompanies().then(loadRolesAndCandidates);
  }

  function renderRoleFilter() {
    var sel = document.getElementById('role-filter');
    var cur = state.filterRoleId;
    sel.innerHTML = '<option value="">All roles</option>';
    state.roles.forEach(function (r) {
      var opt = document.createElement('option');
      opt.value = String(r.id);
      var inactiveTag = r.active === 0 ? ' [停用]' : '';
      opt.textContent = r.name + inactiveTag + ' (' + r.candidate_count + ')';
      sel.appendChild(opt);
    });
    if (cur && !state.roles.some(function (r) { return String(r.id) === cur; })) {
      state.filterRoleId = '';
      cur = '';
    }
    sel.value = cur;
  }

  function renderBoard() {
    var cols = board.querySelectorAll('.col');
    cols.forEach(function (col) {
      var stateName = col.dataset.state;
      var body = col.querySelector('.col-body');
      body.innerHTML = '';
      var items = state.candidates.filter(function (c) {
        if (c.state !== stateName) return false;
        if (state.filterRoleId && String(c.role_id || '') !== state.filterRoleId) return false;
        return true;
      });
      items.forEach(function (c) {
        body.appendChild(makeCard(c));
      });
      col.querySelector('h3').textContent = STATE_LABELS[stateName] + ' · ' + items.length;
    });
  }

  function makeCard(c) {
    var tpl = document.getElementById('tpl-card');
    var node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = c.id;
    node.querySelector('.card-name').textContent = c.name;
    node.querySelector('.card-role').textContent = c.role_name || '(no role)';
    // Show AI verdict badge if available
    var aiEval = (c.evaluations || []).find(function (e) { return e.kind === 'resume_ai'; });
    var briefText = '';
    if (c.is_evaluating) {
      briefText = '⏳ AI 评估中...';
    } else if (aiEval && aiEval.verdict) {
      briefText = (VERDICT_LABELS[aiEval.verdict] || aiEval.verdict);
    } else {
      briefText = c.brief || '';
    }
    node.querySelector('.card-brief').textContent = briefText;

    // Show verdict badges
    var verdictsEl = node.querySelector('.card-verdicts');
    var badges = [];
    if (c.is_evaluating) {
      badges.push('<span class="card-badge badge-evaluating">⏳ 评估中</span>');
    } else if (c.last_ai_verdict != null) {
      var aiLabel = c.last_ai_verdict === 'yes' ? '✅' : '❌';
      var scoreText = c.last_ai_score != null ? c.last_ai_score + '分' : '';
      badges.push('<span class="card-badge badge-ai verdict-' + c.last_ai_verdict + '">AI ' + aiLabel + (scoreText ? ' ' + scoreText : '') + '</span>');
    }
    if (c.last_interview_verdict != null) {
      var ivLabel = VERDICT_LABELS[c.last_interview_verdict] || c.last_interview_verdict;
      badges.push('<span class="card-badge badge-interview verdict-' + c.last_interview_verdict + '">面试 ' + ivLabel + '</span>');
    }
    if (badges.length) verdictsEl.innerHTML = badges.join(' ');

    node.addEventListener('click', function () { openCandidate(c.id); });
    return node;
  }

  // ─── Modal ────────────────────────────────────────────────────

  var modal = document.getElementById('modal');
  var modalBody = document.getElementById('modal-body');

  function openModal(html) {
    modalBody.innerHTML = '';
    if (typeof html === 'string') {
      modalBody.innerHTML = html;
    } else {
      modalBody.appendChild(html);
    }
    modal.classList.remove('hidden');
  }
  function closeModal() {
    modal.classList.add('hidden');
    modalBody.innerHTML = '';
  }
  modal.querySelector('.modal-backdrop').addEventListener('click', closeModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });

  // ─── Candidate detail ────────────────────────────────────────

  function openCandidate(id) {
    api('GET', '/candidates/' + id).then(function (r) {
      state.selectedCandidate = r.candidate;
      renderCandidateModal(r.candidate);
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  function renderCandidateModal(c) {
    var wrap = document.createElement('div');
    wrap.className = 'detail';

    var aiEvals = c.evaluations.filter(function (e) { return e.kind === 'resume_ai'; });
    var interviewEvals = c.evaluations.filter(function (e) { return e.kind !== 'resume_ai'; });

    function inlineField(key, label, value, tag) {
      tag = tag || 'input';
      var display = escapeHtml(value || '') || '<span class="placeholder">' + (label === 'Extra Info' ? '额外信息（如推荐理由、背景补充等）' : '点击添加') + '</span>';
      return '<div class="field inline-edit" data-field="' + key + '">'
        + '<label>' + label + '</label>'
        + '<div class="inline-display" title="点击编辑">' + display + '</div>'
        + '<' + tag + ' type="text" data-k="' + key + '" class="inline-input" style="display:none"'
        + (tag === 'input' ? ' value="' + escapeHtml(value || '') + '"' : '')
        + '>' + (tag === 'textarea' ? escapeHtml(value || '') + '</textarea>' : '')
        + '</div>';
    }

    var left = document.createElement('div');
    left.innerHTML = ''
      + '<h2 class="editable-name" title="点击编辑姓名">' + escapeHtml(c.name) + '</h2>'
      + '<input type="text" data-k="name" value="' + escapeHtml(c.name) + '" class="editable-name-input" style="display:none">'
      + '<div class="meta">'
      +   escapeHtml(c.role_name || '(no role)') + ' · '
      +   escapeHtml(STATE_LABELS[c.state] || c.state)
      + '</div>'
      + '<div class="state-row">'
      +   ['pending','scheduled','interviewed','passed','rejected'].map(function (s) {
            return '<button data-state="' + s + '"'
              + (s === c.state ? ' class="active"' : '')
              + '>' + STATE_LABELS[s] + '</button>';
          }).join('')
      + '</div>'
      + '<div class="field"><label>目标岗位</label>'
      +   '<select data-k="role_id">'
      +     state.roles.map(function (r) {
              var inactiveTag = r.active === 0 ? ' [停用]' : '';
              return '<option value="' + r.id + '"' + (r.id === c.role_id ? ' selected' : '') + '>' + escapeHtml(r.name) + inactiveTag + '</option>';
            }).join('')
      +   '</select>'
      +   '<button class="btn btn-ghost" id="btn-auto-match" style="margin-top:6px;font-size:12px">智能匹配岗位</button>'
      +   '<div id="auto-match-results"></div>'
      + '</div>'
      + inlineField('email', 'Email', c.email)
      + inlineField('phone', 'Phone', c.phone)
      + inlineField('source', 'Source', c.source)
      + inlineField('brief', 'Brief', c.brief, 'textarea')
      + inlineField('extra_info', 'Extra Info', c.extra_info || '', 'textarea')
      + '<div class="field"><button class="btn btn-danger" id="btn-delete-cand">Delete</button></div>'

      // ─── AI Resume Evaluation section ───
      + '<div class="eval-section">'
      + '<h3>AI 简历评估</h3>'
      + (c.resume_path
          ? '<button class="btn btn-primary" id="btn-ai-eval"'
            + (c.is_evaluating ? ' disabled' : '') + '>'
            + (c.is_evaluating ? '⏳ 评估中...' : (aiEvals.length > 0 ? '🤖 重新评估' : '🤖 AI 评估'))
            + '</button>'
          : '<div class="meta">请先上传简历</div>')
      + '<div id="ai-eval-status"></div>'
      + (aiEvals.length > 0
          ? (function () {
              // Show tabs if multiple evaluations, newest first
              var sorted = aiEvals.slice();
              var tabs = '';
              var PAGE_SIZE = 4;
              if (sorted.length > 1) {
                var tabButtons = sorted.map(function (e, i) {
                    var meta = null;
                    try { meta = JSON.parse(e.meta); } catch (x) {}
                    var label = '#' + (sorted.length - i)
                      + (meta && meta.score != null ? ' (' + meta.score + '分)' : '');
                    return '<button class="eval-tab' + (i === 0 ? ' active' : '') + '" data-idx="' + i + '">'
                      + label + '</button>';
                  }).join('');
                var needsPaging = sorted.length > PAGE_SIZE;
                tabs = '<div class="eval-tabs">'
                  + (needsPaging ? '<button class="eval-page-btn eval-page-prev" style="display:none">&lsaquo;</button>' : '')
                  + '<div class="eval-tabs-inner">' + tabButtons + '</div>'
                  + (needsPaging ? '<button class="eval-page-btn eval-page-next">&rsaquo;</button>' : '')
                  + '</div>';
              }
              var panels = sorted.map(function (e, i) {
                var verdictLabel = VERDICT_LABELS[e.verdict] || e.verdict || '';
                var meta = null;
                try { meta = JSON.parse(e.meta); } catch (x) {}
                return '<div class="eval ai-eval eval-panel" data-idx="' + i + '"'
                  + (i > 0 ? ' style="display:none"' : '') + '>'
                  + '<div class="eval-head">'
                  +   '<span class="verdict-badge verdict-' + escapeHtml(e.verdict) + '">'
                  +     escapeHtml(verdictLabel) + '</span>'
                  +   (meta && meta.score != null ? ' <span class="meta">Score: ' + meta.score + '/100</span>' : '')
                  +   '<span class="meta">' + escapeHtml(e.author || '') + ' · ' + escapeHtml(e.created_at) + '</span>'
                  + '</div>'
                  + '<div class="eval-body">' + formatEvalContent(e.content || '') + '</div>'
                  + '</div>';
              }).join('');
              return tabs + panels;
            })()
          : '<div class="meta">尚未进行 AI 评估</div>')
      + '</div>'

      // ─── Interview Feedback section ───
      + '<div class="eval-section">'
      + '<h3>面试记录</h3>'
      + '<div class="field"><label>Verdict</label>'
      +   '<select id="eval-verdict">'
      +     '<option value="">—</option>'
      +     '<option value="pass">✅ 通过</option>'
      +     '<option value="hold">⏸ 保留</option>'
      +     '<option value="reject">❌ 淘汰</option>'
      +   '</select></div>'
      + '<div class="field"><label>Notes</label>'
      +   '<textarea id="eval-content" placeholder="面试反馈..."></textarea></div>'
      + '<button class="btn btn-primary" id="btn-add-eval">添加面试记录</button>'
      + (interviewEvals.length > 0
          ? interviewEvals.map(function (e) {
              var verdictLabel = VERDICT_LABELS[e.verdict] || e.verdict || '';
              return '<div class="eval">'
                + '<div class="eval-head">'
                +   (e.verdict ? '<span class="verdict-badge verdict-' + escapeHtml(e.verdict) + '">'
                    + escapeHtml(verdictLabel) + '</span> ' : '')
                +   '<span>' + escapeHtml(e.author || 'anon') + '</span>'
                +   '<span class="meta">' + escapeHtml(e.created_at) + '</span>'
                + '</div>'
                + '<div class="eval-body">' + escapeHtml(e.content || '') + '</div>'
                + '</div>';
            }).join('')
          : '<div class="meta">暂无面试记录</div>')
      + '</div>';

    var right = document.createElement('div');
    var resumePane = document.createElement('div');
    resumePane.className = 'resume-pane';
    var resumeUrl = API + '/candidates/' + c.id + '/resume';
    resumePane.innerHTML = '<div class="resume-head">'
      + '<span>Resume</span>'
      + '<span class="resume-actions">'
      + (c.resume_path
          ? '<a href="' + resumeUrl + '" target="_blank" class="btn resume-action-btn" title="Open in new tab">&#8599;</a>'
          + '<a href="' + resumeUrl + '?dl=1" download class="btn resume-action-btn" title="Download">&#8615;</a>'
          : '')
      + '<label class="btn" style="cursor:pointer">Upload'
      +   '<input type="file" id="resume-file" accept="application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" style="display:none"></label>'
      + '</span>'
      + '</div>'
      + (c.resume_path
          ? '<div class="pdf-viewer" data-url="' + resumeUrl + '">'
            + '<div class="pdf-controls">'
            + '<button class="btn pdf-nav" data-dir="-1">‹</button>'
            + '<span class="pdf-page-info">Loading…</span>'
            + '<button class="btn pdf-nav" data-dir="1">›</button>'
            + '</div>'
            + '<div class="pdf-canvas-wrap"><canvas></canvas></div>'
            + '</div>'
          : '<div class="no-resume">No resume uploaded</div>');
    right.appendChild(resumePane);

    wrap.appendChild(left);
    wrap.appendChild(right);
    openModal(wrap);

    // Inline save helper — saves a single field
    function inlineSave(key, value) {
      var updates = {};
      updates[key] = value;
      if (key === 'role_id') { updates.role_id = value ? Number(value) : null; }
      api('PUT', '/candidates/' + c.id, updates)
        .then(function () { toast('已保存', 'success'); return loadRolesAndCandidates(); })
        .catch(function (err) { toast(err.message, 'error'); });
    }

    // Click-to-edit name
    var nameH2 = wrap.querySelector('.editable-name');
    var nameInput = wrap.querySelector('.editable-name-input');
    nameH2.addEventListener('click', function () {
      nameH2.style.display = 'none';
      nameInput.style.display = '';
      nameInput.focus();
    });
    function commitName() {
      var val = nameInput.value.trim() || c.name;
      nameH2.textContent = val;
      nameH2.style.display = '';
      nameInput.style.display = 'none';
      if (val !== c.name) { c.name = val; inlineSave('name', val); }
    }
    nameInput.addEventListener('blur', commitName);
    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
      if (e.key === 'Escape') { nameInput.value = c.name; nameInput.blur(); }
    });

    // Click-to-edit for all inline fields
    wrap.querySelectorAll('.inline-edit').forEach(function (field) {
      var key = field.dataset.field;
      var display = field.querySelector('.inline-display');
      var input = field.querySelector('.inline-input');
      var origVal = input.value || input.textContent;

      display.addEventListener('click', function () {
        display.style.display = 'none';
        input.style.display = '';
        input.focus();
      });

      function commit() {
        var val = input.value;
        var showVal = escapeHtml(val) || '<span class="placeholder">点击添加</span>';
        display.innerHTML = showVal;
        display.style.display = '';
        input.style.display = 'none';
        if (val !== origVal) { origVal = val; inlineSave(key, val); }
      }

      input.addEventListener('blur', commit);
      if (input.tagName === 'INPUT') {
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
          if (e.key === 'Escape') { input.value = origVal; input.blur(); }
        });
      }
      if (input.tagName === 'TEXTAREA') {
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') { input.value = origVal; input.blur(); }
        });
      }
    });

    // Auto-save role dropdown on change
    var roleSelect = wrap.querySelector('[data-k="role_id"]');
    if (roleSelect) {
      roleSelect.addEventListener('change', function () {
        inlineSave('role_id', roleSelect.value);
      });
    }

    // Auto-match button
    var autoMatchBtn = wrap.querySelector('#btn-auto-match');
    if (autoMatchBtn) {
      autoMatchBtn.addEventListener('click', function () {
        var resultsEl = wrap.querySelector('#auto-match-results');
        autoMatchBtn.disabled = true;
        autoMatchBtn.textContent = '匹配中...';
        resultsEl.innerHTML = '';
        api('POST', '/candidates/' + c.id + '/auto-match')
          .then(function (r) {
            autoMatchBtn.disabled = false;
            autoMatchBtn.textContent = '智能匹配岗位';
            if (!r.matches || r.matches.length === 0) {
              resultsEl.innerHTML = '<div class="meta">未找到匹配的岗位</div>';
              return;
            }
            var html = '<div class="match-results">';
            r.matches.forEach(function (m) {
              var scoreClass = m.score >= 70 ? 'high' : (m.score >= 40 ? 'medium' : 'low');
              html += '<div class="match-item" data-role-id="' + m.role_id + '">'
                + '<div class="match-score ' + scoreClass + '">' + m.score + '</div>'
                + '<div class="match-info">'
                + '<div class="match-name">' + escapeHtml(m.role_name) + '</div>'
                + '<div class="match-reason">' + escapeHtml(m.reason) + '</div>'
                + '</div>'
                + '<button class="match-assign" data-role-id="' + m.role_id + '">分配</button>'
                + '</div>';
            });
            html += '</div>';
            resultsEl.innerHTML = html;
            resultsEl.querySelectorAll('.match-assign').forEach(function (btn) {
              btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var rid = btn.dataset.roleId;
                api('PUT', '/candidates/' + c.id, { role_id: Number(rid) })
                  .then(function () {
                    toast('已分配岗位', 'success');
                    return loadRolesAndCandidates().then(function () { openCandidate(c.id); });
                  })
                  .catch(function (err) { toast(err.message, 'error'); });
              });
            });
          })
          .catch(function (err) {
            autoMatchBtn.disabled = false;
            autoMatchBtn.textContent = '智能匹配岗位';
            toast('匹配失败: ' + err.message, 'error');
          });
      });
    }

    // Render PDF with pdf.js
    var pdfViewer = wrap.querySelector('.pdf-viewer');
    if (pdfViewer) {
      var pdfUrl = pdfViewer.dataset.url;
      var canvas = pdfViewer.querySelector('canvas');
      var pageInfo = pdfViewer.querySelector('.pdf-page-info');
      var pdfState = { doc: null, page: 1, total: 0, rendering: false };

      function renderPage(num) {
        if (!pdfState.doc || pdfState.rendering) return;
        pdfState.rendering = true;
        pdfState.doc.getPage(num).then(function (page) {
          var wrap = pdfViewer.querySelector('.pdf-canvas-wrap');
          var dpr = window.devicePixelRatio || 1;
          var cssWidth = wrap.clientWidth || 400;
          var scale = cssWidth / page.getViewport({ scale: 1 }).width;
          var viewport = page.getViewport({ scale: scale * dpr });
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = cssWidth + 'px';
          canvas.style.height = (viewport.height / dpr) + 'px';
          page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise.then(function () {
            pdfState.rendering = false;
            pageInfo.textContent = num + ' / ' + pdfState.total;
          });
        });
      }

      if (typeof pdfjsLib === 'undefined') { pageInfo.textContent = 'PDF viewer unavailable'; pdfState.rendering = false; return; }
      pdfjsLib.getDocument(pdfUrl).promise.then(function (doc) {
        pdfState.doc = doc;
        pdfState.total = doc.numPages;
        renderPage(1);
      }).catch(function () {
        pageInfo.textContent = 'Failed to load PDF';
      });

      pdfViewer.querySelectorAll('.pdf-nav').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var dir = Number(btn.dataset.dir);
          var next = pdfState.page + dir;
          if (next >= 1 && next <= pdfState.total) {
            pdfState.page = next;
            renderPage(next);
          }
        });
      });
    }

    // Wire state buttons
    wrap.querySelectorAll('.state-row button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var s = btn.dataset.state;
        api('POST', '/candidates/' + c.id + '/move', { state: s })
          .then(function () {
            toast('Moved to ' + STATE_LABELS[s], 'success');
            return loadRolesAndCandidates().then(function () { openCandidate(c.id); });
          })
          .catch(function (err) { toast(err.message, 'error'); });
      });
    });

    // Eval tabs switching + pagination
    var tabsContainer = wrap.querySelector('.eval-tabs-inner');
    if (tabsContainer) {
      var allTabs = Array.from(tabsContainer.querySelectorAll('.eval-tab'));
      var pageSize = 4;
      var currentPage = 0;
      var totalPages = Math.ceil(allTabs.length / pageSize);
      var prevBtn = wrap.querySelector('.eval-page-prev');
      var nextBtn = wrap.querySelector('.eval-page-next');

      function showTabPage(page) {
        currentPage = page;
        var start = page * pageSize;
        var end = start + pageSize;
        allTabs.forEach(function (t, i) {
          t.style.display = (i >= start && i < end) ? '' : 'none';
        });
        if (prevBtn) prevBtn.style.display = page > 0 ? '' : 'none';
        if (nextBtn) nextBtn.style.display = page < totalPages - 1 ? '' : 'none';
      }

      showTabPage(0);

      if (prevBtn) prevBtn.addEventListener('click', function () { showTabPage(currentPage - 1); });
      if (nextBtn) nextBtn.addEventListener('click', function () { showTabPage(currentPage + 1); });

      allTabs.forEach(function (tab) {
        tab.addEventListener('click', function () {
          var idx = tab.dataset.idx;
          allTabs.forEach(function (t) { t.classList.remove('active'); });
          tab.classList.add('active');
          wrap.querySelectorAll('.eval-panel').forEach(function (p) {
            p.style.display = p.dataset.idx === idx ? '' : 'none';
          });
        });
      });
    } else {
      // Single eval, no tabs container
      wrap.querySelectorAll('.eval-tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
          var idx = tab.dataset.idx;
          wrap.querySelectorAll('.eval-tab').forEach(function (t) { t.classList.remove('active'); });
          tab.classList.add('active');
          wrap.querySelectorAll('.eval-panel').forEach(function (p) {
            p.style.display = p.dataset.idx === idx ? '' : 'none';
          });
        });
      });
    }

    // Delete candidate
    wrap.querySelector('#btn-delete-cand').addEventListener('click', function () {
      if (!confirm('Delete this candidate? This cannot be undone.')) return;
      api('DELETE', '/candidates/' + c.id)
        .then(function () { toast('Deleted'); closeModal(); return loadRolesAndCandidates(); })
        .catch(function (err) { toast(err.message, 'error'); });
    });

    // AI evaluate button — streaming (SSE) or polling based on settings
    var aiBtn = wrap.querySelector('#btn-ai-eval');
    if (aiBtn) {
      aiBtn.addEventListener('click', function () {
        var statusEl = wrap.querySelector('#ai-eval-status');
        aiBtn.disabled = true;
        aiBtn.textContent = '⏳ 评估中...';
        statusEl.textContent = '';

        if (state.streaming) {
          // ── Streaming mode: real-time SSE ──
          var streamArea = wrap.querySelector('.ai-stream-output');
          if (!streamArea) {
            streamArea = document.createElement('pre');
            streamArea.className = 'ai-stream-output';
            statusEl.parentNode.insertBefore(streamArea, statusEl.nextSibling);
          }
          streamArea.textContent = '';
          streamArea.style.display = 'block';

          fetch(API + '/candidates/' + c.id + '/ai-evaluate/stream', { method: 'POST' })
            .then(function (response) {
              if (!response.ok) {
                return response.json().catch(function () { return { error: response.statusText }; })
                  .then(function (err) { throw new Error(err.error || ('HTTP ' + response.status)); });
              }
              var reader = response.body.getReader();
              var decoder = new TextDecoder();
              var buf = '';

              function pump() {
                return reader.read().then(function (result) {
                  if (result.done) return;
                  buf += decoder.decode(result.value, { stream: true });
                  var parts = buf.split('\n\n');
                  buf = parts.pop();
                  parts.forEach(function (part) {
                    var line = part.trim();
                    if (!line.startsWith('data: ')) return;
                    var evt;
                    try { evt = JSON.parse(line.substring(6)); } catch (_) { return; }
                    if (evt.type === 'chunk') {
                      streamArea.textContent += evt.text;
                      streamArea.scrollTop = streamArea.scrollHeight;
                    } else if (evt.type === 'status') {
                      statusEl.textContent = evt.text;
                    } else if (evt.type === 'done') {
                      toast('AI 评估完成', 'success');
                      loadRolesAndCandidates().then(function () { openCandidate(c.id); });
                    } else if (evt.type === 'error') {
                      aiBtn.disabled = false;
                      aiBtn.textContent = '🤖 AI 评估';
                      statusEl.textContent = '❌ ' + evt.message;
                      statusEl.className = 'meta error';
                      streamArea.style.display = 'none';
                      toast(evt.message, 'error');
                    }
                  });
                  return pump();
                });
              }
              return pump();
            })
            .catch(function (err) {
              aiBtn.disabled = false;
              aiBtn.textContent = '🤖 AI 评估';
              statusEl.textContent = '❌ ' + err.message;
              statusEl.className = 'meta error';
              streamArea.style.display = 'none';
              toast(err.message, 'error');
            });
        } else {
          // ── Polling mode: async + poll every 5s ──
          var evalCountBefore = (c.evaluations || []).filter(function (e) { return e.kind === 'resume_ai'; }).length;
          api('POST', '/candidates/' + c.id + '/ai-evaluate')
            .then(function () {
              toast('AI 评估已启动，请稍候...', 'success');
              var pollCount = 0;
              var maxPolls = 36;
              var pollTimer = setInterval(function () {
                pollCount++;
                fetch(API + '/candidates/' + c.id + '?_t=' + Date.now()).then(function (r) { return r.json(); }).then(function (data) {
                  var cand = data.candidate;
                  var currentCount = (cand.evaluations || []).filter(function (e) { return e.kind === 'resume_ai'; }).length;
                  if (currentCount > evalCountBefore || pollCount >= maxPolls) {
                    clearInterval(pollTimer);
                    if (currentCount > evalCountBefore) {
                      toast('AI 评估完成', 'success');
                    } else {
                      toast('AI 评估超时，请刷新页面查看', 'warning');
                    }
                    loadRolesAndCandidates().then(function () { openCandidate(c.id); });
                  }
                }).catch(function () {});
              }, 5000);
            })
            .catch(function (err) {
              aiBtn.disabled = false;
              aiBtn.textContent = '🤖 AI 评估';
              statusEl.textContent = '❌ ' + err.message;
              statusEl.className = 'meta error';
              toast(err.message, 'error');
            });
        }
      });
    }

    // Auto-poll if evaluation already in progress (e.g. triggered from submit form)
    if (c.is_evaluating) {
      var evalCountBefore = aiEvals.length;
      var pollCount = 0;
      var maxPolls = 36;
      var pollTimer = setInterval(function () {
        pollCount++;
        fetch(API + '/candidates/' + c.id + '?_t=' + Date.now()).then(function (r) { return r.json(); }).then(function (data) {
          var cand = data.candidate;
          var currentCount = (cand.evaluations || []).filter(function (e) { return e.kind === 'resume_ai'; }).length;
          if (currentCount > evalCountBefore || pollCount >= maxPolls) {
            clearInterval(pollTimer);
            if (currentCount > evalCountBefore) {
              toast('AI 评估完成', 'success');
            } else {
              toast('AI 评估超时，请刷新页面查看', 'warning');
            }
            loadRolesAndCandidates().then(function () { openCandidate(c.id); });
          }
        }).catch(function () {});
      }, 5000);
    }

    // Add interview evaluation
    wrap.querySelector('#btn-add-eval').addEventListener('click', function () {
      var body = {
        kind: 'interview',
        author: 'howard',
        verdict: wrap.querySelector('#eval-verdict').value || null,
        content: wrap.querySelector('#eval-content').value || '',
      };
      if (!body.content.trim()) { toast('请填写面试反馈', 'error'); return; }
      api('POST', '/candidates/' + c.id + '/evaluate', body)
        .then(function () {
          toast('面试记录已添加', 'success');
          return loadRolesAndCandidates().then(function () { openCandidate(c.id); });
        })
        .catch(function (err) { toast(err.message, 'error'); });
    });

    // Resume upload
    var fileInput = wrap.querySelector('#resume-file');
    fileInput.addEventListener('change', function () {
      if (!fileInput.files[0]) return;
      upload('/candidates/' + c.id + '/resume', fileInput.files[0])
        .then(function () {
          toast('Resume uploaded', 'success');
          return loadRolesAndCandidates().then(function () { openCandidate(c.id); });
        })
        .catch(function (err) { toast(err.message, 'error'); });
    });
  }

  function formatEvalContent(content) {
    // Simple markdown-ish formatting for AI eval content
    return escapeHtml(content)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  // ─── New role / candidate forms ───────────────────────────────

  function openNewRoleForm() {
    if (!state.activeCompanyId) {
      toast('Please create/select a company first', 'error');
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'form-dialog';
    wrap.innerHTML = ''
      + '<h2>New Role</h2>'
      + '<div class="field"><label>Name</label>'
      +   '<input type="text" id="f-name" placeholder="e.g. LLM 算法工程师"></div>'
      + '<div class="field"><label>Description (optional)</label>'
      +   '<textarea id="f-desc"></textarea></div>'
      + '<div class="actions">'
      +   '<button class="btn" id="f-cancel">Cancel</button>'
      +   '<button class="btn btn-primary" id="f-save">Create</button>'
      + '</div>';
    openModal(wrap);
    wrap.querySelector('#f-cancel').addEventListener('click', closeModal);
    wrap.querySelector('#f-save').addEventListener('click', function () {
      var name = wrap.querySelector('#f-name').value.trim();
      var description = wrap.querySelector('#f-desc').value.trim();
      if (!name) { toast('name required', 'error'); return; }
      api('POST', '/roles', {
        company_id: Number(state.activeCompanyId),
        name: name,
        description: description,
      })
        .then(function () { toast('Role created', 'success'); closeModal(); return loadRolesAndCandidates(); })
        .catch(function (err) { toast(err.message, 'error'); });
    });
  }

  function openNewCandidateForm() {
    if (!state.activeCompanyId) {
      toast('Please create/select a company first', 'error');
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'form-dialog';
    var roleOptions = '<option value="auto">Auto (自动匹配)</option>' + state.roles.map(function (r) {
      return '<option value="' + r.id + '">' + escapeHtml(r.name) + '</option>';
    }).join('');
    wrap.innerHTML = ''
      + '<h2>New Candidate</h2>'
      + '<div class="field"><label>Role</label><select id="f-role">' + roleOptions + '</select></div>'
      + '<div class="field"><label>Resume *</label>'
      +   '<div class="drop-zone" id="f-drop-zone">'
      +     '<input type="file" id="f-resume" accept="application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document">'
      +     '<div class="drop-zone-text">拖拽简历到此处，或点击选择文件（PDF / DOCX）</div>'
      +   '</div></div>'
      + '<div class="field"><label>Extra Info</label>'
      +   '<textarea id="f-extra-info" placeholder="额外信息（如推荐理由、背景补充等）" rows="3"></textarea></div>'
      + '<div id="f-status"></div>'
      + '<div class="actions">'
      +   '<button class="btn" id="f-cancel">Cancel</button>'
      +   '<button class="btn btn-primary" id="f-save">Submit</button>'
      + '</div>';
    openModal(wrap);
    // Drag-and-drop for resume upload
    var dropZone = wrap.querySelector('#f-drop-zone');
    var fileInput = wrap.querySelector('#f-resume');
    var dropText = wrap.querySelector('.drop-zone-text');
    dropZone.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (fileInput.files[0]) dropText.textContent = fileInput.files[0].name;
    });
    ['dragenter', 'dragover'].forEach(function (evt) {
      dropZone.addEventListener(evt, function (e) { e.preventDefault(); dropZone.classList.add('drag-over'); });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      dropZone.addEventListener(evt, function (e) { e.preventDefault(); dropZone.classList.remove('drag-over'); });
    });
    dropZone.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files[0];
      var validTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
      if (f && (validTypes.indexOf(f.type) !== -1 || f.name.match(/\.(pdf|docx)$/i))) {
        fileInput.files = e.dataTransfer.files;
        dropText.textContent = f.name;
      } else {
        toast('请上传 PDF 或 DOCX 文件', 'error');
      }
    });
    wrap.querySelector('#f-cancel').addEventListener('click', closeModal);
    wrap.querySelector('#f-save').addEventListener('click', function () {
      var roleId = wrap.querySelector('#f-role').value;
      var isAuto = roleId === 'auto';
      var file = wrap.querySelector('#f-resume').files[0];
      var extraInfo = wrap.querySelector('#f-extra-info').value.trim();
      if (!file) { toast('请上传简历文件（PDF 或 DOCX）', 'error'); return; }
      var btn = wrap.querySelector('#f-save');
      var statusEl = wrap.querySelector('#f-status');
      btn.disabled = true;
      btn.textContent = 'Submitting...';
      statusEl.textContent = '';
      // 1) Create candidate (name auto-filled by AI later)
      var body = { company_id: Number(state.activeCompanyId) };
      if (!isAuto) body.role_id = Number(roleId);
      if (extraInfo) body.extra_info = extraInfo;
      api('POST', '/candidates', body)
        .then(function (r) {
          var candId = r.candidate.id;
          statusEl.textContent = '上传简历中...';
          // 2) Upload resume
          return upload('/candidates/' + candId + '/resume', file).then(function () {
            // 3) Auto-match if needed, then AI evaluation
            if (isAuto) {
              statusEl.textContent = '自动匹配岗位中...';
              return api('POST', '/candidates/' + candId + '/auto-match-resume').then(function (match) {
                statusEl.textContent = '已匹配「' + match.role_name + '」，AI 评估中...';
                return api('POST', '/candidates/' + candId + '/ai-evaluate');
              });
            } else {
              statusEl.textContent = 'AI 评估中...';
              return api('POST', '/candidates/' + candId + '/ai-evaluate');
            }
          }).then(function () {
            toast('已提交，AI 评估进行中', 'success');
            closeModal();
            return loadRolesAndCandidates();
          });
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'Submit';
          statusEl.textContent = '';
          toast(err.message, 'error');
        });
    });
  }

  // ─── Role management ─────────────────────────────────────────

  function openRoleManager() {
    if (!state.activeCompanyId) {
      toast('Please select a company first', 'error');
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'form-dialog';
    wrap.innerHTML = ''
      + '<h2>Manage Roles</h2>'
      + '<div id="role-list"></div>'
      + '<hr>'
      + '<h3>Add new role</h3>'
      + '<div class="field"><label>Name</label>'
      +   '<input type="text" id="f-role-name" placeholder="e.g. LLM 架构师"></div>'
      + '<div class="actions">'
      +   '<button class="btn" id="f-close">Close</button>'
      +   '<button class="btn btn-primary" id="f-add">Create role</button>'
      + '</div>';
    openModal(wrap);

    function rerender() {
      var list = wrap.querySelector('#role-list');
      if (state.roles.length === 0) {
        list.innerHTML = '<div class="meta">No roles yet.</div>';
        return;
      }
      list.innerHTML = state.roles.map(function (r) {
        var isActive = r.active !== 0;
        var badgeClass = isActive ? 'active' : 'inactive';
        var badgeLabel = isActive ? '活跃' : '停用';
        var toggleLabel = isActive ? '停用' : '启用';
        var toggleClass = isActive ? 'btn-ghost' : 'btn-primary';
        return ''
          + '<div class="company-row' + (isActive ? '' : ' role-inactive') + '" data-id="' + r.id + '">'
          +   '<div class="company-row-head">'
          +     '<strong>' + escapeHtml(r.name) + '</strong>'
          +     '<span class="role-active-badge ' + badgeClass + '">' + badgeLabel + '</span>'
          +     '<span class="meta"> · ' + (r.candidate_count || 0) + ' candidates</span>'
          +   '</div>'
          +   '<div class="company-row-actions">'
          +     '<button class="btn ' + toggleClass + '" data-act="toggle" style="min-width:48px">' + toggleLabel + '</button>'
          +     '<button class="btn btn-ghost" data-act="edit">Edit</button>'
          +     '<button class="btn btn-ghost" data-act="jd">JD</button>'
          +     '<button class="btn btn-ghost" data-act="portrait">Portrait</button>'
          +     '<button class="btn btn-ghost" data-act="eval-prompt">Eval prompt</button>'
          +     '<button class="btn btn-danger btn-ghost" data-act="delete">Delete</button>'
          +   '</div>'
          + '</div>';
      }).join('');

      list.querySelectorAll('.company-row').forEach(function (row) {
        var id = Number(row.dataset.id);
        row.querySelector('[data-act="toggle"]').addEventListener('click', function () {
          var role = state.roles.find(function (r) { return r.id === id; });
          if (!role) return;
          var newActive = role.active === 0;
          api('PUT', '/roles/' + id, { active: newActive })
            .then(function () {
              toast(newActive ? '已启用' : '已停用', 'success');
              return loadRolesAndCandidates().then(rerender);
            })
            .catch(function (err) { toast(err.message, 'error'); });
        });
        row.querySelector('[data-act="edit"]').addEventListener('click', function () {
          openRoleEditor(id);
        });
        row.querySelector('[data-act="jd"]').addEventListener('click', function () {
          openRoleJdEditor(id);
        });
        row.querySelector('[data-act="portrait"]').addEventListener('click', function () {
          openRoleProfileEditor(id);
        });
        row.querySelector('[data-act="eval-prompt"]').addEventListener('click', function () {
          openEvalPromptEditor('role', id);
        });
        row.querySelector('[data-act="delete"]').addEventListener('click', function () {
          if (!confirm('Delete this role? Candidates in this role will be unassigned (role set to null). This cannot be undone.')) return;
          api('DELETE', '/roles/' + id)
            .then(function () { toast('Deleted', 'success'); return loadRolesAndCandidates().then(rerender); })
            .catch(function (err) { toast(err.message, 'error'); });
        });
      });
    }

    rerender();

    wrap.querySelector('#f-close').addEventListener('click', closeModal);
    wrap.querySelector('#f-add').addEventListener('click', function () {
      var name = wrap.querySelector('#f-role-name').value.trim();
      if (!name) { toast('name required', 'error'); return; }
      api('POST', '/roles', {
        company_id: Number(state.activeCompanyId),
        name: name,
      })
        .then(function () {
          toast('Role created', 'success');
          wrap.querySelector('#f-role-name').value = '';
          return loadRolesAndCandidates().then(rerender);
        })
        .catch(function (err) { toast(err.message, 'error'); });
    });
  }

  function openRoleEditor(roleId) {
    api('GET', '/roles/' + roleId).then(function (r) {
      var role = r.role;
      var wrap = document.createElement('div');
      wrap.className = 'form-dialog';
      wrap.innerHTML = ''
        + '<h2>Edit Role</h2>'
        + '<div class="field"><label>Name</label>'
        +   '<input type="text" id="f-name"></div>'
        + '<div class="actions">'
        +   '<button class="btn" id="f-cancel">Cancel</button>'
        +   '<button class="btn btn-primary" id="f-save">Save</button>'
        + '</div>';
      openModal(wrap);
      wrap.querySelector('#f-name').value = role.name || '';
      wrap.querySelector('#f-cancel').addEventListener('click', openRoleManager);
      wrap.querySelector('#f-save').addEventListener('click', function () {
        var name = wrap.querySelector('#f-name').value.trim();
        if (!name) { toast('name required', 'error'); return; }
        api('PUT', '/roles/' + roleId, { name: name })
          .then(function () {
            toast('Saved', 'success');
            return loadRolesAndCandidates().then(openRoleManager);
          })
          .catch(function (err) { toast(err.message, 'error'); });
      });
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  function openRoleJdEditor(roleId) {
    api('GET', '/roles/' + roleId).then(function (r) {
      var role = r.role;
      var wrap = document.createElement('div');
      wrap.className = 'form-dialog';
      wrap.innerHTML = ''
        + '<h2>JD — ' + escapeHtml(role.name) + '</h2>'
        + '<div class="meta">Public job description (岗位描述). Markdown supported.</div>'
        + '<div class="field"><textarea id="f-jd" rows="20" placeholder="## 岗位职责\n\n## 任职要求\n\n## 加分项"></textarea></div>'
        + '<div class="actions">'
        +   '<button class="btn" id="f-cancel">Cancel</button>'
        +   '<button class="btn btn-primary" id="f-save">Save</button>'
        + '</div>';
      openModal(wrap);
      wrap.querySelector('#f-jd').value = role.description || '';
      wrap.querySelector('#f-cancel').addEventListener('click', openRoleManager);
      wrap.querySelector('#f-save').addEventListener('click', function () {
        var content = wrap.querySelector('#f-jd').value.trim();
        api('PUT', '/roles/' + roleId, { description: content || null })
          .then(function () { toast('JD saved', 'success'); openRoleManager(); })
          .catch(function (err) { toast(err.message, 'error'); });
      });
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  function openRoleProfileEditor(roleId) {
    api('GET', '/roles/' + roleId).then(function (r) {
      var role = r.role;
      var wrap = document.createElement('div');
      wrap.className = 'form-dialog';
      var currentContent = role.expected_portrait || (role.profile ? role.profile.content : '') || '';
      var currentVersion = role.profile ? role.profile.version : 0;
      wrap.innerHTML = ''
        + '<h2>Expected Portrait — ' + escapeHtml(role.name) + '</h2>'
        + '<div class="meta">Internal candidate portrait (期望画像). Primary basis for AI evaluation. Each save creates a new version. Current version: ' + currentVersion + '</div>'
        + '<div class="field"><textarea id="f-profile" rows="20" placeholder="## 核心要求\\n\\n## 加分项\\n\\n## 红线"></textarea></div>'
        + '<div class="actions">'
        +   '<button class="btn" id="f-cancel">Cancel</button>'
        +   '<button class="btn btn-primary" id="f-save">Save as new version</button>'
        + '</div>';
      openModal(wrap);
      wrap.querySelector('#f-profile').value = currentContent;
      wrap.querySelector('#f-cancel').addEventListener('click', openRoleManager);
      wrap.querySelector('#f-save').addEventListener('click', function () {
        var content = wrap.querySelector('#f-profile').value;
        if (!content.trim()) { toast('content required', 'error'); return; }
        api('PUT', '/roles/' + roleId + '/profile', { content: content })
          .then(function () { toast('Portrait saved', 'success'); openRoleManager(); })
          .catch(function (err) { toast(err.message, 'error'); });
      });
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  // ─── Eval prompt editor (shared for company & role) ──────────

  function openEvalPromptEditor(type, id) {
    var endpoint = type === 'company' ? '/companies/' + id : '/roles/' + id;
    var backFn = type === 'company' ? openCompanyManager : openRoleManager;
    api('GET', endpoint).then(function (r) {
      var entity = type === 'company' ? r.company : r.role;
      var wrap = document.createElement('div');
      wrap.className = 'form-dialog';
      var label = type === 'company' ? 'Company' : 'Role';
      wrap.innerHTML = ''
        + '<h2>AI Eval Prompt — ' + escapeHtml(entity.name) + '</h2>'
        + '<div class="meta">' + label + '-level custom instructions for AI resume evaluation. '
        + (type === 'company'
            ? 'Applies to all roles in this company.'
            : 'Applies only to this role (in addition to company-level prompt).')
        + '</div>'
        + '<div class="field"><textarea id="f-eval-prompt" rows="12" placeholder="e.g. 我们偏好有创业经历的候选人，技术深度优先于广度"></textarea></div>'
        + '<div class="actions">'
        +   '<button class="btn" id="f-cancel">Cancel</button>'
        +   '<button class="btn btn-danger btn-ghost" id="f-clear" style="margin-right:auto">Clear</button>'
        +   '<button class="btn btn-primary" id="f-save">Save</button>'
        + '</div>';
      openModal(wrap);
      wrap.querySelector('#f-eval-prompt').value = entity.eval_prompt || '';
      wrap.querySelector('#f-cancel').addEventListener('click', backFn);
      wrap.querySelector('#f-clear').addEventListener('click', function () {
        wrap.querySelector('#f-eval-prompt').value = '';
      });
      wrap.querySelector('#f-save').addEventListener('click', function () {
        var val = wrap.querySelector('#f-eval-prompt').value.trim();
        var body = { eval_prompt: val || '' };
        if (type === 'company') body.name = entity.name;
        api('PUT', endpoint, body)
          .then(function () { toast('Eval prompt saved', 'success'); backFn(); })
          .catch(function (err) { toast(err.message, 'error'); });
      });
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  // ─── Company management ──────────────────────────────────────

  function openCompanyManager() {
    var wrap = document.createElement('div');
    wrap.className = 'form-dialog';
    wrap.innerHTML = ''
      + '<h2>Manage Companies</h2>'
      + '<div id="company-list"></div>'
      + '<hr>'
      + '<h3>Add new company</h3>'
      + '<div class="field"><label>Name</label>'
      +   '<input type="text" id="f-company-name" placeholder="e.g. COCO"></div>'
      + '<div class="actions">'
      +   '<button class="btn" id="f-close">Close</button>'
      +   '<button class="btn btn-primary" id="f-add">Create company</button>'
      + '</div>';
    openModal(wrap);

    function rerender() {
      var list = wrap.querySelector('#company-list');
      if (state.companies.length === 0) {
        list.innerHTML = '<div class="meta">No companies yet.</div>';
        return;
      }
      list.innerHTML = state.companies.map(function (c) {
        return ''
          + '<div class="company-row" data-id="' + c.id + '">'
          +   '<div class="company-row-head">'
          +     '<strong>' + escapeHtml(c.name) + '</strong>'
          +     '<span class="meta"> · ' + c.role_count + ' roles · ' + c.candidate_count + ' candidates</span>'
          +   '</div>'
          +   '<div class="company-row-actions">'
          +     '<button class="btn btn-ghost" data-act="rename">Rename</button>'
          +     '<button class="btn btn-ghost" data-act="profile">Edit profile</button>'
          +     '<button class="btn btn-ghost" data-act="eval-prompt">Eval prompt</button>'
          +     '<button class="btn btn-danger btn-ghost" data-act="delete">Delete</button>'
          +   '</div>'
          + '</div>';
      }).join('');

      list.querySelectorAll('.company-row').forEach(function (row) {
        var id = Number(row.dataset.id);
        row.querySelector('[data-act="rename"]').addEventListener('click', function () {
          var cur = state.companies.find(function (x) { return x.id === id; });
          var name = prompt('New company name:', cur ? cur.name : '');
          if (!name || !name.trim()) return;
          api('PUT', '/companies/' + id, { name: name.trim() })
            .then(function () { toast('Renamed', 'success'); return loadAll().then(rerender); })
            .catch(function (err) { toast(err.message, 'error'); });
        });
        row.querySelector('[data-act="profile"]').addEventListener('click', function () {
          openCompanyProfileEditor(id);
        });
        row.querySelector('[data-act="eval-prompt"]').addEventListener('click', function () {
          openEvalPromptEditor('company', id);
        });
        row.querySelector('[data-act="delete"]').addEventListener('click', function () {
          if (!confirm('Delete this company? All its roles and candidates will be deleted too. This cannot be undone.')) return;
          api('DELETE', '/companies/' + id)
            .then(function () {
              toast('Deleted', 'success');
              if (String(id) === state.activeCompanyId) {
                state.activeCompanyId = '';
                saveActiveCompanyToStorage('');
              }
              return loadAll().then(rerender);
            })
            .catch(function (err) { toast(err.message, 'error'); });
        });
      });
    }

    rerender();

    wrap.querySelector('#f-close').addEventListener('click', closeModal);
    wrap.querySelector('#f-add').addEventListener('click', function () {
      var name = wrap.querySelector('#f-company-name').value.trim();
      if (!name) { toast('name required', 'error'); return; }
      api('POST', '/companies', { name: name })
        .then(function (r) {
          toast('Company created', 'success');
          wrap.querySelector('#f-company-name').value = '';
          if (!state.activeCompanyId && r && r.company) {
            state.activeCompanyId = String(r.company.id);
            saveActiveCompanyToStorage(state.activeCompanyId);
          }
          return loadAll().then(function () {
            document.getElementById('company-switcher').value = state.activeCompanyId;
            rerender();
          });
        })
        .catch(function (err) { toast(err.message, 'error'); });
    });
  }

  function openCompanyProfileEditor(companyId) {
    api('GET', '/companies/' + companyId).then(function (r) {
      var company = r.company;
      var wrap = document.createElement('div');
      wrap.className = 'form-dialog';
      var currentContent = company.profile ? company.profile.content : '';
      var currentVersion = company.profile ? company.profile.version : 0;
      wrap.innerHTML = ''
        + '<h2>Company Profile — ' + escapeHtml(company.name) + '</h2>'
        + '<div class="meta">Markdown. Each save creates a new version. Current version: ' + currentVersion + '</div>'
        + '<div class="field"><textarea id="f-profile" rows="20" placeholder="## 公司背景\\n\\n规模、业务、阶段、价值观、招聘关键方向..."></textarea></div>'
        + '<div class="actions">'
        +   '<button class="btn" id="f-cancel">Cancel</button>'
        +   '<button class="btn btn-primary" id="f-save">Save as new version</button>'
        + '</div>';
      openModal(wrap);
      wrap.querySelector('#f-profile').value = currentContent;
      wrap.querySelector('#f-cancel').addEventListener('click', function () {
        openCompanyManager();
      });
      wrap.querySelector('#f-save').addEventListener('click', function () {
        var content = wrap.querySelector('#f-profile').value;
        if (!content.trim()) { toast('content required', 'error'); return; }
        api('PUT', '/companies/' + companyId + '/profile', { content: content })
          .then(function () { toast('Profile saved', 'success'); openCompanyManager(); })
          .catch(function (err) { toast(err.message, 'error'); });
      });
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  // ─── Settings ────────────────────────────────────────────────

  function openSettings() {
    var wrap = document.createElement('div');
    wrap.className = 'form-dialog';
    wrap.innerHTML = '<h2>Settings</h2><div class="meta">Loading...</div>';
    openModal(wrap);

    var SCENARIOS = [
      { key: 'resume_eval', label: '简历评估' },
      { key: 'auto_match', label: '智能匹配' },
      { key: 'chat', label: '需求访谈' },
      { key: 'chat_summary', label: '访谈汇总' },
      { key: 'portrait', label: '岗位画像' },
    ];

    api('GET', '/settings').then(function (r) {
      var ai = r.ai;
      var raw = ai.raw || {};
      var defaultModelMap = { claude: 'sonnet', codex: 'gpt-5.4', chatgpt: 'gpt-5.4', gemini: 'gemini-2.5-flash' };
      var runtimeLabels = { claude: 'Claude CLI', codex: 'Codex CLI', chatgpt: 'ChatGPT (Pro subscription)', gemini: 'Gemini CLI' };

      function makeRuntimeOptions(selected) {
        var opts = [{ value: '', label: '跟随默认' }, { value: 'auto', label: 'Auto (' + ai.envRuntime + ')' }];
        ['claude', 'codex', 'chatgpt', 'gemini'].forEach(function (rt) {
          var installed = ai.availableRuntimes.indexOf(rt) !== -1;
          var label = runtimeLabels[rt] || rt;
          opts.push({ value: rt, label: label + (installed ? '' : ' (not installed)'), disabled: !installed });
        });
        return opts.map(function (o) {
          return '<option value="' + o.value + '"' + (o.disabled ? ' disabled' : '') + (o.value === selected ? ' selected' : '') + '>' + escapeHtml(o.label) + '</option>';
        }).join('');
      }

      function makeModelOptions(runtime, selected) {
        var ert = (!runtime || runtime === 'auto') ? ai.envRuntime : runtime;
        var dm = defaultModelMap[ert] || 'sonnet';
        var opts = '<option value=""' + (!selected ? ' selected' : '') + '>跟随默认</option>';
        opts += '<option value="auto"' + (selected === 'auto' ? ' selected' : '') + '>Auto (' + dm + ')</option>';
        (ai.validModels[ert] || []).forEach(function (m) {
          opts += '<option value="' + m + '"' + (selected === m ? ' selected' : '') + '>' + escapeHtml(m) + '</option>';
        });
        return opts;
      }

      function makeEffortOptions(runtime, selected) {
        var ert = (!runtime || runtime === 'auto') ? ai.envRuntime : runtime;
        var efList = ai.validEfforts[ert] || ai.validEfforts.claude || [];
        var opts = '<option value=""' + (!selected ? ' selected' : '') + '>跟随默认</option>';
        efList.forEach(function (e) {
          opts += '<option value="' + e + '"' + (selected === e ? ' selected' : '') + '>' + e + '</option>';
        });
        return opts;
      }

      // Default row
      var defCfg = raw.default || { runtime: raw.runtime || 'auto', model: raw.model || 'auto', effort: raw.effort || 'medium' };

      var html = '<h2>Settings</h2>';
      html += '<div class="meta" style="margin-bottom:12px;">Installed: ' + escapeHtml(ai.availableRuntimes.join(', ') || 'none') + '</div>';

      // Table header
      html += '<table class="settings-table" style="width:100%;border-collapse:collapse;font-size:13px;">';
      html += '<thead><tr><th style="text-align:left;padding:6px 8px;">场景</th><th style="padding:6px 8px;">Runtime</th><th style="padding:6px 8px;">Model</th><th style="padding:6px 8px;">Effort</th></tr></thead>';
      html += '<tbody>';

      // Default row
      html += '<tr style="background:var(--bg-secondary,#f5f5f5);font-weight:600;">';
      html += '<td style="padding:6px 8px;">默认</td>';
      html += '<td style="padding:4px 4px;"><select data-key="default" data-field="runtime" style="width:100%;">' + makeRuntimeOptions(defCfg.runtime).replace('跟随默认', '—') + '</select></td>';
      html += '<td style="padding:4px 4px;"><select data-key="default" data-field="model" style="width:100%;">' + makeModelOptions(defCfg.runtime, defCfg.model).replace('跟随默认', '—') + '</select></td>';
      html += '<td style="padding:4px 4px;"><select data-key="default" data-field="effort" style="width:100%;">' + makeEffortOptions(defCfg.runtime, defCfg.effort).replace('跟随默认', '—') + '</select></td>';
      html += '</tr>';

      // Scenario rows
      SCENARIOS.forEach(function (s) {
        var sCfg = raw[s.key] || {};
        html += '<tr>';
        html += '<td style="padding:6px 8px;">' + escapeHtml(s.label) + '</td>';
        html += '<td style="padding:4px 4px;"><select data-key="' + s.key + '" data-field="runtime" style="width:100%;">' + makeRuntimeOptions(sCfg.runtime || '') + '</select></td>';
        html += '<td style="padding:4px 4px;"><select data-key="' + s.key + '" data-field="model" style="width:100%;">' + makeModelOptions(sCfg.runtime || defCfg.runtime, sCfg.model || '') + '</select></td>';
        html += '<td style="padding:4px 4px;"><select data-key="' + s.key + '" data-field="effort" style="width:100%;">' + makeEffortOptions(sCfg.runtime || defCfg.runtime, sCfg.effort || '') + '</select></td>';
        html += '</tr>';
      });

      html += '</tbody></table>';
      html += '<label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;cursor:pointer;">'
        + '<input type="checkbox" id="f-streaming"' + (ai.streaming !== false ? ' checked' : '') + '>'
        + '流式输出（实时显示 AI 评估过程）'
        + '</label>';
      html += '<div class="actions" style="margin-top:16px;">';
      html += '<button class="btn" id="f-close">Close</button>';
      html += '<button class="btn btn-primary" id="f-save">Save</button>';
      html += '</div>';

      wrap.innerHTML = html;

      // When runtime changes, update model+effort options for that row
      wrap.querySelectorAll('select[data-field="runtime"]').forEach(function (sel) {
        sel.addEventListener('change', function () {
          var key = this.getAttribute('data-key');
          var rt = this.value || (key !== 'default' ? wrap.querySelector('select[data-key="default"][data-field="runtime"]').value : 'auto');
          var row = this.closest('tr');
          var modelSel = row.querySelector('select[data-field="model"]');
          var effortSel = row.querySelector('select[data-field="effort"]');
          var curModel = modelSel.value;
          var curEffort = effortSel.value;
          modelSel.innerHTML = makeModelOptions(rt, curModel);
          effortSel.innerHTML = makeEffortOptions(rt, curEffort);
        });
      });

      wrap.querySelector('#f-close').addEventListener('click', closeModal);
      wrap.querySelector('#f-save').addEventListener('click', function () {
        var payload = {};

        // Read default row
        payload.default = {
          runtime: wrap.querySelector('select[data-key="default"][data-field="runtime"]').value || 'auto',
          model: wrap.querySelector('select[data-key="default"][data-field="model"]').value || 'auto',
          effort: wrap.querySelector('select[data-key="default"][data-field="effort"]').value || 'medium',
        };

        // Read scenario rows — only include non-empty overrides
        SCENARIOS.forEach(function (s) {
          var rt = wrap.querySelector('select[data-key="' + s.key + '"][data-field="runtime"]').value;
          var md = wrap.querySelector('select[data-key="' + s.key + '"][data-field="model"]').value;
          var ef = wrap.querySelector('select[data-key="' + s.key + '"][data-field="effort"]').value;
          if (rt || md || ef) {
            payload[s.key] = {};
            if (rt) payload[s.key].runtime = rt;
            if (md) payload[s.key].model = md;
            if (ef) payload[s.key].effort = ef;
          }
        });

        payload.streaming = wrap.querySelector('#f-streaming').checked;

        api('PUT', '/settings', { ai: payload })
          .then(function () {
            state.streaming = payload.streaming;
            toast('Settings saved', 'success');
            closeModal();
          })
          .catch(function (err) { toast(err.message, 'error'); });
      });
    }).catch(function (err) {
      wrap.innerHTML = '<h2>Settings</h2><div class="meta error">Failed to load settings: ' + escapeHtml(err.message) + '</div>'
        + '<div class="actions"><button class="btn" id="f-close">Close</button></div>';
      wrap.querySelector('#f-close').addEventListener('click', closeModal);
    });
  }

  // ─── Top bar wiring ──────────────────────────────────────────

  document.getElementById('company-switcher').addEventListener('change', function (e) {
    state.activeCompanyId = e.target.value;
    state.filterRoleId = '';
    saveActiveCompanyToStorage(state.activeCompanyId);
    loadRolesAndCandidates();
  });

  document.getElementById('btn-manage-companies').addEventListener('click', openCompanyManager);
  document.getElementById('btn-manage-roles').addEventListener('click', openRoleManager);
  document.getElementById('btn-new-role').addEventListener('click', openNewRoleForm);
  document.getElementById('btn-new-candidate').addEventListener('click', openNewCandidateForm);
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('role-filter').addEventListener('change', function (e) {
    state.filterRoleId = e.target.value;
    renderBoard();
  });

  // ─── Board auto-refresh when evaluations in progress ────────

  var boardPollTimer = null;

  function startBoardPolling() {
    if (boardPollTimer) return;
    boardPollTimer = setInterval(function () {
      var hasEvaluating = state.candidates.some(function (c) { return c.is_evaluating; });
      if (!hasEvaluating) {
        clearInterval(boardPollTimer);
        boardPollTimer = null;
        return;
      }
      loadRolesAndCandidates();
    }, 5000);
  }

  // Hook into renderBoard to auto-start polling when needed
  var _origRenderBoard = renderBoard;
  renderBoard = function () {
    _origRenderBoard();
    var hasEvaluating = state.candidates.some(function (c) { return c.is_evaluating; });
    if (hasEvaluating) startBoardPolling();
  };

  // ─── Sidebar Tab Switching ────────────────────────────────────

  var sidebarTabs = document.querySelectorAll('.sidebar-tab');
  var topbarKanban = document.getElementById('topbar-right-kanban');
  var topbarInterviews = document.getElementById('topbar-right-interviews');
  var interviewsView = document.getElementById('interviews-view');
  var currentTab = 'kanban';

  sidebarTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var tabName = tab.dataset.tab;
      if (tabName === currentTab) return;
      currentTab = tabName;
      sidebarTabs.forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');

      if (tabName === 'kanban') {
        board.classList.remove('hidden');
        interviewsView.classList.add('hidden');
        topbarKanban.classList.remove('hidden');
        topbarInterviews.classList.add('hidden');
      } else if (tabName === 'interviews') {
        board.classList.add('hidden');
        interviewsView.classList.remove('hidden');
        topbarKanban.classList.add('hidden');
        topbarInterviews.classList.remove('hidden');
        loadInterviews();
      }
    });
  });

  // ─── Internal Interviews ─────────────────────────────────────

  var interviewsData = [];
  var selectedInterviewIds = new Set();

  function loadInterviews() {
    if (!state.activeCompanyId) {
      interviewsData = [];
      renderInterviewsList([]);
      return;
    }
    api('GET', '/internal-interviews?company_id=' + state.activeCompanyId)
      .then(function (r) {
        interviewsData = r.interviews || [];
        selectedInterviewIds.clear();
        renderInterviewsList(interviewsData);
      })
      .catch(function (err) {
        toast('加载访谈列表失败: ' + err.message, 'error');
      });
  }

  function renderInterviewsList(interviews) {
    var container = document.getElementById('interviews-list');
    if (!interviews || interviews.length === 0) {
      container.innerHTML = '<div class="interviews-empty">暂无访谈记录，点击右上角"+ 新建访谈"开始</div>';
      updateGenerateBtn();
      return;
    }

    var html = '';
    interviews.forEach(function (iv) {
      var statusClass = iv.status === 'active' ? 'active' : 'completed';
      var statusLabel = iv.status === 'active' ? '进行中' : '已完成';
      var date = iv.created_at ? new Date(iv.created_at + 'Z').toLocaleString('zh-CN') : '';
      var msgCount = iv.message_count || 0;
      var chatUrl = BASE + '/chat/' + iv.token;
      var checked = selectedInterviewIds.has(iv.id) ? ' checked' : '';
      var hasContent = iv.status === 'completed' || msgCount > 0;

      html += '<div class="interview-card" data-id="' + iv.id + '">';
      if (hasContent) {
        html += '<input type="checkbox" class="interview-checkbox" data-id="' + iv.id + '"' + checked + '>';
      } else {
        html += '<div style="width:18px"></div>';
      }
      html += '<div class="interview-card-info">';
      html += '<div class="interview-card-name">' + escapeHtml(iv.interviewee_name) + '</div>';
      html += '<div class="interview-card-meta">';
      html += '<span>' + date + '</span>';
      html += '<span>' + msgCount + ' 条消息</span>';
      html += '</div>';
      if (iv.summary) {
        html += '<div class="interview-summary-preview" id="summary-' + iv.id + '">' + escapeHtml(iv.summary) + '</div>';
      }
      html += '</div>';
      html += '<div class="interview-card-actions">';
      html += '<span class="interview-status ' + statusClass + '">' + statusLabel + '</span>';
      if (iv.status === 'active') {
        html += '<a class="interview-link" href="' + chatUrl + '" target="_blank">打开访谈</a>';
      }
      if (iv.summary) {
        html += '<span class="interview-link btn-view-summary" data-id="' + iv.id + '">查看汇总</span>';
      } else if (iv.summary_generating) {
        html += '<span class="interview-link btn-gen-summary generating" data-token="' + iv.token + '" style="color:var(--muted);pointer-events:none">生成中...</span>';
      } else if (iv.status === 'completed' && msgCount > 0) {
        html += '<span class="interview-link btn-gen-summary" data-token="' + iv.token + '" style="color:var(--accent)">生成汇总</span>';
      }
      html += '<span class="interview-link btn-copy-link" data-url="' + escapeHtml(chatUrl) + '">复制链接</span>';
      html += '<span class="interview-link btn-delete-interview" style="color:var(--danger)" data-id="' + iv.id + '">删除</span>';
      html += '</div>';
      html += '</div>';
    });

    container.innerHTML = html;

    // Bind checkbox events
    container.querySelectorAll('.interview-checkbox').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = Number(cb.dataset.id);
        if (cb.checked) {
          selectedInterviewIds.add(id);
        } else {
          selectedInterviewIds.delete(id);
        }
        updateGenerateBtn();
      });
    });

    // Bind action buttons (CSP blocks inline onclick — use addEventListener)
    container.querySelectorAll('.btn-view-summary').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var el = document.getElementById('summary-' + btn.dataset.id);
        if (el) el.classList.toggle('visible');
      });
    });
    container.querySelectorAll('.btn-copy-link').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var fullUrl = window.location.origin + btn.dataset.url;
        navigator.clipboard.writeText(fullUrl).then(function () {
          toast('链接已复制', 'success');
        }).catch(function () {
          prompt('复制此链接:', fullUrl);
        });
      });
    });
    container.querySelectorAll('.btn-delete-interview').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.dataset.id);
        if (!confirm('确认删除此访谈？')) return;
        api('DELETE', '/internal-interviews/' + id).then(function () {
          toast('已删除', 'success');
          loadInterviews();
        }).catch(function (err) {
          toast('删除失败: ' + err.message, 'error');
        });
      });
    });

    // Poll helper for summary generation
    function pollSummary(token, btn) {
      var pollInterval = setInterval(function () {
        fetch(BASE + '/api/chat/' + token + '/summary-status')
          .then(function (r) { return r.json(); })
          .then(function (s) {
            if (s.has_summary) {
              clearInterval(pollInterval);
              loadInterviews();
            } else if (!s.generating) {
              clearInterval(pollInterval);
              btn.textContent = '生成汇总';
              btn.style.pointerEvents = '';
              btn.style.color = 'var(--accent)';
              btn.classList.remove('generating');
              toast('汇总生成失败，请重试', 'error');
            }
          });
      }, 3000);
    }

    // Auto-poll for interviews already generating on page load
    container.querySelectorAll('.btn-gen-summary.generating').forEach(function (btn) {
      pollSummary(btn.dataset.token, btn);
    });

    container.querySelectorAll('.btn-gen-summary:not(.generating)').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var token = btn.dataset.token;
        btn.textContent = '生成中...';
        btn.style.pointerEvents = 'none';
        btn.style.color = 'var(--muted)';
        btn.classList.add('generating');
        fetch(BASE + '/api/chat/' + token + '/generate-summary', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.error) {
              toast('生成失败: ' + data.error, 'error');
              btn.textContent = '生成汇总';
              btn.style.pointerEvents = '';
              btn.style.color = 'var(--accent)';
              btn.classList.remove('generating');
            } else {
              toast('汇总正在后台生成', 'success');
              pollSummary(token, btn);
            }
          })
          .catch(function (err) {
            toast('请求失败: ' + err.message, 'error');
            btn.textContent = '生成汇总';
            btn.style.pointerEvents = '';
            btn.style.color = 'var(--accent)';
            btn.classList.remove('generating');
          });
      });
    });

    updateGenerateBtn();
  }

  function updateGenerateBtn() {
    var btn = document.getElementById('btn-generate-portrait');
    if (!btn) return;
    var count = selectedInterviewIds.size;
    if (count > 0) {
      btn.style.display = '';
      btn.textContent = '生成岗位画像 (' + count + ')';
    } else {
      btn.style.display = 'none';
    }
  }

  // Portrait generation
  var btnGenerate = document.getElementById('btn-generate-portrait');
  if (btnGenerate) {
    btnGenerate.addEventListener('click', function () {
      if (selectedInterviewIds.size === 0) return;
      var ids = Array.from(selectedInterviewIds);
      btnGenerate.disabled = true;
      btnGenerate.textContent = '正在生成...';

      api('POST', '/internal-interviews/generate-portrait', { interview_ids: ids })
        .then(function (r) {
          btnGenerate.disabled = false;
          updateGenerateBtn();
          showPortraitResult(r.portrait, r.suggested_name);
        })
        .catch(function (err) {
          btnGenerate.disabled = false;
          updateGenerateBtn();
          toast('生成失败: ' + err.message, 'error');
        });
    });
  }

  function showPortraitResult(portrait, suggestedName) {
    var html = '<div class="form-dialog" style="max-width:800px">' +
      '<h2>岗位画像建议</h2>' +
      '<div class="field"><label>岗位名称</label>' +
      '<input type="text" id="portrait-role-name" value="' + escapeHtml(suggestedName) + '" placeholder="输入岗位名称"></div>' +
      '<div class="field"><label>岗位画像（Expected Portrait）</label>' +
      '<textarea id="portrait-content" rows="20" style="font-size:13px;line-height:1.6">' + escapeHtml(portrait) + '</textarea></div>' +
      '<div class="actions">' +
      '<button class="btn" id="portrait-cancel">取消</button>' +
      '<button class="btn btn-primary" id="portrait-save">收录为新角色</button>' +
      '</div></div>';

    openModal(html);

    document.getElementById('portrait-cancel').addEventListener('click', closeModal);
    document.getElementById('portrait-save').addEventListener('click', function () {
      var roleName = document.getElementById('portrait-role-name').value.trim();
      var content = document.getElementById('portrait-content').value.trim();
      if (!roleName) { toast('请输入岗位名称', 'error'); return; }
      if (!content) { toast('画像内容不能为空', 'error'); return; }

      api('POST', '/roles', {
        company_id: Number(state.activeCompanyId),
        name: roleName,
        expected_portrait: content,
      }).then(function () {
        closeModal();
        toast('已收录为新角色: ' + roleName, 'success');
        loadRolesAndCandidates();
      }).catch(function (err) {
        toast('收录失败: ' + err.message, 'error');
      });
    });
  }


  // New interview
  var btnNewInterview = document.getElementById('btn-new-interview');
  if (btnNewInterview) {
    btnNewInterview.addEventListener('click', function () {
      if (!state.activeCompanyId) {
        toast('请先选择一家公司', 'error');
        return;
      }
      showNewInterviewDialog();
    });
  }

  function showNewInterviewDialog() {
    var html = '<div class="form-dialog">' +
      '<h2>新建需求访谈</h2>' +
      '<div class="field"><label>被访谈人姓名</label>' +
      '<input type="text" id="ii-name" placeholder="例：Kevin" autofocus></div>' +
      '<div class="actions">' +
      '<button class="btn" id="ii-cancel">取消</button>' +
      '<button class="btn btn-primary" id="ii-create">创建</button>' +
      '</div></div>';

    openModal(html);

    document.getElementById('ii-cancel').addEventListener('click', closeModal);
    document.getElementById('ii-create').addEventListener('click', function () {
      var name = document.getElementById('ii-name').value.trim();
      if (!name) { toast('请输入姓名', 'error'); return; }

      api('POST', '/internal-interviews', {
        company_id: Number(state.activeCompanyId),
        interviewee_name: name,
      }).then(function (r) {
        closeModal();
        toast('访谈已创建', 'success');
        loadInterviews();
        var chatUrl = BASE + '/chat/' + r.interview.token;
        window.open(chatUrl, '_blank');
      }).catch(function (err) {
        toast('创建失败: ' + err.message, 'error');
      });
    });

    document.getElementById('ii-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('ii-create').click();
      }
    });
  }

  // ─── Go ──────────────────────────────────────────────────────

  // Load streaming preference from settings
  api('GET', '/settings').then(function (r) {
    state.streaming = r.ai.streaming !== false;
  }).catch(function () {});

  loadAll().then(function () {
    if (state.companies.length === 0) {
      toast('No companies yet — click ⚙ to create one', 'info');
    }
  });
})();
