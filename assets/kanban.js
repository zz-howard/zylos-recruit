/* zylos-recruit · Kanban board frontend
 * No external dependencies. All logic driven by window.fetch.
 */
(function () {
  'use strict';

  var board = document.getElementById('board');
  var BASE = board.dataset.baseUrl || '';
  var API = BASE + '/api';

  var STATE_LABELS = {
    pending: '待处理',
    scheduled: '已预约',
    interviewed: '已完成',
    passed: '可推进',
    rejected: '人才库',
  };

  var state = {
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

  // ─── Data loading ─────────────────────────────────────────────

  function loadAll() {
    return Promise.all([
      api('GET', '/roles'),
      api('GET', '/candidates'),
    ]).then(function (results) {
      state.roles = results[0].roles;
      state.candidates = results[1].candidates;
      renderRoleFilter();
      renderBoard();
    }).catch(function (err) { toast(err.message, 'error'); });
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

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
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
            return loadAll().then(function () { openCandidate(c.id); });
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
        .then(function () { toast('Saved', 'success'); return loadAll(); })
        .catch(function (err) { toast(err.message, 'error'); });
    });

    wrap.querySelector('#btn-delete-cand').addEventListener('click', function () {
      if (!confirm('Delete this candidate? This cannot be undone.')) return;
      api('DELETE', '/candidates/' + c.id)
        .then(function () { toast('Deleted'); closeModal(); return loadAll(); })
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
          return loadAll().then(function () { openCandidate(c.id); });
        })
        .catch(function (err) { toast(err.message, 'error'); });
    });

    var fileInput = wrap.querySelector('#resume-file');
    fileInput.addEventListener('change', function () {
      if (!fileInput.files[0]) return;
      upload('/candidates/' + c.id + '/resume', fileInput.files[0])
        .then(function () {
          toast('Resume uploaded', 'success');
          return loadAll().then(function () { openCandidate(c.id); });
        })
        .catch(function (err) { toast(err.message, 'error'); });
    });
  }

  // ─── New role / candidate forms ───────────────────────────────

  function openNewRoleForm() {
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
      api('POST', '/roles', { name: name, description: description })
        .then(function () { toast('Role created', 'success'); closeModal(); return loadAll(); })
        .catch(function (err) { toast(err.message, 'error'); });
    });
  }

  function openNewCandidateForm() {
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
        name: name,
        role_id: wrap.querySelector('#f-role').value || null,
        email: wrap.querySelector('#f-email').value,
        phone: wrap.querySelector('#f-phone').value,
        source: wrap.querySelector('#f-source').value,
        brief: wrap.querySelector('#f-brief').value,
      };
      api('POST', '/candidates', payload)
        .then(function () { toast('Candidate created', 'success'); closeModal(); return loadAll(); })
        .catch(function (err) { toast(err.message, 'error'); });
    });
  }

  // ─── Top bar wiring ──────────────────────────────────────────

  document.getElementById('btn-new-role').addEventListener('click', openNewRoleForm);
  document.getElementById('btn-new-candidate').addEventListener('click', openNewCandidateForm);
  document.getElementById('role-filter').addEventListener('change', function (e) {
    state.filterRoleId = e.target.value;
    var r = state.roles.find(function (x) { return String(x.id) === state.filterRoleId; });
    document.getElementById('role-label').textContent = r ? r.name : 'All roles';
    renderBoard();
  });

  // ─── Go ──────────────────────────────────────────────────────

  loadAll();
})();
