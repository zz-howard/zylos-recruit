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
    passed: '可推进',
    rejected: '人才库',
  };

  var VERDICT_LABELS = {
    yes: '✅ 建议面试',
    maybe: '⚠️ 待定',
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
      opt.textContent = r.name + ' (' + r.candidate_count + ')';
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

    var left = document.createElement('div');
    left.innerHTML = ''
      + '<h2>' + escapeHtml(c.name) + '</h2>'
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
      + '<div class="field"><label>Email</label>'
      +   '<input type="email" data-k="email" value="' + escapeHtml(c.email) + '"></div>'
      + '<div class="field"><label>Phone</label>'
      +   '<input type="text" data-k="phone" value="' + escapeHtml(c.phone) + '"></div>'
      + '<div class="field"><label>Source</label>'
      +   '<input type="text" data-k="source" value="' + escapeHtml(c.source) + '"></div>'
      + '<div class="field"><label>Brief</label>'
      +   '<textarea data-k="brief">' + escapeHtml(c.brief) + '</textarea></div>'
      + '<div class="field"><label>Extra Info</label>'
      +   '<textarea data-k="extra_info" placeholder="额外信息（如推荐理由、背景补充等）">' + escapeHtml(c.extra_info || '') + '</textarea></div>'
      + '<div class="field"><button class="btn btn-primary" id="btn-save-cand">Save changes</button> '
      +   '<button class="btn btn-danger" id="btn-delete-cand">Delete</button></div>'

      // ─── AI Resume Evaluation section ───
      + '<div class="eval-section">'
      + '<h3>AI 简历评估</h3>'
      + (c.resume_path
          ? '<button class="btn btn-primary" id="btn-ai-eval"'
            + (c.is_evaluating ? ' disabled' : '') + '>'
            + (c.is_evaluating ? '⏳ 评估中...' : (aiEvals.length > 0 ? '🤖 重新评估' : '🤖 AI 评估'))
            + '</button>'
          : '<div class="meta">请先上传简历 PDF</div>')
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
      +   '<input type="file" id="resume-file" accept="application/pdf" style="display:none"></label>'
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

    // Save candidate
    wrap.querySelector('#btn-save-cand').addEventListener('click', function () {
      var updates = {};
      wrap.querySelectorAll('[data-k]').forEach(function (el) {
        updates[el.dataset.k] = el.value;
      });
      api('PUT', '/candidates/' + c.id, updates)
        .then(function () { toast('Saved', 'success'); return loadRolesAndCandidates(); })
        .catch(function (err) { toast(err.message, 'error'); });
    });

    // Delete candidate
    wrap.querySelector('#btn-delete-cand').addEventListener('click', function () {
      if (!confirm('Delete this candidate? This cannot be undone.')) return;
      api('DELETE', '/candidates/' + c.id)
        .then(function () { toast('Deleted'); closeModal(); return loadRolesAndCandidates(); })
        .catch(function (err) { toast(err.message, 'error'); });
    });

    // AI evaluate button
    var aiBtn = wrap.querySelector('#btn-ai-eval');
    if (aiBtn) {
      aiBtn.addEventListener('click', function () {
        var statusEl = wrap.querySelector('#ai-eval-status');
        aiBtn.disabled = true;
        aiBtn.textContent = '⏳ 评估中...';
        statusEl.textContent = '';
        var evalCountBefore = (c.evaluations || []).filter(function (e) { return e.kind === 'resume_ai'; }).length;
        api('POST', '/candidates/' + c.id + '/ai-evaluate')
          .then(function () {
            toast('AI 评估已启动，请稍候...', 'success');
            // Poll for result every 5s, up to 3 minutes
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
    if (state.roles.length === 0) {
      toast('Please create a role first', 'error');
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'form-dialog';
    var roleOptions = state.roles.map(function (r) {
      return '<option value="' + r.id + '">' + escapeHtml(r.name) + '</option>';
    }).join('');
    wrap.innerHTML = ''
      + '<h2>New Candidate</h2>'
      + '<div class="field"><label>Role *</label><select id="f-role">' + roleOptions + '</select></div>'
      + '<div class="field"><label>Resume PDF *</label>'
      +   '<input type="file" id="f-resume" accept="application/pdf"></div>'
      + '<div class="field"><label>Extra Info</label>'
      +   '<textarea id="f-extra-info" placeholder="额外信息（如推荐理由、背景补充等）" rows="3"></textarea></div>'
      + '<div id="f-status"></div>'
      + '<div class="actions">'
      +   '<button class="btn" id="f-cancel">Cancel</button>'
      +   '<button class="btn btn-primary" id="f-save">Submit</button>'
      + '</div>';
    openModal(wrap);
    wrap.querySelector('#f-cancel').addEventListener('click', closeModal);
    wrap.querySelector('#f-save').addEventListener('click', function () {
      var roleId = wrap.querySelector('#f-role').value;
      var file = wrap.querySelector('#f-resume').files[0];
      var extraInfo = wrap.querySelector('#f-extra-info').value.trim();
      if (!roleId) { toast('Please select a role', 'error'); return; }
      if (!file) { toast('Please upload a resume PDF', 'error'); return; }
      var btn = wrap.querySelector('#f-save');
      var statusEl = wrap.querySelector('#f-status');
      btn.disabled = true;
      btn.textContent = 'Submitting...';
      statusEl.textContent = '';
      // 1) Create candidate (name auto-filled by AI later)
      var body = {
        company_id: Number(state.activeCompanyId),
        role_id: Number(roleId),
      };
      if (extraInfo) body.extra_info = extraInfo;
      api('POST', '/candidates', body)
        .then(function (r) {
          var candId = r.candidate.id;
          statusEl.textContent = 'Uploading resume...';
          // 2) Upload resume
          return upload('/candidates/' + candId + '/resume', file).then(function () {
            statusEl.textContent = 'Starting AI evaluation...';
            // 3) Auto-trigger AI evaluation
            return api('POST', '/candidates/' + candId + '/ai-evaluate').then(function () {
              toast('Submitted — AI evaluation in progress', 'success');
              closeModal();
              return loadRolesAndCandidates();
            });
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
        return ''
          + '<div class="company-row" data-id="' + r.id + '">'
          +   '<div class="company-row-head">'
          +     '<strong>' + escapeHtml(r.name) + '</strong>'
          +     '<span class="meta"> · ' + (r.candidate_count || 0) + ' candidates</span>'
          +   '</div>'
          +   '<div class="company-row-actions">'
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
    wrap.innerHTML = ''
      + '<h2>Settings</h2>'
      + '<div class="meta">Loading...</div>';
    openModal(wrap);

    api('GET', '/settings').then(function (r) {
      var ai = r.ai;

      // Runtime options
      var runtimeOptions = [{ value: 'auto', label: 'Auto (' + ai.envRuntime + ')' }];
      ['claude', 'codex', 'gemini'].forEach(function (rt) {
        var installed = ai.availableRuntimes.indexOf(rt) !== -1;
        runtimeOptions.push({
          value: rt,
          label: rt.charAt(0).toUpperCase() + rt.slice(1) + (installed ? '' : ' (not installed)'),
          disabled: !installed,
        });
      });
      var runtimeHtml = runtimeOptions.map(function (o) {
        return '<option value="' + o.value + '"'
          + (o.disabled ? ' disabled' : '')
          + (o.value === ai.runtime ? ' selected' : '')
          + '>' + escapeHtml(o.label) + '</option>';
      }).join('');

      // Model options — show models for the effective runtime
      var effectiveRt = ai.runtime === 'auto' ? ai.envRuntime : ai.runtime;
      var defaultModelMap = { claude: 'sonnet', codex: 'gpt-5.4', gemini: 'gemini-2.5-flash' };
      var defaultModel = defaultModelMap[effectiveRt] || 'sonnet';
      var modelOptions = '<option value="auto"' + (ai.model === 'auto' ? ' selected' : '') + '>Auto (' + defaultModel + ')</option>';
      var models = ai.validModels[effectiveRt] || [];
      models.forEach(function (m) {
        modelOptions += '<option value="' + m + '"' + (ai.model === m ? ' selected' : '') + '>' + escapeHtml(m) + '</option>';
      });

      // Effort options (per runtime)
      var effortList = ai.validEfforts[effectiveRt] || ai.validEfforts.claude || [];
      var effortHtml = effortList.map(function (e) {
        return '<option value="' + e + '"' + (ai.effort === e ? ' selected' : '') + '>' + e + '</option>';
      }).join('');

      wrap.innerHTML = ''
        + '<h2>Settings</h2>'
        + '<div class="field"><label>Runtime</label>'
        +   '<select id="f-runtime">' + runtimeHtml + '</select></div>'
        + '<div class="field"><label>Model</label>'
        +   '<select id="f-model">' + modelOptions + '</select></div>'
        + '<div class="field"><label>Thinking Effort</label>'
        +   '<select id="f-effort">' + effortHtml + '</select></div>'
        + '<div class="meta">Effective: <strong>' + escapeHtml(ai.effective) + '</strong>'
        +   ' · Installed: ' + (ai.availableRuntimes.length > 0 ? escapeHtml(ai.availableRuntimes.join(', ')) : 'none')
        + '</div>'
        + '<div class="actions">'
        +   '<button class="btn" id="f-close">Close</button>'
        +   '<button class="btn btn-primary" id="f-save">Save</button>'
        + '</div>';

      // Update model and effort dropdowns when runtime changes
      wrap.querySelector('#f-runtime').addEventListener('change', function () {
        var rt = this.value;
        var ert = rt === 'auto' ? ai.envRuntime : rt;
        var dmMap = { claude: 'sonnet', codex: 'gpt-5.4', gemini: 'gemini-2.5-flash' };
        var dm = dmMap[ert] || 'sonnet';
        var ms = ai.validModels[ert] || [];
        var sel = wrap.querySelector('#f-model');
        sel.innerHTML = '<option value="auto">Auto (' + dm + ')</option>'
          + ms.map(function (m) { return '<option value="' + m + '">' + escapeHtml(m) + '</option>'; }).join('');
        var ef = ai.validEfforts[ert] || [];
        var efSel = wrap.querySelector('#f-effort');
        var curEffort = efSel.value;
        efSel.innerHTML = ef.map(function (e) {
          return '<option value="' + e + '"' + (e === curEffort ? ' selected' : '') + '>' + e + '</option>';
        }).join('');
      });

      wrap.querySelector('#f-close').addEventListener('click', closeModal);
      wrap.querySelector('#f-save').addEventListener('click', function () {
        var payload = {
          runtime: wrap.querySelector('#f-runtime').value,
          model: wrap.querySelector('#f-model').value,
          effort: wrap.querySelector('#f-effort').value,
        };
        api('PUT', '/settings', { ai: payload })
          .then(function () {
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

  // ─── Go ──────────────────────────────────────────────────────

  loadAll().then(function () {
    if (state.companies.length === 0) {
      toast('No companies yet — click ⚙ to create one', 'info');
    }
  });
})();
