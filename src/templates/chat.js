// Chat page template for internal interview chatbot.

const ASSET_VERSION = Date.now();

export function chatPageHtml(baseUrl, token) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>需求访谈 — Zylos Recruit</title>
<link rel="stylesheet" href="${baseUrl}/_assets/style.css?v=${ASSET_VERSION}">
<style>
  html, body { height: 100%; overflow: hidden; }
  .chat-app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg);
  }
  .chat-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 20px;
    height: 56px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-alt);
    backdrop-filter: blur(12px);
    box-shadow: var(--shadow-sm);
    flex-shrink: 0;
  }
  .chat-header-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .chat-header-left strong {
    font-size: 15px;
    font-weight: 700;
    background: linear-gradient(135deg, var(--primary), var(--accent));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .chat-header .interviewee-name {
    font-size: 14px;
    color: var(--text);
    font-weight: 500;
  }
  .chat-body {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
    padding: 16px;
  }
  /* Deep Chat customization */
  deep-chat {
    width: 100%;
    max-width: 800px;
    height: 100%;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    font-family: inherit;
  }
  .chat-ended {
    text-align: center;
    padding: 40px 20px;
  }
  .chat-ended h2 {
    font-size: 1.4em;
    margin-bottom: 12px;
    color: var(--text);
  }
  .chat-ended p {
    color: var(--text-muted);
    font-size: 14px;
    margin-bottom: 20px;
  }
  .chat-ended .summary {
    text-align: left;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    max-width: 700px;
    margin: 0 auto;
    white-space: pre-wrap;
    font-size: 14px;
    line-height: 1.7;
    max-height: 60vh;
    overflow-y: auto;
  }
  .chat-loading {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-muted);
    font-size: 14px;
  }
  .chat-error {
    text-align: center;
    padding: 60px 20px;
    color: var(--danger);
    font-size: 14px;
  }
  /* End interview confirmation */
  .end-confirm {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 100;
    align-items: center;
    justify-content: center;
  }
  .end-confirm.visible { display: flex; }
  .end-confirm-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(4px);
  }
  .end-confirm-dialog {
    position: relative;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 28px;
    max-width: 400px;
    width: 90%;
    box-shadow: var(--shadow-lg);
    text-align: center;
    animation: slideUp 0.3s ease-out;
  }
  .end-confirm-dialog h3 { margin: 0 0 12px; font-size: 16px; }
  .end-confirm-dialog p { color: var(--text-muted); font-size: 13px; margin-bottom: 20px; }
  .end-confirm-actions { display: flex; gap: 10px; justify-content: center; }
</style>
</head>
<body>
  <div class="chat-app" id="chat-app">
    <header class="chat-header">
      <div class="chat-header-left">
        <strong>需求访谈</strong>
        <span class="sep">·</span>
        <span class="interviewee-name" id="interviewee-name">—</span>
      </div>
      <div>
        <button class="btn btn-danger" id="btn-end" style="display:none">结束访谈</button>
      </div>
    </header>
    <div class="chat-body" id="chat-body">
      <div class="chat-loading" id="chat-loading">正在加载访谈...</div>
    </div>
  </div>

  <div class="end-confirm" id="end-confirm">
    <div class="end-confirm-backdrop" id="end-confirm-backdrop"></div>
    <div class="end-confirm-dialog">
      <h3>确认结束访谈？</h3>
      <p>结束后将自动生成访谈汇总，此链接将不可再使用。</p>
      <div class="end-confirm-actions">
        <button class="btn" id="btn-end-cancel">取消</button>
        <button class="btn btn-danger" id="btn-end-confirm">确认结束</button>
      </div>
    </div>
  </div>

  <script src="${baseUrl}/_assets/deepChat.bundle.js"></script>
  <script>
  (function() {
    const TOKEN = ${JSON.stringify(token)};
    const BASE_URL = ${JSON.stringify(baseUrl)};
    const API_BASE = BASE_URL + '/api/chat/' + TOKEN;

    const app = document.getElementById('chat-app');
    const body = document.getElementById('chat-body');
    const loading = document.getElementById('chat-loading');
    const nameEl = document.getElementById('interviewee-name');
    const btnEnd = document.getElementById('btn-end');
    const endConfirm = document.getElementById('end-confirm');

    // Load interview data
    fetch(API_BASE)
      .then(r => r.json())
      .then(data => {
        loading.style.display = 'none';

        if (data.error) {
          body.innerHTML = '<div class="chat-error">' + escapeHtml(data.error) + '</div>';
          return;
        }

        nameEl.textContent = data.interview.interviewee_name;
        document.title = data.interview.interviewee_name + ' — 需求访谈';

        if (data.interview.status === 'completed') {
          showCompleted(data.interview);
          return;
        }

        // Initialize Deep Chat
        btnEnd.style.display = '';
        initChat(data.messages);
      })
      .catch(err => {
        loading.style.display = 'none';
        body.innerHTML = '<div class="chat-error">加载失败: ' + escapeHtml(err.message) + '</div>';
      });

    function initChat(existingMessages) {
      const chat = document.createElement('deep-chat');

      // Style configuration
      chat.style = JSON.stringify({
        chatbox: {
          container: {
            default: {
              backgroundColor: 'var(--bg)',
            }
          }
        }
      });

      chat.messageStyles = JSON.stringify({
        default: {
          shared: {
            bubble: {
              backgroundColor: 'var(--bg-card)',
              color: 'var(--text)',
              borderRadius: '12px',
              padding: '12px 16px',
              fontSize: '14px',
              lineHeight: '1.7',
              maxWidth: '80%',
              border: '1px solid var(--border)',
            }
          },
          user: {
            bubble: {
              backgroundColor: 'var(--primary)',
              color: '#fff',
              border: 'none',
            }
          },
          ai: {
            bubble: {
              backgroundColor: 'var(--bg-card)',
            }
          }
        },
        loading: {
          bubble: {
            backgroundColor: 'var(--bg-card)',
            color: 'var(--text-muted)',
            border: '1px solid var(--border)',
          }
        }
      });

      chat.textInput = JSON.stringify({
        placeholder: { text: '输入你的回答...' },
        styles: {
          container: {
            backgroundColor: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: '10px',
            color: 'var(--text)',
          },
          focus: {
            borderColor: 'var(--primary)',
            boxShadow: '0 0 0 3px var(--primary-glow)',
          }
        }
      });

      chat.submitButtonStyles = JSON.stringify({
        submit: {
          container: {
            default: { backgroundColor: 'var(--primary)', borderRadius: '8px' },
            hover: { backgroundColor: 'var(--primary-hover)' },
          },
          svg: { styles: { default: { filter: 'brightness(0) invert(1)' } } },
        },
        loading: {
          container: { default: { backgroundColor: 'var(--bg-hover)' } },
        }
      });

      chat.auxiliaryStyle = '::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }';

      // API connection
      chat.connect = JSON.stringify({
        url: API_BASE,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      chat.requestInterceptor = (details) => {
        // Only send the latest user message text
        const lastMsg = details.body.messages?.[details.body.messages.length - 1];
        details.body = { text: lastMsg?.text || '' };
        return details;
      };

      chat.responseInterceptor = (response) => {
        return response;
      };

      // Load existing messages
      if (existingMessages && existingMessages.length > 0) {
        chat.history = JSON.stringify(
          existingMessages.map(m => ({
            role: m.role === 'user' ? 'user' : 'ai',
            text: m.text,
          }))
        );
      }

      // Auto-trigger first AI message if no history
      if (!existingMessages || existingMessages.length === 0) {
        chat.introMessage = JSON.stringify({
          text: '正在初始化访谈...',
        });
        // Send an empty greeting to trigger the AI's opening message
        setTimeout(() => {
          fetch(API_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '你好，请开始访谈。' }),
          })
          .then(r => r.json())
          .then(data => {
            if (data.text) {
              // Clear intro and add the real messages
              chat.clearMessages();
              chat.history = JSON.stringify([
                { role: 'user', text: '你好，请开始访谈。' },
                { role: 'ai', text: data.text },
              ]);
            }
          })
          .catch(err => console.error('Init message error:', err));
        }, 500);
      }

      body.appendChild(chat);
    }

    function showCompleted(interview) {
      btnEnd.style.display = 'none';
      let html = '<div class="chat-ended"><h2>访谈已结束</h2>';
      if (interview.summary) {
        html += '<p>感谢参与！以下是访谈汇总：</p>';
        html += '<div class="summary">' + escapeHtml(interview.summary) + '</div>';
      } else {
        html += '<p>感谢参与访谈。</p>';
      }
      html += '</div>';
      body.innerHTML = html;
    }

    // End interview flow
    btnEnd.addEventListener('click', () => {
      endConfirm.classList.add('visible');
    });
    document.getElementById('end-confirm-cancel').addEventListener('click', () => {
      endConfirm.classList.remove('visible');
    });
    document.getElementById('end-confirm-backdrop').addEventListener('click', () => {
      endConfirm.classList.remove('visible');
    });
    document.getElementById('btn-end-confirm').addEventListener('click', () => {
      endConfirm.classList.remove('visible');
      btnEnd.disabled = true;
      btnEnd.textContent = '正在生成汇总...';

      fetch(API_BASE + '/end', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
          if (data.interview) {
            showCompleted(data.interview);
            // Remove the deep-chat element
            const chatEl = body.querySelector('deep-chat');
            if (chatEl) chatEl.remove();
          }
        })
        .catch(err => {
          btnEnd.disabled = false;
          btnEnd.textContent = '结束访谈';
          alert('结束失败: ' + err.message);
        });
    });

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  })();
  </script>
</body>
</html>`;
}
