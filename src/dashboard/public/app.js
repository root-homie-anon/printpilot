/* ── PrintPilot Dashboard Client ──────────────────────────────────── */

'use strict';

const API_BASE = '';
const REFRESH_INTERVAL_MS = 30000;

// ── State ────────────────────────────────────────────────────────────

let currentView = 'dashboard';
let refreshTimer = null;

// ── API Helpers ──────────────────────────────────────────────────────

function getAuthHeaders() {
  const token = localStorage.getItem('dashboard_token');
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  return headers;
}

async function apiFetch(endpoint) {
  try {
    const response = await fetch(API_BASE + endpoint, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      throw new Error('API error: ' + response.status);
    }
    return await response.json();
  } catch (err) {
    console.error('Failed to fetch ' + endpoint + ':', err);
    return null;
  }
}

async function apiPost(endpoint, body) {
  try {
    const response = await fetch(API_BASE + endpoint, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error('API error: ' + response.status);
    }
    return await response.json();
  } catch (err) {
    console.error('Failed to post ' + endpoint + ':', err);
    return null;
  }
}

// ── Rendering Helpers ────────────────────────────────────────────────

function escapeHtml(text) {
  if (!text) return '';
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

function formatCurrency(amount) {
  return '$' + (amount || 0).toFixed(2);
}

function formatPercent(value) {
  return ((value || 0) * 100).toFixed(1) + '%';
}

function formatDate(dateStr) {
  if (!dateStr) return '--';
  var d = new Date(dateStr);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function badgeHtml(status) {
  var cls = 'badge badge-' + (status || 'pending').toLowerCase().replace(/\s+/g, '-');
  return '<span class="' + cls + '">' + escapeHtml(status || 'pending') + '</span>';
}

function showToast(message, type) {
  var container = document.getElementById('toast-container');
  var toast = document.createElement('div');
  toast.className = 'toast toast-' + (type || 'success');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function () {
    toast.remove();
  }, 4000);
}

// ── Data Loading & Rendering ─────────────────────────────────────────

async function loadDashboard() {
  var results = await Promise.all([
    apiFetch('/api/metrics'),
    apiFetch('/api/pipeline'),
    apiFetch('/api/products'),
    apiFetch('/api/niches'),
  ]);

  var metricsData = results[0];
  var pipelineData = results[1];
  var productsData = results[2];
  var nichesData = results[3];

  // Metrics
  if (metricsData && metricsData.metrics) {
    var m = metricsData.metrics;
    document.getElementById('metric-products').textContent = m.totalProducts;
    document.getElementById('metric-listings').textContent = m.liveListings;
    document.getElementById('metric-revenue').textContent = formatCurrency(m.totalRevenue);
    document.getElementById('metric-views').textContent = m.totalViews.toLocaleString();
    document.getElementById('metric-conversion').textContent = formatPercent(m.avgConversionRate);
  }

  // Pipeline
  if (pipelineData && pipelineData.pipeline) {
    var p = pipelineData.pipeline;
    document.getElementById('stage-research').textContent = p.research || 0;
    document.getElementById('stage-strategy').textContent = p.strategy || 0;
    document.getElementById('stage-design').textContent = p.design || 0;
    document.getElementById('stage-copy').textContent = p.copy || 0;
    document.getElementById('stage-scoring').textContent = p.scoring || 0;
    document.getElementById('stage-approval').textContent = p.approval || 0;
    document.getElementById('stage-listed').textContent = p.listed || 0;
  }

  // Recent products
  if (productsData && productsData.products) {
    renderRecentProducts(productsData.products);
  }

  // Compact niches
  if (nichesData && nichesData.niches) {
    renderNichesCompact(nichesData.niches.slice(0, 5));
  }
}

function renderRecentProducts(products) {
  var tbody = document.getElementById('recent-products');
  if (!products.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><p>No products yet.</p></td></tr>';
    return;
  }

  var rows = products.slice(0, 10).map(function (p) {
    var title = (p.brief && p.brief.title) ? escapeHtml(p.brief.title) : escapeHtml(p.id);
    var niche = (p.brief && p.brief.niche) ? escapeHtml(p.brief.niche) : '--';
    var status = p.approval ? p.approval.status : 'pending';
    var score = (p.score && p.score.overallScore != null) ? p.score.overallScore.toFixed(1) : '--';
    return '<tr>' +
      '<td>' + title + '</td>' +
      '<td>' + niche + '</td>' +
      '<td>' + badgeHtml(status) + '</td>' +
      '<td>' + score + '</td>' +
      '<td>' + badgeHtml(p.stage) + '</td>' +
      '</tr>';
  }).join('');

  tbody.innerHTML = rows;
}

function renderNichesCompact(niches) {
  var tbody = document.getElementById('niches-compact');
  if (!niches.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state"><p>No niche data.</p></td></tr>';
    return;
  }

  var rows = niches.map(function (n) {
    return '<tr>' +
      '<td>' + escapeHtml(n.niche) + '</td>' +
      '<td>' + n.productCount + '</td>' +
      '<td>' + formatCurrency(n.totalRevenue) + '</td>' +
      '</tr>';
  }).join('');

  tbody.innerHTML = rows;
}

// ── Products View ────────────────────────────────────────────────────

async function loadProducts() {
  var data = await apiFetch('/api/products');
  if (!data || !data.products) return;

  var tbody = document.getElementById('all-products');
  if (!data.products.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><p>No products found.</p></td></tr>';
    return;
  }

  var rows = data.products.map(function (p) {
    var title = (p.brief && p.brief.title) ? escapeHtml(p.brief.title) : '--';
    var niche = (p.brief && p.brief.niche) ? escapeHtml(p.brief.niche) : '--';
    var type = (p.brief && p.brief.productType) ? escapeHtml(p.brief.productType) : '--';
    var status = p.approval ? p.approval.status : 'pending';
    var score = (p.score && p.score.overallScore != null) ? p.score.overallScore.toFixed(1) : '--';
    return '<tr>' +
      '<td><code>' + escapeHtml(p.id) + '</code></td>' +
      '<td>' + title + '</td>' +
      '<td>' + niche + '</td>' +
      '<td>' + type + '</td>' +
      '<td>' + badgeHtml(status) + '</td>' +
      '<td>' + score + '</td>' +
      '<td>' + badgeHtml(p.stage) + '</td>' +
      '</tr>';
  }).join('');

  tbody.innerHTML = rows;
}

// ── Approvals View ───────────────────────────────────────────────────

async function loadApprovals() {
  var data = await apiFetch('/api/products');
  if (!data || !data.products) return;

  var pending = data.products.filter(function (p) {
    return p.stage === 'approval' || (p.approval && p.approval.status === 'pending');
  });

  var container = document.getElementById('pending-approvals');
  var emptyEl = document.getElementById('no-approvals');

  if (!pending.length) {
    container.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }

  emptyEl.style.display = 'none';

  var html = pending.map(function (p) {
    var title = (p.brief && p.brief.title) ? escapeHtml(p.brief.title) : escapeHtml(p.id);
    var niche = (p.brief && p.brief.niche) ? escapeHtml(p.brief.niche) : '--';

    var scoreHtml = '';
    if (p.score) {
      scoreHtml = '<div class="score-summary">' +
        '<div class="score-item"><span class="score-value">' + (p.score.marketScore || 0).toFixed(1) + '</span><span class="score-label">Market</span></div>' +
        '<div class="score-item"><span class="score-value">' + (p.score.designScore || 0).toFixed(1) + '</span><span class="score-label">Design</span></div>' +
        '<div class="score-item"><span class="score-value">' + (p.score.copyScore || 0).toFixed(1) + '</span><span class="score-label">Copy</span></div>' +
        '<div class="score-item"><span class="score-value">' + (p.score.overallScore || 0).toFixed(1) + '</span><span class="score-label">Overall</span></div>' +
        '</div>';
    }

    return '<div class="card approval-card" style="margin-bottom: 16px;">' +
      '<div class="card-header"><span class="card-title">Pending Approval: ' + title + '</span><span>' + niche + '</span></div>' +
      scoreHtml +
      (p.score ? '<p style="margin-bottom: 12px;">Recommendation: <strong>' + escapeHtml(p.score.recommendation) + '</strong></p>' : '') +
      '<div class="btn-group">' +
      '<button class="btn btn-success btn-sm" onclick="submitApproval(\'' + p.id + '\', \'approve\')">Approve</button>' +
      '<button class="btn btn-outline btn-sm" onclick="submitApproval(\'' + p.id + '\', \'revise\')">Request Revision</button>' +
      '<button class="btn btn-danger btn-sm" onclick="submitApproval(\'' + p.id + '\', \'reject\')">Reject</button>' +
      '</div>' +
      '<hr style="margin: 16px 0; border: none; border-top: 1px solid var(--color-border);">' +
      '<h4 style="margin-bottom: 8px; font-size: 0.875rem;">Quick Feedback</h4>' +
      buildFeedbackForm(p.id) +
      '</div>';
  }).join('');

  container.innerHTML = html;
}

function buildFeedbackForm(productId) {
  var fields = [
    { key: 'layoutQuality', label: 'Layout Quality' },
    { key: 'typography', label: 'Typography' },
    { key: 'colorAestheticMatch', label: 'Color/Aesthetic' },
    { key: 'differentiation', label: 'Differentiation' },
    { key: 'overallSellability', label: 'Sellability' },
  ];

  var html = '<form id="feedback-form-' + productId + '" onsubmit="submitFeedback(event, \'' + productId + '\')">';

  fields.forEach(function (f) {
    html += '<div class="form-group">' +
      '<label class="form-label">' + f.label + '</label>' +
      '<div class="rating-input">';
    for (var i = 1; i <= 5; i++) {
      html += '<label style="display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border:1px solid var(--color-border);border-radius:4px;cursor:pointer;">' +
        '<input type="radio" name="' + f.key + '" value="' + i + '" style="display:none;">' +
        '<span style="padding:4px 8px;" onclick="this.parentElement.style.background=\'var(--color-primary)\';this.parentElement.style.color=\'#fff\'">' + i + '</span>' +
        '</label>';
    }
    html += '</div></div>';
  });

  html += '<div class="form-group">' +
    '<label class="form-label">Problem Source</label>' +
    '<select name="problemSource" class="form-select" required>' +
    '<option value="">Select...</option>' +
    '<option value="design">Design</option>' +
    '<option value="spec">Spec</option>' +
    '<option value="research">Research</option>' +
    '</select></div>';

  html += '<div class="form-group">' +
    '<label class="form-label">Specific Issues</label>' +
    '<textarea name="specificIssues" class="form-textarea" placeholder="Optional notes..."></textarea>' +
    '</div>';

  html += '<button type="submit" class="btn btn-primary btn-sm">Submit Feedback</button>';
  html += '</form>';

  return html;
}

async function submitApproval(productId, decision) {
  var result = await apiPost('/api/approve/' + productId, { decision: decision });
  if (result && result.success) {
    showToast('Product ' + decision + 'd successfully', 'success');
    await loadApprovals();
    await loadDashboard();
  } else {
    showToast('Failed to submit approval', 'error');
  }
}

async function submitFeedback(event, productId) {
  event.preventDefault();

  var form = document.getElementById('feedback-form-' + productId);
  var formData = new FormData(form);

  var body = {
    layoutQuality: parseInt(formData.get('layoutQuality'), 10),
    typography: parseInt(formData.get('typography'), 10),
    colorAestheticMatch: parseInt(formData.get('colorAestheticMatch'), 10),
    differentiation: parseInt(formData.get('differentiation'), 10),
    overallSellability: parseInt(formData.get('overallSellability'), 10),
    problemSource: formData.get('problemSource'),
    specificIssues: formData.get('specificIssues') || '',
  };

  // Validate
  if (!body.layoutQuality || !body.typography || !body.colorAestheticMatch ||
      !body.differentiation || !body.overallSellability) {
    showToast('Please fill in all rating fields', 'error');
    return;
  }

  if (!body.problemSource) {
    showToast('Please select a problem source', 'error');
    return;
  }

  var result = await apiPost('/api/feedback/' + productId, body);
  if (result && result.success) {
    showToast('Feedback submitted', 'success');
  } else {
    showToast('Failed to submit feedback', 'error');
  }
}

// ── Niches View ──────────────────────────────────────────────────────

async function loadNiches() {
  var data = await apiFetch('/api/niches');
  if (!data || !data.niches) return;

  var tbody = document.getElementById('niches-full');
  if (!data.niches.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><p>No niche data available.</p></td></tr>';
    return;
  }

  var rows = data.niches.map(function (n, idx) {
    return '<tr>' +
      '<td>' + (idx + 1) + '</td>' +
      '<td>' + escapeHtml(n.niche) + '</td>' +
      '<td>' + n.productCount + '</td>' +
      '<td>' + formatCurrency(n.totalRevenue) + '</td>' +
      '<td>' + n.avgScore.toFixed(2) + '</td>' +
      '</tr>';
  }).join('');

  tbody.innerHTML = rows;
}

// ── Marketing View ───────────────────────────────────────────────────

async function loadMarketing() {
  var data = await apiFetch('/api/listings');
  if (!data || !data.listings) return;

  var container = document.getElementById('marketing-queue');
  var emptyEl = document.getElementById('no-marketing');

  if (!data.listings.length) {
    container.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }

  emptyEl.style.display = 'none';

  var html = data.listings.map(function (l) {
    return '<div class="marketing-item">' +
      '<span>' + escapeHtml(l.title || l.productId) + '</span>' +
      '<span>' + badgeHtml(l.status) + '</span>' +
      '<span>Listed: ' + formatDate(l.listedAt) + '</span>' +
      '</div>';
  }).join('');

  container.innerHTML = html;
}

// ── Activity View ────────────────────────────────────────────────────

async function loadActivity() {
  var data = await apiFetch('/api/activity');
  if (!data || !data.activity) return;

  var list = document.getElementById('activity-log');
  var emptyEl = document.getElementById('no-activity');

  if (!data.activity.length) {
    list.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }

  emptyEl.style.display = 'none';

  var html = data.activity.map(function (a) {
    return '<li class="activity-item">' +
      '<span class="activity-time">' + formatDate(a.timestamp) + '</span>' +
      '<span class="activity-agent">' + escapeHtml(a.agent) + '</span>' +
      '<span class="activity-action">' + escapeHtml(a.action) + (a.productId ? ' (' + escapeHtml(a.productId) + ')' : '') + '</span>' +
      '</li>';
  }).join('');

  list.innerHTML = html;
}

// ── Navigation / Routing ─────────────────────────────────────────────

function switchView(viewName) {
  currentView = viewName;

  // Update nav links
  document.querySelectorAll('.nav-links a').forEach(function (a) {
    a.classList.toggle('active', a.getAttribute('data-view') === viewName);
  });

  // Show/hide views
  document.querySelectorAll('.view-section').forEach(function (section) {
    section.classList.toggle('active', section.id === 'view-' + viewName);
  });

  // Load data for the view
  loadViewData(viewName);
}

async function loadViewData(viewName) {
  switch (viewName) {
    case 'dashboard':
      await loadDashboard();
      break;
    case 'products':
      await loadProducts();
      break;
    case 'approvals':
      await loadApprovals();
      break;
    case 'niches':
      await loadNiches();
      break;
    case 'marketing':
      await loadMarketing();
      break;
    case 'activity':
      await loadActivity();
      break;
  }
}

function handleHashChange() {
  var hash = window.location.hash.replace('#', '') || 'dashboard';
  switchView(hash);
}

// ── Theme Toggle ─────────────────────────────────────────────────────

function initTheme() {
  var saved = localStorage.getItem('theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeButton(saved);
  }
}

function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme');
  var next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeButton(next);
}

function updateThemeButton(theme) {
  var btn = document.getElementById('theme-toggle');
  btn.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
}

// ── Auto-refresh ─────────────────────────────────────────────────────

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(function () {
    loadViewData(currentView);
  }, REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ── Initialization ───────────────────────────────────────────────────

function init() {
  initTheme();

  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Navigation
  document.querySelectorAll('.nav-links a').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      var view = a.getAttribute('data-view');
      window.location.hash = view;
    });
  });

  window.addEventListener('hashchange', handleHashChange);

  // Initial load
  handleHashChange();
  startAutoRefresh();
}

// Make functions available globally for inline onclick handlers
window.submitApproval = submitApproval;
window.submitFeedback = submitFeedback;

document.addEventListener('DOMContentLoaded', init);
