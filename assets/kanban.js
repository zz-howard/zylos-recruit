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
    interviewed: '已完成',
    passed: '可推进',
    rejected: '人才库',
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

      // Decide active company
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
    // Reset filter if the previously filtered role is no longer present
    if (cur && !state.roles.some(function (r) { return String(r.id) === cur; })) {
      state.filterRoleId = '';
      cur = '';
      document.getElementById('role-label').textContent = 'All roles';
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
    node.querySelector('.card-brief').textContent = c.brief || '';
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
      + '<div class="field"><button class="btn btn-primary" id="btn-save-cand">Save changes</button> '
      +   '<button class="btn btn-danger" id="btn-delete-cand">Delete</button></div>'
      + '<h3 style="margin-top:20px">Add evaluation</h3>'
      + '<div class="field"><label>Stage (number)</label>'
      +   '<input type="number" id="eval-stage" min="1" value="1"></div>'
      + '<div class="field"><label>Author</label>'
      +   '<input type="text" id="eval-author" placeholder="Howard"></div>'
      + '<div class="field"><label>Verdict</label>'
      +   '<select id="eval-verdict">'
      +     '<option value="">—</option>'
      +     '<option value="strong_yes">Strong Yes</option>'
      +     '<option value="yes">Yes</option>'
      +     '<option value="lean_yes">Lean Yes</option>'
      +     '<option value="lean_no">Lean No</option>'
      +     '<option value="no">No</option>'
      +   '</select></div>'
      + '<div class="field"><label>Notes</label>'
      +   '<textarea id="eval-content" placeholder="Interview feedback..."></textarea></div>'
      + '<button class="btn btn-primary" id="btn-add-eval">Add evaluation</button>'
      + '<div class="evals"><h3>History</h3>'
      +   (c.evaluations.length === 0 ? '<div class="meta">No evaluations yet.</div>' :
          c.evaluations.map(function (e) {
            return '<div class="eval"><div class="eval-head">'
              + '<span>' + escapeHtml(e.author || 'anon')
              + (e.verdict ? ' · ' + escapeHtml(e.verdict) : '')
              + '</span><span>' + escapeHtml(e.created_at) + '</span></div>'
              + '<div class="eval-body">' + escapeHtml(e.content || '') + '</div></div>';
          }).join(''))
      + '</div>';

    var right = document.createElement('div');
    var resumePane = document.createElement('div');
    resumePane.className = 'resume-pane';
    resumePane.innerHTML = '<div class="resume-head">'
      + '<span>Resume</span>'
      + '<span><label class="btn" style="cursor:pointer">Upload'
      +   '<input type="file" id="resume-file" accept="application/pdf" style="display:none"></label></span>'
      + '</div>'
      + (c.resume_path
          ? '<iframe src="' + API + '/candidates/' + c.id + '/resume#toolbar=0"></iframe>'
          : '<div class="no-resume">No resume uploaded</div>');
    right.appendChild(resumePane);

    wrap.appendChild(left);
    wrap.appendChild(right);
    openModal(wrap);

    // Wire handlers
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

    wrap.querySelector('#btn-save-cand').addEventListener('click', function () {
      var updates = {};
      wrap.querySelectorAll('[data-k]').forEach(function (el) {
        updates[el.dataset.k] = el.value;
      });
      api('PUT', '/candidates/' + c.id, updates)
        .then(function () { toast('Saved', 'success'); return loadRolesAndCandidates(); })
        .catch(function (err) { toast(err.message, 'error'); });
    });

    wrap.querySelector('#btn-delete-cand').addEventListener('click', function () {
      if (!confirm('Delete this candidate? This cannot be undone.')) return;
      api('DELETE', '/candidates/' + c.id)
        .then(function () { toast('Deleted'); closeModal(); return loadRolesAndCandidates(); })
        .catch(function (err) { toast(err.message, 'error'); });
    });

    wrap.querySelector('#btn-add-eval').addEventListener('click', function () {
      var body = {
        stage: Number(wrap.querySelector('#eval-stage').value) || null,
        author: wrap.querySelector('#eval-author').value || null,
        verdict: wrap.querySelector('#eval-verdict').value || null,
        content: wrap.querySelector('#eval-content').value || '',
      };
      if (!body.content.trim()) { toast('content required', 'error'); return; }
      api('POST', '/candidates/' + c.id + '/evaluate', body)
        .then(function () {
          toast('Evaluation added', 'success');
          return loadRolesAndCandidates().then(function () { openCandidate(c.id); });
        })
        .catch(function (err) { toast(err.message, 'error'); });
    });

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
    var roleOptions = '<option value="">(no role)</option>' + state.roles.map(function (r) {
      return '<option value="' + r.id + '">' + escapeHtml(r.name) + '</option>';
    }).join('');
    wrap.innerHTML = ''
      + '<h2>New Candidate</h2>'
      + '<div class="field"><label>Name</label><input type="text" id="f-name"></div>'
      + '<div class="field"><label>Role</label><select id="f-role">' + roleOptions + '</select></div>'
      + '<div class="field"><label>Email</label><input type="email" id="f-email"></div>'
      + '<div class="field"><label>Phone</label><input type="text" id="f-phone"></div>'
      + '<div class="field"><label>Source</label><input type="text" id="f-source" placeholder="Referral / LinkedIn / ..."></div>'
      + '<div class="field"><label>Brief</label><textarea id="f-brief"></textarea></div>'
      + '<div class="actions">'
      +   '<button class="btn" id="f-cancel">Cancel</button>'
      +   '<button class="btn btn-primary" id="f-save">Create</button>'
      + '</div>';
    openModal(wrap);
    wrap.querySelector('#f-cancel').addEventListener('click', closeModal);
    wrap.querySelector('#f-save').addEventListener('click', function () {
      var name = wrap.querySelector('#f-name').value.trim();
      if (!name) { toast('name required', 'error'); return; }
      var payload = {
        company_id: Number(state.activeCompanyId),
        name: name,
        role_id: wrap.querySelector('#f-role').value || null,
        email: wrap.querySelector('#f-email').value,
        phone: wrap.querySelector('#f-phone').value,
        source: wrap.querySelector('#f-source').value,
        brief: wrap.querySelector('#f-brief').value,
      };
      api('POST', '/candidates', payload)
        .then(function () { toast('Candidate created', 'success'); closeModal(); return loadRolesAndCandidates(); })
        .catch(function (err) { toast(err.message, 'error'); });
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
      + '<div class="field"><label>Description (optional)</label>'
      +   '<textarea id="f-role-desc" rows="2"></textarea></div>'
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
          +     (r.description
                   ? '<div class="meta">' + escapeHtml(r.description) + '</div>'
                   : '')
          +   '</div>'
          +   '<div class="company-row-actions">'
          +     '<button class="btn btn-ghost" data-act="edit">Edit</button>'
          +     '<button class="btn btn-ghost" data-act="profile">Edit profile</button>'
          +     '<button class="btn btn-danger btn-ghost" data-act="delete">Delete</button>'
          +   '</div>'
          + '</div>';
      }).join('');

      list.querySelectorAll('.company-row').forEach(function (row) {
        var id = Number(row.dataset.id);
        row.querySelector('[data-act="edit"]').addEventListener('click', function () {
          openRoleEditor(id);
        });
        row.querySelector('[data-act="profile"]').addEventListener('click', function () {
          openRoleProfileEditor(id);
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
      var description = wrap.querySelector('#f-role-desc').value.trim();
      if (!name) { toast('name required', 'error'); return; }
      api('POST', '/roles', {
        company_id: Number(state.activeCompanyId),
        name: name,
        description: description,
      })
        .then(function () {
          toast('Role created', 'success');
          wrap.querySelector('#f-role-name').value = '';
          wrap.querySelector('#f-role-desc').value = '';
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
        + '<div class="field"><label>Description</label>'
        +   '<textarea id="f-desc" rows="3"></textarea></div>'
        + '<div class="actions">'
        +   '<button class="btn" id="f-cancel">Cancel</button>'
        +   '<button class="btn btn-primary" id="f-save">Save</button>'
        + '</div>';
      openModal(wrap);
      wrap.querySelector('#f-name').value = role.name || '';
      wrap.querySelector('#f-desc').value = role.description || '';
      wrap.querySelector('#f-cancel').addEventListener('click', openRoleManager);
      wrap.querySelector('#f-save').addEventListener('click', function () {
        var name = wrap.querySelector('#f-name').value.trim();
        var description = wrap.querySelector('#f-desc').value.trim();
        if (!name) { toast('name required', 'error'); return; }
        api('PUT', '/roles/' + roleId, { name: name, description: description })
          .then(function () {
            toast('Saved', 'success');
            return loadRolesAndCandidates().then(openRoleManager);
          })
          .catch(function (err) { toast(err.message, 'error'); });
      });
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  function openRoleProfileEditor(roleId) {
    api('GET', '/roles/' + roleId).then(function (r) {
      var role = r.role;
      var wrap = document.createElement('div');
      wrap.className = 'form-dialog';
      var currentContent = role.profile ? role.profile.content : '';
      var currentVersion = role.profile ? role.profile.version : 0;
      wrap.innerHTML = ''
        + '<h2>Role Profile — ' + escapeHtml(role.name) + '</h2>'
        + '<div class="meta">Markdown JD / 岗位画像. Each save creates a new version. Current version: ' + currentVersion + '</div>'
        + '<div class="field"><textarea id="f-profile" rows="20" placeholder="## 岗位职责\\n\\n## 任职要求\\n\\n## 加分项"></textarea></div>'
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
          .then(function () { toast('Profile saved', 'success'); openRoleManager(); })
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
        row.querySelector('[data-act="delete"]').addEventListener('click', function () {
          if (!confirm('Delete this company? All its roles and candidates will be deleted too. This cannot be undone.')) return;
          api('DELETE', '/companies/' + id)
            .then(function () {
              toast('Deleted', 'success');
              // If the active company was deleted, clear storage
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
          // Auto-switch to the new company if none was active
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

  // ─── Top bar wiring ──────────────────────────────────────────

  document.getElementById('company-switcher').addEventListener('change', function (e) {
    state.activeCompanyId = e.target.value;
    state.filterRoleId = '';
    saveActiveCompanyToStorage(state.activeCompanyId);
    document.getElementById('role-label').textContent = 'All roles';
    loadRolesAndCandidates();
  });

  document.getElementById('btn-manage-companies').addEventListener('click', openCompanyManager);
  document.getElementById('btn-manage-roles').addEventListener('click', openRoleManager);
  document.getElementById('btn-new-role').addEventListener('click', openNewRoleForm);
  document.getElementById('btn-new-candidate').addEventListener('click', openNewCandidateForm);
  document.getElementById('role-filter').addEventListener('change', function (e) {
    state.filterRoleId = e.target.value;
    var r = state.roles.find(function (x) { return String(x.id) === state.filterRoleId; });
    document.getElementById('role-label').textContent = r ? r.name : 'All roles';
    renderBoard();
  });

  // ─── Go ──────────────────────────────────────────────────────

  loadAll().then(function () {
    // If there are no companies at all, nudge the user
    if (state.companies.length === 0) {
      toast('No companies yet — click ⚙ to create one', 'info');
    }
  });
})();
