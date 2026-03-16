/* ── PrintPilot Dashboard Client ──────────────────────────────────── */

'use strict';

var API_BASE = '';
var REFRESH_INTERVAL_MS = 30000;

// ── State ────────────────────────────────────────────────────────────

var currentView = 'dashboard';
var refreshTimer = null;
var qualityHistory = [];

// ── API Helpers ──────────────────────────────────────────────────────

function getAuthHeaders() {
  var token = localStorage.getItem('dashboard_token');
  var headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  return headers;
}

async function apiFetch(endpoint) {
  try {
    var response = await fetch(API_BASE + endpoint, {
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
    var response = await fetch(API_BASE + endpoint, {
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
  div.appendChild(document.createTextNode(String(text)));
  return div.innerHTML;
}

function formatCurrency(amount) {
  return '$' + (amount || 0).toFixed(2);
}

function formatPercent(value) {
  return ((value || 0) * 100).toFixed(1) + '%';
}

function formatNumber(num) {
  return (num || 0).toLocaleString();
}

function formatDate(dateStr) {
  if (!dateStr) return '--';
  var d = new Date(dateStr);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateShort(dateStr) {
  if (!dateStr) return '--';
  var d = new Date(dateStr);
  return d.toLocaleDateString();
}

function badgeHtml(status) {
  if (!status) status = 'pending';
  var cls = 'badge badge-' + status.toLowerCase().replace(/\s+/g, '-');
  return '<span class="' + cls + '">' + escapeHtml(status) + '</span>';
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

function scoreColor(score) {
  if (score >= 80) return 'var(--color-success)';
  if (score >= 60) return 'var(--color-info)';
  if (score >= 40) return 'var(--color-warning)';
  return 'var(--color-danger)';
}

function ratingStars(value) {
  var html = '';
  for (var i = 1; i <= 5; i++) {
    html += '<span style="color:' + (i <= value ? 'var(--color-warning)' : 'var(--color-border)') + ';font-size:1rem;">&#9733;</span>';
  }
  return html;
}

// ── Helper: extract product display data from API shape ──────────────

function getProductTitle(p) {
  if (p.product && p.product.title) return p.product.title;
  if (p.brief && p.brief.niche) {
    return p.brief.niche.split('-').map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }
  return p.id.slice(0, 8);
}

function getProductNiche(p) {
  if (p.product && p.product.niche) return p.product.niche;
  if (p.brief && p.brief.niche) return p.brief.niche;
  return '--';
}

function getProductStatus(p) {
  if (p.product && p.product.status) return p.product.status;
  return 'pending';
}

function getOverallScore(p) {
  if (p.scores) {
    var s = p.scores;
    return ((s.layout + s.typography + s.color + s.differentiation + s.sellability) / 5).toFixed(1);
  }
  return '--';
}

// ── Dashboard View ──────────────────────────────────────────────────

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
    document.getElementById('metric-products').textContent = formatNumber(m.totalProducts);
    document.getElementById('metric-listings').textContent = formatNumber(m.liveListings);
    document.getElementById('metric-revenue').textContent = formatCurrency(m.totalRevenue);
    document.getElementById('metric-views').textContent = formatNumber(m.totalViews);
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
    updateQualityChart(productsData.products);
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

  var sorted = products.slice().sort(function (a, b) {
    var dateA = (a.product && a.product.createdAt) || '';
    var dateB = (b.product && b.product.createdAt) || '';
    return dateB.localeCompare(dateA);
  });

  var rows = sorted.slice(0, 10).map(function (p) {
    var title = getProductTitle(p);
    var niche = getProductNiche(p);
    var status = getProductStatus(p);
    var score = getOverallScore(p);

    return '<tr>' +
      '<td>' + escapeHtml(title) + '</td>' +
      '<td>' + escapeHtml(niche) + '</td>' +
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

// ── Quality Trend Chart (Canvas) ─────────────────────────────────────

function updateQualityChart(products) {
  var canvas = document.getElementById('quality-chart');
  if (!canvas) return;

  var scored = products.filter(function (p) { return p.scores; });
  if (scored.length < 2) {
    var container = canvas.parentElement;
    container.innerHTML = '<span>Not enough data for trend chart (need 2+ scored products)</span>';
    return;
  }

  // Sort by creation date
  scored.sort(function (a, b) {
    var da = (a.product && a.product.createdAt) || '';
    var db = (b.product && b.product.createdAt) || '';
    return da.localeCompare(db);
  });

  // Extract scores
  var labels = [];
  var avgScores = [];
  scored.forEach(function (p) {
    var s = p.scores;
    var avg = (s.layout + s.typography + s.color + s.differentiation + s.sellability) / 5;
    avgScores.push(avg);
    var date = (p.product && p.product.createdAt) ? formatDateShort(p.product.createdAt) : '';
    labels.push(date);
  });

  drawLineChart(canvas, labels, avgScores, 'Avg Quality Score');
}

function drawLineChart(canvas, labels, data, title) {
  var ctx = canvas.getContext('2d');
  var w = canvas.parentElement.clientWidth - 8;
  var h = 180;
  canvas.width = w * 2;
  canvas.height = h * 2;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.scale(2, 2);

  var padLeft = 40;
  var padRight = 16;
  var padTop = 24;
  var padBottom = 32;
  var chartW = w - padLeft - padRight;
  var chartH = h - padTop - padBottom;

  var maxVal = Math.max.apply(null, data.concat([100]));
  var minVal = Math.min.apply(null, data.concat([0]));
  var range = maxVal - minVal || 1;

  // Background
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  ctx.fillStyle = isDark ? '#2c2e33' : '#f1f3f5';
  ctx.fillRect(0, 0, w, h);

  // Title
  ctx.fillStyle = isDark ? '#909296' : '#6c757d';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.fillText(title, padLeft, 14);

  // Y axis labels
  ctx.textAlign = 'right';
  ctx.fillStyle = isDark ? '#909296' : '#6c757d';
  ctx.font = '9px -apple-system, sans-serif';
  for (var i = 0; i <= 4; i++) {
    var yVal = minVal + (range * i / 4);
    var yPos = padTop + chartH - (chartH * i / 4);
    ctx.fillText(Math.round(yVal).toString(), padLeft - 6, yPos + 3);
    // Grid line
    ctx.strokeStyle = isDark ? '#373a40' : '#dee2e6';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(padLeft, yPos);
    ctx.lineTo(padLeft + chartW, yPos);
    ctx.stroke();
  }

  // Draw line
  ctx.strokeStyle = '#4263eb';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();

  var stepX = data.length > 1 ? chartW / (data.length - 1) : chartW;

  data.forEach(function (val, idx) {
    var x = padLeft + idx * stepX;
    var y = padTop + chartH - ((val - minVal) / range * chartH);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Draw dots
  data.forEach(function (val, idx) {
    var x = padLeft + idx * stepX;
    var y = padTop + chartH - ((val - minVal) / range * chartH);
    ctx.fillStyle = '#4263eb';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // X axis labels
  ctx.fillStyle = isDark ? '#909296' : '#6c757d';
  ctx.font = '8px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  var labelStep = Math.max(1, Math.floor(labels.length / 6));
  labels.forEach(function (label, idx) {
    if (idx % labelStep === 0 || idx === labels.length - 1) {
      var x = padLeft + idx * stepX;
      ctx.fillText(label, x, h - 6);
    }
  });
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
    var title = getProductTitle(p);
    var niche = getProductNiche(p);
    var type = (p.brief && p.brief.sections && p.brief.sections[0]) ? 'Printable' : '--';
    var status = getProductStatus(p);
    var score = getOverallScore(p);

    return '<tr>' +
      '<td><code title="' + escapeHtml(p.id) + '">' + escapeHtml(p.id.slice(0, 8)) + '</code></td>' +
      '<td>' + escapeHtml(title) + '</td>' +
      '<td>' + escapeHtml(niche) + '</td>' +
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
    var status = getProductStatus(p);
    return p.stage === 'approval' || status === 'scored';
  });

  var container = document.getElementById('pending-approvals');
  var emptyEl = document.getElementById('no-approvals');
  var countEl = document.getElementById('approval-count');
  if (countEl) countEl.textContent = pending.length;

  if (!pending.length) {
    container.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }

  emptyEl.style.display = 'none';

  // Load full approval data for each pending product
  var detailedHtml = [];
  for (var i = 0; i < pending.length; i++) {
    var p = pending[i];
    var approvalData = await apiFetch('/api/approve/' + encodeURIComponent(p.id) + '/data');
    detailedHtml.push(buildApprovalCard(p, approvalData));
  }

  container.innerHTML = detailedHtml.join('');
}

function buildApprovalCard(p, approvalData) {
  var title = getProductTitle(p);
  var niche = getProductNiche(p);
  var ad = approvalData || {};
  var revisionCount = (ad.approval && ad.approval.revisionCount) || 0;

  // Header with revision badge
  var revisionBadge = revisionCount > 0
    ? ' <span class="badge badge-warning">Revision #' + revisionCount + '</span>'
    : '';

  var html = '<div class="card approval-card" style="margin-bottom: 20px;">';
  html += '<div class="card-header">' +
    '<span class="card-title">' + escapeHtml(title) + revisionBadge + '</span>' +
    '<span>' + badgeHtml(niche) + '</span>' +
    '</div>';

  // Brief info
  if (p.brief) {
    html += '<div style="margin:8px 0 12px;font-size:0.875rem;color:var(--color-text-muted);">' +
      '<strong>Pages:</strong> ' + (p.brief.pageCount || '--') +
      ' &middot; <strong>Audience:</strong> ' + escapeHtml(p.brief.targetAudience || '--') +
      ' &middot; <strong>Font:</strong> ' + escapeHtml((p.brief.styleGuide && p.brief.styleGuide.primaryFont) || '--') +
      ' &middot; <strong>Palette:</strong> ' + escapeHtml((p.brief.styleGuide && p.brief.styleGuide.palette) || '--') +
      '</div>';
  }

  // PDF Preview
  if (ad.hasPdf) {
    html += '<div style="margin:12px 0;">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
      '<strong style="font-size:0.875rem;">PDF Preview</strong>' +
      '<button class="btn btn-outline btn-sm" onclick="togglePdfPreview(\'' + p.id + '\')" id="pdf-toggle-' + p.id + '">Show Preview</button>' +
      '<a href="/api/products/' + encodeURIComponent(p.id) + '/pdf" target="_blank" class="btn btn-outline btn-sm">Open in New Tab</a>' +
      '</div>' +
      '<div id="pdf-preview-' + p.id + '" style="display:none;">' +
      '<iframe src="/api/products/' + encodeURIComponent(p.id) + '/pdf" ' +
      'style="width:100%;height:600px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:#fff;" ' +
      'title="PDF Preview"></iframe>' +
      '</div>' +
      '</div>';
  }

  // Copy preview (title, description, tags)
  if (ad.copy) {
    html += '<div style="margin:12px 0;padding:12px;background:var(--color-surface-alt);border-radius:var(--radius-md);font-size:0.875rem;">' +
      '<strong>Listing Title:</strong> ' + escapeHtml(ad.copy.title) + '<br>' +
      '<strong>Description:</strong> <span style="color:var(--color-text-muted);">' +
      escapeHtml((ad.copy.description || '').slice(0, 200)) +
      (ad.copy.description && ad.copy.description.length > 200 ? '...' : '') + '</span><br>' +
      '<strong>Tags:</strong> ' +
      (ad.copy.tags || []).map(function (t) {
        return '<span class="badge" style="margin:2px;font-size:0.75rem;">' + escapeHtml(t) + '</span>';
      }).join('') +
      '</div>';
  }

  // Scores
  if (p.scores) {
    var s = p.scores;
    html += '<div class="score-summary">' +
      '<div class="score-item"><span class="score-value" style="color:' + scoreColor(s.layout) + '">' + s.layout + '</span><span class="score-label">Layout</span></div>' +
      '<div class="score-item"><span class="score-value" style="color:' + scoreColor(s.typography) + '">' + s.typography + '</span><span class="score-label">Typography</span></div>' +
      '<div class="score-item"><span class="score-value" style="color:' + scoreColor(s.color) + '">' + s.color + '</span><span class="score-label">Color</span></div>' +
      '<div class="score-item"><span class="score-value" style="color:' + scoreColor(s.differentiation) + '">' + s.differentiation + '</span><span class="score-label">Differentiation</span></div>' +
      '<div class="score-item"><span class="score-value" style="color:' + scoreColor(s.sellability) + '">' + s.sellability + '</span><span class="score-label">Sellability</span></div>' +
      '</div>';
  }

  // Comparison data if available
  if (ad.comparison) {
    var c = ad.comparison;
    var alignColor = scoreColor(c.overallAlignment || 0);
    html += '<div style="margin:12px 0;padding:8px 12px;background:var(--color-surface-alt);border-radius:var(--radius-md);font-size:0.875rem;">' +
      '<strong>Reference Comparison:</strong> ' +
      '<span style="color:' + alignColor + ';font-weight:600;">' + (c.overallAlignment || '--') + '/100</span> alignment' +
      (c.readyToList ? ' &mdash; Ready to list' : ' &mdash; Needs improvement') +
      '</div>';
  }

  // Integrated feedback + decision form
  html += '<hr style="margin:16px 0;border:none;border-top:1px solid var(--color-border);">';
  html += '<h4 style="margin-bottom:8px;font-size:0.9rem;font-weight:600;">Review & Decision</h4>';
  html += buildApprovalForm(p.id);

  html += '</div>';
  return html;
}

function togglePdfPreview(productId) {
  var preview = document.getElementById('pdf-preview-' + productId);
  var toggle = document.getElementById('pdf-toggle-' + productId);
  if (!preview) return;
  var isHidden = preview.style.display === 'none';
  preview.style.display = isHidden ? 'block' : 'none';
  if (toggle) toggle.textContent = isHidden ? 'Hide Preview' : 'Show Preview';
}

function buildApprovalForm(productId) {
  var html = '<form id="approval-form-' + productId + '" onsubmit="submitApprovalWithFeedback(event, \'' + productId + '\')">';

  html += buildRatingInput('layout-' + productId, 'Layout Quality');
  html += buildRatingInput('typography-' + productId, 'Typography');
  html += buildRatingInput('color-' + productId, 'Color / Aesthetic Match');
  html += buildRatingInput('differentiation-' + productId, 'Differentiation');
  html += buildRatingInput('sellability-' + productId, 'Overall Sellability');

  html += '<div class="form-group">' +
    '<label class="form-label">Problem Source</label>' +
    '<select name="source" class="form-select">' +
    '<option value="">N/A</option>' +
    '<option value="design">Design</option>' +
    '<option value="spec">Spec</option>' +
    '<option value="research">Research</option>' +
    '</select></div>';

  html += '<div class="form-group">' +
    '<label class="form-label">Notes / Issues</label>' +
    '<textarea name="issues" class="form-textarea" placeholder="Optional feedback for revision..."></textarea>' +
    '</div>';

  html += '<div class="btn-group" style="margin-top:12px;gap:8px;">' +
    '<button type="submit" name="decision" value="approve" class="btn btn-success">Approve</button>' +
    '<button type="submit" name="decision" value="revise" class="btn btn-outline" style="border-color:var(--color-warning);color:var(--color-warning);">Revise</button>' +
    '<button type="submit" name="decision" value="reject" class="btn btn-danger">Reject</button>' +
    '</div>';

  html += '</form>';
  return html;
}

function buildRatingInput(name, label) {
  var html = '<div class="form-group">' +
    '<label class="form-label">' + label + '</label>' +
    '<div class="rating-input">';
  for (var i = 1; i <= 5; i++) {
    html += '<label>' +
      '<input type="radio" name="' + name + '" value="' + i + '">' +
      '<span>' + i + '</span>' +
      '</label>';
  }
  html += '</div></div>';
  return html;
}

function buildFeedbackForm(productId) {
  var html = '<form id="feedback-form-' + productId + '" onsubmit="submitFeedback(event, \'' + productId + '\')">';

  html += buildRatingInput('layout', 'Layout Quality');
  html += buildRatingInput('typography', 'Typography');
  html += buildRatingInput('colorAesthetic', 'Color / Aesthetic Match');
  html += buildRatingInput('differentiation', 'Differentiation');
  html += buildRatingInput('sellability', 'Overall Sellability');

  html += '<div class="form-group">' +
    '<label class="form-label">Problem Source</label>' +
    '<select name="problemSource" class="form-select" required>' +
    '<option value="">Select...</option>' +
    '<option value="design">Design</option>' +
    '<option value="spec">Spec</option>' +
    '<option value="research">Research</option>' +
    '</select></div>';

  html += '<div class="form-group">' +
    '<label class="form-label">Decision</label>' +
    '<div class="rating-input">' +
    '<label style="width:auto;padding:0 12px;"><input type="radio" name="decision" value="approve"><span>Approve</span></label>' +
    '<label style="width:auto;padding:0 12px;"><input type="radio" name="decision" value="revise"><span>Revise</span></label>' +
    '<label style="width:auto;padding:0 12px;"><input type="radio" name="decision" value="reject"><span>Reject</span></label>' +
    '</div></div>';

  html += '<div class="form-group">' +
    '<label class="form-label">Specific Issues</label>' +
    '<textarea name="issues" class="form-textarea" placeholder="Optional notes..."></textarea>' +
    '</div>';

  html += '<button type="submit" class="btn btn-primary btn-sm">Submit Feedback</button>';
  html += '</form>';

  return html;
}

async function submitApproval(productId, decision) {
  var result = await apiPost('/api/approve/' + productId, { decision: decision });
  if (result && result.success) {
    showToast('Product ' + decision + 'd — ' + (result.message || ''), 'success');
    await loadApprovals();
    await loadDashboard();
  } else {
    showToast('Failed to submit approval: ' + (result && result.error || 'unknown error'), 'error');
  }
}

async function submitApprovalWithFeedback(event, productId) {
  event.preventDefault();

  // Determine which button was clicked
  var submitter = event.submitter;
  var decision = submitter ? submitter.value : null;
  if (!decision) {
    showToast('Please click Approve, Revise, or Reject', 'error');
    return;
  }

  var form = document.getElementById('approval-form-' + productId);
  var formData = new FormData(form);

  var body = {
    decision: decision,
    layout: parseInt(formData.get('layout-' + productId), 10) || undefined,
    typography: parseInt(formData.get('typography-' + productId), 10) || undefined,
    color: parseInt(formData.get('color-' + productId), 10) || undefined,
    differentiation: parseInt(formData.get('differentiation-' + productId), 10) || undefined,
    sellability: parseInt(formData.get('sellability-' + productId), 10) || undefined,
    issues: formData.get('issues') || '',
    source: formData.get('source') || undefined,
  };

  // For revise/reject, require notes
  if ((decision === 'revise' || decision === 'reject') && !body.issues) {
    showToast('Please add notes explaining why you are ' + (decision === 'revise' ? 'requesting revision' : 'rejecting'), 'error');
    return;
  }

  // Show processing state
  var buttons = form.querySelectorAll('button[type="submit"]');
  buttons.forEach(function (btn) { btn.disabled = true; });
  showToast('Processing ' + decision + '...', 'info');

  var result = await apiPost('/api/approve/' + productId, body);

  buttons.forEach(function (btn) { btn.disabled = false; });

  if (result && result.success) {
    var msg = decision === 'revise'
      ? 'Revision started — product will reappear after re-processing'
      : 'Product ' + decision + 'd';
    if (result.message) msg += ' — ' + result.message;
    showToast(msg, 'success');
    await loadApprovals();
    await loadDashboard();
  } else {
    showToast('Failed: ' + (result && result.error || 'unknown error'), 'error');
  }
}

async function submitFeedback(event, productId) {
  event.preventDefault();

  var form = document.getElementById('feedback-form-' + productId);
  var formData = new FormData(form);

  var body = {
    layout: parseInt(formData.get('layout'), 10),
    typography: parseInt(formData.get('typography'), 10),
    color: parseInt(formData.get('colorAesthetic'), 10),
    differentiation: parseInt(formData.get('differentiation'), 10),
    sellability: parseInt(formData.get('sellability'), 10),
    issues: formData.get('issues') || '',
    source: formData.get('problemSource'),
    decision: formData.get('decision'),
  };

  if (!body.layout || !body.typography || !body.color ||
      !body.differentiation || !body.sellability) {
    showToast('Please fill in all rating fields', 'error');
    return;
  }

  if (!body.source) {
    showToast('Please select a problem source', 'error');
    return;
  }

  if (!body.decision) {
    showToast('Please select a decision', 'error');
    return;
  }

  var result = await apiPost('/api/feedback/' + productId, body);
  if (result && result.success) {
    showToast('Feedback submitted', 'success');
    await submitApproval(productId, body.decision);
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
    var barWidth = n.totalRevenue > 0 ? Math.min(100, (n.totalRevenue / Math.max.apply(null, data.niches.map(function (x) { return x.totalRevenue; }))) * 100) : 0;
    return '<tr>' +
      '<td>' + (idx + 1) + '</td>' +
      '<td><strong>' + escapeHtml(n.niche) + '</strong></td>' +
      '<td>' + n.productCount + '</td>' +
      '<td>' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
        '<div style="flex:1;height:6px;background:var(--color-surface-alt);border-radius:3px;">' +
        '<div style="width:' + barWidth + '%;height:100%;background:var(--color-primary);border-radius:3px;"></div>' +
        '</div>' +
        '<span>' + formatCurrency(n.totalRevenue) + '</span>' +
        '</div>' +
      '</td>' +
      '<td style="color:' + scoreColor(n.avgScore * 20) + '">' + n.avgScore.toFixed(1) + '/5</td>' +
      '</tr>';
  }).join('');

  tbody.innerHTML = rows;
}

// ── Marketing View ───────────────────────────────────────────────────

async function loadMarketing() {
  var results = await Promise.all([
    apiFetch('/api/listings'),
    apiFetch('/api/products'),
  ]);

  var listingsData = results[0];

  var container = document.getElementById('marketing-queue');
  var emptyEl = document.getElementById('no-marketing');

  if (!listingsData || !listingsData.listings || !listingsData.listings.length) {
    container.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }

  emptyEl.style.display = 'none';

  var html = '<div class="table-wrapper"><table>' +
    '<thead><tr>' +
    '<th>Listing</th>' +
    '<th>Status</th>' +
    '<th>Price</th>' +
    '<th>Pinterest</th>' +
    '<th>Email</th>' +
    '<th>Blog</th>' +
    '<th>Published</th>' +
    '</tr></thead><tbody>';

  html += listingsData.listings.map(function (l) {
    var pinterestBadge = '<span class="badge badge-pending">Pending</span>';
    var emailBadge = '<span class="badge badge-pending">Pending</span>';
    var blogBadge = '<span class="badge badge-pending">Pending</span>';

    return '<tr>' +
      '<td>' + escapeHtml(l.title || l.listingId) + '</td>' +
      '<td>' + badgeHtml(l.status) + '</td>' +
      '<td>' + formatCurrency(l.price) + '</td>' +
      '<td>' + pinterestBadge + '</td>' +
      '<td>' + emailBadge + '</td>' +
      '<td>' + blogBadge + '</td>' +
      '<td>' + formatDate(l.publishedAt) + '</td>' +
      '</tr>';
  }).join('');

  html += '</tbody></table></div>';

  html += '<div style="margin-top:16px;padding:12px;background:var(--color-surface-alt);border-radius:8px;font-size:0.875rem;">' +
    '<strong>Schedule:</strong> Pinterest pins go live Day+2 after listing. Email notification Day+3. SEO blog post Day+7.' +
    '</div>';

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

  // Sort by timestamp descending
  var sorted = data.activity.slice().sort(function (a, b) {
    return (b.timestamp || '').localeCompare(a.timestamp || '');
  });

  var html = sorted.map(function (a) {
    var agentColor = {
      researcher: 'var(--color-info)',
      strategist: 'var(--color-primary)',
      designer: '#9c36b5',
      copywriter: '#e67700',
      scorer: 'var(--color-warning)',
      orchestrator: 'var(--color-text-muted)',
    }[a.agent] || 'var(--color-text)';

    return '<li class="activity-item">' +
      '<span class="activity-time">' + formatDate(a.timestamp) + '</span>' +
      '<span class="activity-agent" style="color:' + agentColor + '">' + escapeHtml(a.agent) + '</span>' +
      '<span class="activity-action">' + escapeHtml(a.action) +
        (a.details ? ' &mdash; ' + escapeHtml(a.details.slice(0, 120)) : '') +
      '</span>' +
      '</li>';
  }).join('');

  list.innerHTML = html;
}

// ── Reviews View ─────────────────────────────────────────────────────

async function loadReviews() {
  await loadFeedbackHistory();
}

async function loadDailyReviewForm(productId) {
  if (!productId) {
    var input = document.getElementById('daily-review-product-id');
    productId = input ? input.value.trim() : '';
  }
  if (!productId) {
    showToast('Please enter a product ID', 'error');
    return;
  }

  var container = document.getElementById('daily-review-form-container');
  container.innerHTML = '<div class="loading">Loading...</div>';

  var data = await apiFetch('/api/review/daily/' + encodeURIComponent(productId));
  if (!data || !data.formData) {
    container.innerHTML = '<div class="empty-state"><p>Product not found or failed to load.</p></div>';
    return;
  }

  var fd = data.formData;
  var html = '';

  // Show product info if available
  if (fd.brief) {
    html += '<div style="margin-bottom: var(--spacing-md); padding: var(--spacing-md); background: var(--color-surface-alt); border-radius: var(--radius-md);">' +
      '<strong>' + escapeHtml(fd.brief.title || fd.productId) + '</strong>' +
      (fd.brief.niche ? ' &mdash; ' + escapeHtml(fd.brief.niche) : '') +
      (fd.brief.productType ? ' (' + escapeHtml(fd.brief.productType) + ')' : '') +
      '</div>';
  }

  // Show existing scores if available
  if (fd.scores) {
    html += '<div class="score-summary" style="margin-bottom: var(--spacing-md);">' +
      '<div class="score-item"><span class="score-value">' + (fd.scores.layout || 0) + '</span><span class="score-label">Layout</span></div>' +
      '<div class="score-item"><span class="score-value">' + (fd.scores.typography || 0) + '</span><span class="score-label">Typography</span></div>' +
      '<div class="score-item"><span class="score-value">' + (fd.scores.color || 0) + '</span><span class="score-label">Color</span></div>' +
      '<div class="score-item"><span class="score-value">' + (fd.scores.differentiation || 0) + '</span><span class="score-label">Differentiation</span></div>' +
      '<div class="score-item"><span class="score-value">' + (fd.scores.sellability || 0) + '</span><span class="score-label">Sellability</span></div>' +
      '</div>';
  }

  // Show existing review notice if already reviewed today
  if (fd.existingReview) {
    var r = fd.existingReview;
    html += '<div style="margin-bottom:var(--spacing-md);padding:var(--spacing-md);background:var(--color-info-bg);border-radius:var(--radius-md);font-size:0.875rem;">' +
      '<strong>Already reviewed today:</strong> ' +
      'Layout ' + r.layout + '/5, Typography ' + r.typography + '/5, Color ' + r.colorAesthetic + '/5, ' +
      'Diff ' + r.differentiation + '/5, Sell ' + r.sellability + '/5 &mdash; ' +
      badgeHtml(r.decision) +
      '</div>';
  }

  // Build the review form
  html += '<form id="daily-review-submit-form" onsubmit="submitDailyReview(event)">' +
    '<input type="hidden" name="productId" value="' + escapeHtml(productId) + '">';

  html += buildRatingInput('layout', 'Layout Quality');
  html += buildRatingInput('typography', 'Typography');
  html += buildRatingInput('colorAesthetic', 'Color / Aesthetic Match');
  html += buildRatingInput('differentiation', 'Differentiation from Competitors');
  html += buildRatingInput('sellability', 'Overall Sellability');

  html += '<div class="form-group">' +
    '<label class="form-label">Problem Source</label>' +
    '<select name="problemSource" class="form-select" required>' +
    '<option value="">Select...</option>' +
    '<option value="design">Design</option>' +
    '<option value="spec">Spec</option>' +
    '<option value="research">Research</option>' +
    '</select></div>';

  html += '<div class="form-group">' +
    '<label class="form-label">Decision</label>' +
    '<div class="rating-input">' +
    '<label style="width:auto;padding:0 12px;"><input type="radio" name="decision" value="approve"><span>Approve</span></label>' +
    '<label style="width:auto;padding:0 12px;"><input type="radio" name="decision" value="revise"><span>Revise</span></label>' +
    '<label style="width:auto;padding:0 12px;"><input type="radio" name="decision" value="reject"><span>Reject</span></label>' +
    '</div></div>';

  html += '<div class="form-group">' +
    '<label class="form-label">Specific Issues</label>' +
    '<textarea name="issues" class="form-textarea" placeholder="Describe any specific issues..."></textarea>' +
    '</div>';

  html += '<button type="submit" class="btn btn-primary">Submit Daily Review</button>';
  html += '</form>';

  container.innerHTML = html;
}

async function submitDailyReview(event) {
  event.preventDefault();

  var form = document.getElementById('daily-review-submit-form');
  var formData = new FormData(form);
  var productId = formData.get('productId');

  var body = {
    layout: parseInt(formData.get('layout'), 10),
    typography: parseInt(formData.get('typography'), 10),
    colorAesthetic: parseInt(formData.get('colorAesthetic'), 10),
    differentiation: parseInt(formData.get('differentiation'), 10),
    sellability: parseInt(formData.get('sellability'), 10),
    issues: formData.get('issues') || '',
    problemSource: formData.get('problemSource'),
    decision: formData.get('decision'),
  };

  // Validate ratings
  if (!body.layout || !body.typography || !body.colorAesthetic ||
      !body.differentiation || !body.sellability) {
    showToast('Please fill in all rating fields (1-5)', 'error');
    return;
  }

  if (!body.problemSource) {
    showToast('Please select a problem source', 'error');
    return;
  }

  if (!body.decision) {
    showToast('Please select a decision (approve/reject/revise)', 'error');
    return;
  }

  var result = await apiPost('/api/review/daily/' + encodeURIComponent(productId), body);
  if (result && result.success) {
    showToast('Daily review submitted successfully', 'success');
    await loadFeedbackHistory();
  } else {
    showToast('Failed to submit daily review', 'error');
  }
}

async function loadWeeklyBatch() {
  var container = document.getElementById('weekly-batch-container');
  container.innerHTML = '<div class="loading">Loading weekly batch...</div>';

  var data = await apiFetch('/api/review/weekly');
  if (!data || !data.batch) {
    container.innerHTML = '<div class="empty-state"><p>Failed to load weekly batch.</p></div>';
    return;
  }

  var batch = data.batch;

  if (!batch.products || !batch.products.length) {
    container.innerHTML = '<div class="empty-state"><p>No products to review this week.</p></div>';
    return;
  }

  var html = '<div style="margin-bottom: var(--spacing-md); padding: var(--spacing-sm); background: var(--color-surface-alt); border-radius: var(--radius-sm); font-size: 0.875rem;">' +
    'Week: ' + formatDateShort(batch.weekStart) + ' &mdash; ' + formatDateShort(batch.weekEnd) +
    ' | ' + batch.totalCount + ' product(s)' +
    '</div>';

  html += '<form id="weekly-review-submit-form" onsubmit="submitWeeklyReview(event)">';

  batch.products.forEach(function (p, idx) {
    var title = (p.brief && p.brief.title) ? escapeHtml(p.brief.title) : escapeHtml(p.id);
    var niche = (p.brief && p.brief.niche) ? escapeHtml(p.brief.niche) : '--';

    html += '<div class="card" style="margin-bottom: var(--spacing-md); border: 1px solid var(--color-border);">' +
      '<div class="card-header">' +
      '<span class="card-title">' + title + '</span>' +
      '<span>' + niche + '</span>' +
      '</div>' +
      '<input type="hidden" name="product-' + idx + '-id" value="' + escapeHtml(p.id) + '">';

    // Show existing scores if available
    if (p.scores) {
      html += '<div class="score-summary" style="margin-bottom: var(--spacing-md);">' +
        '<div class="score-item"><span class="score-value">' + (p.scores.layout || 0) + '</span><span class="score-label">Layout</span></div>' +
        '<div class="score-item"><span class="score-value">' + (p.scores.typography || 0) + '</span><span class="score-label">Typography</span></div>' +
        '<div class="score-item"><span class="score-value">' + (p.scores.color || 0) + '</span><span class="score-label">Color</span></div>' +
        '<div class="score-item"><span class="score-value">' + (p.scores.differentiation || 0) + '</span><span class="score-label">Differentiation</span></div>' +
        '<div class="score-item"><span class="score-value">' + (p.scores.sellability || 0) + '</span><span class="score-label">Sellability</span></div>' +
        '</div>';
    }

    html += '<div class="form-group">' +
      '<label class="form-label">Detailed Notes</label>' +
      '<textarea name="product-' + idx + '-detailedNotes" class="form-textarea" placeholder="Page-level details, design notes..."></textarea>' +
      '</div>';

    html += '<div class="form-group">' +
      '<label class="form-label">Comparison Notes</label>' +
      '<textarea name="product-' + idx + '-comparisonNotes" class="form-textarea" placeholder="How does this compare to reference designs / top sellers?"></textarea>' +
      '</div>';

    html += '<div class="form-group">' +
      '<label class="form-label">Instruction Suggestions</label>' +
      '<textarea name="product-' + idx + '-instructionSuggestions" class="form-textarea" placeholder="Suggestions for improving agent instructions..."></textarea>' +
      '</div>';

    html += '</div>';
  });

  html += '<input type="hidden" name="productCount" value="' + batch.products.length + '">';
  html += '<button type="submit" class="btn btn-primary">Submit All Weekly Reviews</button>';
  html += '</form>';

  container.innerHTML = html;
}

async function submitWeeklyReview(event) {
  event.preventDefault();

  var form = document.getElementById('weekly-review-submit-form');
  var formData = new FormData(form);
  var count = parseInt(formData.get('productCount'), 10);

  var reviews = [];
  for (var i = 0; i < count; i++) {
    var productId = formData.get('product-' + i + '-id');
    var detailedNotes = formData.get('product-' + i + '-detailedNotes') || '';
    var comparisonNotes = formData.get('product-' + i + '-comparisonNotes') || '';
    var instructionSuggestions = formData.get('product-' + i + '-instructionSuggestions') || '';

    reviews.push({
      productId: productId,
      pageAnnotations: [],
      detailedNotes: detailedNotes,
      comparisonNotes: comparisonNotes,
      instructionSuggestions: instructionSuggestions,
    });
  }

  if (!reviews.length) {
    showToast('No reviews to submit', 'error');
    return;
  }

  var result = await apiPost('/api/review/weekly', reviews);
  if (result && result.success) {
    showToast('Weekly reviews submitted (' + result.count + ' products)', 'success');
    await loadFeedbackHistory();
  } else {
    showToast('Failed to submit weekly reviews', 'error');
  }
}

async function loadFeedbackHistory() {
  var results = await Promise.all([
    apiFetch('/api/feedback/daily'),
    apiFetch('/api/feedback/weekly'),
  ]);

  var dailyData = results[0];
  var weeklyData = results[1];

  // Render daily feedback history
  var dailyTbody = document.getElementById('feedback-daily-history');
  if (dailyTbody) {
    if (dailyData && dailyData.records && dailyData.records.length) {
      var dailyRows = dailyData.records.slice(0, 20).map(function (r) {
        var filename = r.filename || '';
        var datePart = filename.split('-').slice(0, 3).join('-') || formatDateShort(r.submittedAt) || '--';
        var pidPart = r.productId || filename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.json$/, '') || '--';
        return '<tr>' +
          '<td>' + escapeHtml(datePart) + '</td>' +
          '<td><code>' + escapeHtml(pidPart) + '</code></td>' +
          '<td>' + (r.layout || r.layoutQuality || '--') + '</td>' +
          '<td>' + (r.typography || '--') + '</td>' +
          '<td>' + (r.colorAesthetic || r.colorAestheticMatch || r.color || '--') + '</td>' +
          '<td>' + (r.differentiation || '--') + '</td>' +
          '<td>' + (r.sellability || r.overallSellability || '--') + '</td>' +
          '<td>' + badgeHtml(r.decision || '--') + '</td>' +
          '</tr>';
      }).join('');
      dailyTbody.innerHTML = dailyRows;
    } else {
      dailyTbody.innerHTML = '<tr><td colspan="8" class="empty-state"><p>No daily reviews recorded yet.</p></td></tr>';
    }
  }

  // Render weekly feedback history
  var weeklyTbody = document.getElementById('feedback-weekly-history');
  if (weeklyTbody) {
    if (weeklyData && weeklyData.records && weeklyData.records.length) {
      var weeklyRows = weeklyData.records.slice(0, 10).map(function (r) {
        var submitted = r.submittedAt ? formatDate(r.submittedAt) : '--';
        var weekRange = '';
        if (r.weekStart && r.weekEnd) {
          weekRange = formatDateShort(r.weekStart) + ' - ' + formatDateShort(r.weekEnd);
        }
        var reviewCount = (r.reviews && Array.isArray(r.reviews)) ? r.reviews.length : 0;
        return '<tr>' +
          '<td>' + submitted + '</td>' +
          '<td>' + escapeHtml(weekRange) + '</td>' +
          '<td>' + reviewCount + '</td>' +
          '</tr>';
      }).join('');
      weeklyTbody.innerHTML = weeklyRows;
    } else {
      weeklyTbody.innerHTML = '<tr><td colspan="3" class="empty-state"><p>No weekly reviews recorded yet.</p></td></tr>';
    }
  }
}

// ── Navigation / Routing ─────────────────────────────────────────────

function switchView(viewName) {
  currentView = viewName;

  document.querySelectorAll('.nav-links a').forEach(function (a) {
    a.classList.toggle('active', a.getAttribute('data-view') === viewName);
  });

  document.querySelectorAll('.view-section').forEach(function (section) {
    section.classList.toggle('active', section.id === 'view-' + viewName);
  });

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
    case 'reviews':
      await loadReviews();
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
  if (btn) btn.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
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

  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  document.querySelectorAll('.nav-links a').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      var view = a.getAttribute('data-view');
      window.location.hash = view;
    });
  });

  window.addEventListener('hashchange', handleHashChange);

  handleHashChange();
  startAutoRefresh();
}

// Make functions available globally for inline onclick handlers
window.submitApproval = submitApproval;
window.submitApprovalWithFeedback = submitApprovalWithFeedback;
window.submitFeedback = submitFeedback;
window.togglePdfPreview = togglePdfPreview;
window.loadDailyReviewForm = loadDailyReviewForm;
window.submitDailyReview = submitDailyReview;
window.loadWeeklyBatch = loadWeeklyBatch;
window.submitWeeklyReview = submitWeeklyReview;
window.loadFeedbackHistory = loadFeedbackHistory;

document.addEventListener('DOMContentLoaded', init);
