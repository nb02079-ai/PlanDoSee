// ============================================================
// 플랜두씨 다이어리 — 앱 로직
// ============================================================

const COLORS = {
  mint:     { bg: 'var(--mint-bg)',     fg: 'var(--mint-fg)' },
  lavender: { bg: 'var(--lavender-bg)', fg: 'var(--lavender-fg)' },
  peach:    { bg: 'var(--peach-bg)',    fg: 'var(--peach-fg)' },
  butter:   { bg: 'var(--butter-bg)',   fg: 'var(--butter-fg)' },
  sky:      { bg: 'var(--sky-bg)',      fg: 'var(--sky-fg)' },
  rose:     { bg: 'var(--rose-bg)',     fg: 'var(--rose-fg)' },
};

let sb = null;
let pdsLoadingCount = 0;
function pdsLoadingStart() {
  pdsLoadingCount++;
  const el = document.getElementById('pdsLoadingBar');
  if (el) el.classList.add('active');
}
function pdsLoadingEnd() {
  pdsLoadingCount = Math.max(0, pdsLoadingCount - 1);
  if (pdsLoadingCount === 0) {
    const el = document.getElementById('pdsLoadingBar');
    if (el) el.classList.remove('active');
  }
}
let state = {
  tab: 'calendar',
  monthCursor: new Date(), // 달력에 표시 중인 달
  selectedDay: null,       // 'YYYY-MM-DD' or null
  plans: [],
  currentPlanId: null,
  todos: [],               // 현재 선택된 계획의 할일
  allTodosForMonth: [],    // 달력용: 전체 계획의 할일(플랜 join)
  historyOpenPlanId: null, // 지금 이력을 펼쳐놓은 계획 id
  historyCache: {},        // planId -> plan_history[]
  search: '',
  statusFilter: 'all',
  reviewFilter: null,      // 'all'|'done'|'delayed'|'blocked' — 드릴다운용
  lastReviewId: null,
  showPlanForm: false,
  editingPlanId: null,     // 지금 수정 폼을 펼쳐놓은 계획 id
  showTodoForm: false,
  reviewPeriodType: 'weekly',   // 'weekly' | 'monthly'
  reviewPeriodAnchor: new Date(), // 이 날짜가 속한 주/달을 봄
  periodGroups: [],             // [{plan, items:[todo,...]}]
  periodReviewId: null,
  periodReviewNote: '',
  allLogs: [],           // 기록 탭: 전체 실행기록(할일/계획 join)
  logsPlanFilter: 'all', // 기록 탭 필터
  showEndedPlans: false, // 계획 탭: 지난 계획 펼침 여부
  reviewSubView: 'period', // 돌아보기 탭: 'period' | 'logs'
};

function initSupabase() {
  if (!window.supabase || SUPABASE_URL.includes('YOUR_PROJECT') || SUPABASE_ANON_KEY.includes('YOUR_ANON_KEY')) {
    document.getElementById('setupWarning').classList.remove('hidden');
    return false;
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return true;
}

// ---------- 인증 (Supabase Auth) ----------
let currentUser = null;

function showAuthError(message) {
  const el = document.getElementById('authError');
  el.textContent = message;
  el.style.display = 'block';
}
function hideAuthError() {
  const el = document.getElementById('authError');
  el.style.display = 'none';
}

function setAuthButtonsDisabled(disabled) {
  document.getElementById('authLoginBtn').disabled = disabled;
  document.getElementById('authSignupBtn').disabled = disabled;
}

async function submitAuth(mode, btn) {
  if (btn.disabled) return;
  hideAuthError();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!email || !password) { showAuthError('ID와 PW를 입력하세요.'); return; }

  setAuthButtonsDisabled(true);
  pdsLoadingStart();
  try {
    if (mode === 'signup') {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) { showAuthError(error.message); return; }
      if (data.user && !data.session) {
        showAuthError('가입 확인 메일을 보냈어요. 메일함을 확인한 뒤 로그인해주세요.');
      }
      // data.session이 바로 있으면(이메일 확인 없이 가입 즉시 로그인 설정된 프로젝트) onAuthStateChange가 알아서 처리
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) { showAuthError(error.message); return; }
    }
  } finally {
    setAuthButtonsDisabled(false);
    pdsLoadingEnd();
  }
}

async function doLogout() {
  pdsLoadingStart();
  await sb.auth.signOut();
  pdsLoadingEnd();
}

function updateAuthUI() {
  const gate = document.getElementById('authGate');
  const inner = document.getElementById('appInner');
  if (currentUser) {
    gate.classList.add('hidden');
    inner.classList.remove('hidden');
    document.getElementById('accountEmail').textContent = currentUser.email;
  } else {
    gate.classList.remove('hidden');
    inner.classList.add('hidden');
  }
}

// ---------- 날짜 유틸 (KST 기준) ----------
function kstNow() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 9 * 3600000);
}
function toDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function startOfWeekMonday(d) {
  const day = d.getDay(); // 0=일
  const diff = (day === 0 ? -6 : 1) - day;
  const res = new Date(d);
  res.setDate(d.getDate() + diff);
  res.setHours(0, 0, 0, 0);
  return res;
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function daysInMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

// ---------- 주간/월간 리뷰 범위 ----------
function getPeriodRange(type, anchor) {
  if (type === 'weekly') {
    const start = startOfWeekMonday(anchor);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start, end };
  }
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const end = new Date(anchor.getFullYear(), anchor.getMonth(), daysInMonth(anchor));
  return { start, end };
}

async function loadPeriodReviewData() {
  const { start, end } = getPeriodRange(state.reviewPeriodType, state.reviewPeriodAnchor);
  const startStr = toDateStr(start), endStr = toDateStr(end);

  const { data: todos, error } = await sb.from('todos')
    .select('*, plans(id,title,color)')
    .gte('due_date', startStr).lte('due_date', endStr);
  if (error) { console.error(error); state.periodGroups = []; }
  else {
    const byPlan = {};
    (todos || []).forEach(t => {
      const pid = t.plan_id;
      if (!byPlan[pid]) byPlan[pid] = { plan: t.plans, items: [] };
      byPlan[pid].items.push(t);
    });
    state.periodGroups = Object.values(byPlan);
  }

  const { data: reviewRows } = await sb.from('period_reviews').select('*')
    .eq('period_type', state.reviewPeriodType).eq('period_start', startStr).eq('period_end', endStr).limit(1);
  if (reviewRows && reviewRows.length) {
    state.periodReviewId = reviewRows[0].id;
    state.periodReviewNote = reviewRows[0].note;
  } else {
    state.periodReviewId = null;
    state.periodReviewNote = '';
  }
}

// ---------- 데이터 로드 ----------
async function loadPlans() {
  const { data, error } = await sb.from('plans').select('*').order('created_at', { ascending: true });
  if (error) { console.error(error); return; }
  state.plans = data || [];
  if (!state.currentPlanId && state.plans.length) state.currentPlanId = state.plans[0].id;
}

async function loadTodosForCurrentPlan() {
  if (!state.currentPlanId) { state.todos = []; return; }
  const { data, error } = await sb.from('todos').select('*').eq('plan_id', state.currentPlanId);
  if (error) { console.error(error); return; }
  state.todos = data || [];
}

async function loadAllTodosForMonth() {
  const { data, error } = await sb.from('todos').select('*, plans(color,title,cadence,target_count)');
  if (error) { console.error(error); return; }
  state.allTodosForMonth = data || [];
}

async function loadAllLogs() {
  const { data, error } = await sb.from('execution_logs')
    .select('*, todos(title, plan_id, plans(title,color))')
    .order('ended_at', { ascending: false });
  if (error) { console.error(error); state.allLogs = []; return; }
  state.allLogs = data || [];
}

// ---------- CRUD ----------
async function createPlan(payload) {
  const { data, error } = await sb.from('plans').insert(payload).select().single();
  if (error) { pdsAlert('계획 저장 실패: ' + error.message); return null; }
  return data;
}
async function updatePlan(id, payload) {
  const { error } = await sb.from('plans').update(payload).eq('id', id);
  if (error) { pdsAlert('계획 수정 실패: ' + error.message); return false; }
  return true;
}
async function deletePlan(id) {
  const { error } = await sb.from('plans').delete().eq('id', id);
  if (error) { pdsAlert('계획 삭제 실패: ' + error.message); return false; }
  return true;
}
async function createTodo(payload) {
  const { error } = await sb.from('todos').insert(payload);
  if (error) { pdsAlert('할 일 저장 실패: ' + error.message); return false; }
  return true;
}
async function updateTodo(id, payload) {
  const { error } = await sb.from('todos').update(payload).eq('id', id);
  if (error) { pdsAlert('할 일 수정 실패: ' + error.message); return false; }
  return true;
}
async function deleteTodo(id) {
  const { error } = await sb.from('todos').delete().eq('id', id);
  if (error) pdsAlert('삭제 실패: ' + error.message);
}

// 완료 처리: 조건부 UPDATE로 이중 클릭에도 1건만 반영
async function performComplete(todo, minutes, blocker) {
  const endedAt = new Date().toISOString();
  const startedAt = new Date(Date.now() - minutes * 60000).toISOString();

  const { data, error } = await sb.from('todos')
    .update({ status: 'done', completed_at: endedAt })
    .eq('id', todo.id)
    .eq('status', 'in_progress')
    .select();

  if (error) { pdsAlert('완료 처리 실패: ' + error.message); return false; }
  if (data && data.length > 0) {
    const { error: logError } = await sb.from('execution_logs').insert({
      todo_id: todo.id, started_at: startedAt, ended_at: endedAt,
      actual_minutes: minutes, blocker_reason: blocker,
    });
    if (logError) { pdsAlert('실행 기록 저장 실패: ' + logError.message); return false; }
  }
  return true;
}
async function uncompleteTodo(todo) {
  await updateTodo(todo.id, { status: 'in_progress', completed_at: null });
}

async function createReview(payload) {
  const { data, error } = await sb.from('reviews').insert(payload).select().single();
  if (error) { pdsAlert('돌아보기 저장 실패: ' + error.message); return null; }
  return data;
}

// ---------- 탭 전환 ----------
async function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  await refreshAndRender();
}

async function refreshAndRender() {
  if (!sb) { render(); return; }
  pdsLoadingStart();
  try {
    if (state.tab === 'calendar') await loadAllTodosForMonth();
    if (state.tab === 'todos') { await loadTodosForCurrentPlan(); }
    if (state.tab === 'review') { await loadTodosForCurrentPlan(); await computeReviewStats(); await loadPeriodReviewData(); await loadAllLogs(); await loadAllTodosForMonth(); }
  } finally {
    pdsLoadingEnd();
  }
  render();
}

async function computeReviewStats() {
  const todos = state.todos;
  const todayStr = toDateStr(kstNow());
  const planCount = todos.length;
  const doneCount = todos.filter(t => t.status === 'done').length;
  const delayedCount = todos.filter(t => t.status !== 'done' && t.due_date && t.due_date < todayStr).length;

  let blockedCount = 0, actualMinutesTotal = 0;
  const todoIds = todos.map(t => t.id);
  if (todoIds.length) {
    const { data: logs } = await sb.from('execution_logs').select('*').in('todo_id', todoIds);
    if (logs) {
      const blockedSet = new Set(logs.filter(l => l.blocker_reason && l.blocker_reason.trim()).map(l => l.todo_id));
      blockedCount = blockedSet.size;
      actualMinutesTotal = logs.reduce((s, l) => s + (l.actual_minutes || 0), 0);
    }
  }
  const estimatedTotal = todos.reduce((s, t) => s + (t.estimated_hours || 0), 0);
  const actualTotal = actualMinutesTotal / 60;
  state.reviewStats = { planCount, doneCount, delayedCount, blockedCount, estimatedTotal, actualTotal, diff: actualTotal - estimatedTotal };
}

function render() {
  const page = document.getElementById('page');

  // 재렌더링으로 입력 중이던 칸의 포커스가 날아가지 않도록 저장
  const active = document.activeElement;
  let restoreId = null, restoreStart = null, restoreEnd = null;
  if (active && page.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    restoreId = active.id;
    restoreStart = active.selectionStart;
    restoreEnd = active.selectionEnd;
  }

  if (state.tab === 'calendar') page.innerHTML = renderCalendar();
  if (state.tab === 'plans') page.innerHTML = renderPlans();
  if (state.tab === 'todos') page.innerHTML = renderTodos();
  if (state.tab === 'review') page.innerHTML = renderReview();
  if (state.tab === 'settings') page.innerHTML = renderSettings();

  if (restoreId) {
    const el = document.getElementById(restoreId);
    if (el) {
      el.focus();
      if (typeof restoreStart === 'number' && el.setSelectionRange) {
        try { el.setSelectionRange(restoreStart, restoreEnd); } catch (e) { /* 숫자/날짜 입력 등은 무시 */ }
      }
    }
  }
}

// ---------- 달력 ----------
function renderCalendar() {
  const cursor = state.monthCursor;
  const year = cursor.getFullYear(), month = cursor.getMonth();
  const first = startOfMonth(cursor);
  const firstWeekday = (first.getDay() === 0 ? 6 : first.getDay() - 1); // 월=0
  const total = daysInMonth(cursor);
  const todayStr = toDateStr(kstNow());

  const byDay = {};
  (state.allTodosForMonth || []).forEach(t => {
    if (!t.due_date) return;
    const d = new Date(t.due_date + 'T00:00:00');
    if (d.getFullYear() !== year || d.getMonth() !== month) return;
    const key = t.due_date;
    (byDay[key] = byDay[key] || []).push(t);
  });

  const todayItems = (state.allTodosForMonth || []).filter(t => t.due_date === todayStr)
    .sort((a, b) => prioRank(a.priority) - prioRank(b.priority));
  let todayHtml = '';
  if (todayItems.length) {
    const rows = todayItems.map((t, i) => {
      const c = COLORS[(t.plans && t.plans.color) || 'mint'];
      const icon = t.status === 'done'
        ? `<i class="ti ti-check" style="color:${c.fg};"></i>`
        : `<i class="ti ti-circle" style="color:var(--faint); cursor:pointer;" onclick="toggleComplete('${t.id}')"></i>`;
      const isLast = i === todayItems.length - 1;
      return `<div class="row" style="padding:7px 0; ${isLast ? '' : 'border-bottom:2px solid var(--faint);'}">
        ${icon}<span style="font-size:13px; ${t.status === 'done' ? 'text-decoration:line-through;color:var(--faint);' : ''}">${escapeHtml(t.title)}</span>
        <span style="margin-left:auto; background:${c.bg}; color:${c.fg}; font-size:10px; padding:2px 8px; border-radius:6px; white-space:nowrap;">${escapeHtml((t.plans && t.plans.title) || '')}</span>
      </div>`;
    }).join('');
    todayHtml = `<div class="info-card" style="margin-bottom:14px;">
      <div class="row" style="margin-bottom:8px;">
        <div style="font-size:13px;" class="grow">오늘 할 일</div>
        <span class="small-muted" style="cursor:pointer;" onclick="pickDay('${todayStr}')">자세히 →</span>
      </div>
      ${rows}
    </div>`;
  }

  let goalsHtml = '';
  const cadencePlans = state.plans.filter(p => p.cadence !== 'range' && p.target_count);
  if (cadencePlans.length) {
    const weekStart = startOfWeekMonday(kstNow());
    const monthStart = new Date(kstNow().getFullYear(), kstNow().getMonth(), 1);

    function renderGoalRow(p) {
      const doneTodos = (state.allTodosForMonth || []).filter(t => t.plan_id === p.id && t.status === 'done' && t.completed_at);
      const rangeStart = p.cadence === 'weekly' ? weekStart : monthStart;
      const count = doneTodos.filter(t => new Date(t.completed_at) >= rangeStart).length;
      const pct = Math.min(100, Math.round((count / p.target_count) * 100));
      const c = COLORS[p.color] || COLORS.mint;
      return `<div class="goal-row">
        <div class="goal-label"><span>${escapeHtml(p.title)}</span><span style="color:${c.fg}">${count} / ${p.target_count}</span></div>
        <div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${pct}%; background:${c.fg}"></div></div>
      </div>`;
    }

    const weeklyPlans = cadencePlans.filter(p => p.cadence === 'weekly');
    const monthlyPlans = cadencePlans.filter(p => p.cadence === 'monthly');

    if (weeklyPlans.length) {
      goalsHtml += `<div class="goal-panel" style="margin-bottom:10px;">
        <div style="font-size:13px; margin-bottom:10px;">주간 목표 <span class="small-muted">· 이번 주(월~일)</span></div>
        ${weeklyPlans.map(renderGoalRow).join('')}
      </div>`;
    }
    if (monthlyPlans.length) {
      goalsHtml += `<div class="goal-panel" style="margin-bottom:10px;">
        <div style="font-size:13px; margin-bottom:10px;">월간 목표 <span class="small-muted">· 이번 달</span></div>
        ${monthlyPlans.map(renderGoalRow).join('')}
      </div>`;
    }
  }

  const dows = ['월', '화', '수', '목', '금', '토', '일'];
  let grid = `<div class="cal-grid">`;
  dows.forEach(d => grid += `<div class="cal-dow">${d}</div>`);
  for (let i = 0; i < firstWeekday; i++) grid += `<div></div>`;
  for (let day = 1; day <= total; day++) {
    const dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    const items = (byDay[dateStr] || []).slice().sort((a, b) => prioRank(a.priority) - prioRank(b.priority));
    const shown = items.slice(0, 2);
    const extra = items.length - shown.length;
    let chips = '';
    shown.forEach(t => {
      const c = COLORS[(t.plans && t.plans.color) || 'mint'];
      const icon = t.status === 'done'
        ? `<i class="ti ti-check" style="font-size:9px;color:${c.fg}"></i>`
        : `<i class="ti ti-x" style="font-size:9px;color:var(--faint)"></i>`;
      chips += `<div class="chip" style="background:${c.bg};color:${c.fg}"><span>${escapeHtml(t.title)}</span>${icon}</div>`;
    });
    if (extra > 0) chips += `<div class="small-muted" style="margin-top:1px;">+${extra}</div>`;
    const isToday = dateStr === todayStr;
    grid += `<div class="cal-cell ${isToday ? 'today' : ''}" onclick="pickDay('${dateStr}')">
      <div class="cal-daynum ${isToday ? 'today' : ''}">${day}</div>${chips}</div>`;
  }
  grid += `</div>`;

  const monthLabel = `${year}년 ${month + 1}월`;
  return `${todayHtml}<div class="row" style="justify-content:space-between; margin-bottom:10px;">
      <button class="btn btn-ghost" aria-label="이전 달" onclick="shiftMonth(-1)"><i class="ti ti-chevron-left"></i></button>
      <div style="font-size:14px;">${monthLabel}</div>
      <button class="btn btn-ghost" aria-label="다음 달" onclick="shiftMonth(1)"><i class="ti ti-chevron-right"></i></button>
    </div>
    ${goalsHtml}
    ${grid}`;
}

function prioRank(p) { return p === 'high' ? 1 : p === 'medium' ? 2 : 3; }

function shiftMonth(delta) {
  const c = state.monthCursor;
  state.monthCursor = new Date(c.getFullYear(), c.getMonth() + delta, 1);
  render();
}

function pickDay(dateStr) {
  const items = (state.allTodosForMonth || []).filter(t => t.due_date === dateStr);

  const groups = {};
  items.forEach(t => {
    const pid = t.plan_id;
    if (!groups[pid]) groups[pid] = { plan: t.plans, planId: pid, items: [] };
    groups[pid].items.push(t);
  });

  let body = Object.values(groups).map(g => {
    const c = COLORS[(g.plan && g.plan.color) || 'mint'];
    const rows = g.items.map(t => {
      const icon = t.status === 'done'
        ? `<i class="ti ti-check" style="color:${c.fg}"></i>`
        : `<i class="ti ti-x" style="color:var(--faint)"></i>`;
      return `<div class="row" style="margin-bottom:6px;">${icon}<span>${escapeHtml(t.title)}</span></div>`;
    }).join('');
    return `<div style="background:${c.bg}; border:1px solid ${c.fg}; border-radius:12px; padding:12px 14px; margin-bottom:10px;">
      <div class="row" style="margin-bottom:8px;">
        <div class="plan-color-dot" style="background:${c.fg}"></div>
        <div style="font-size:13px; color:${c.fg};" class="grow">${escapeHtml((g.plan && g.plan.title) || '삭제된 계획')}</div>
        <span onclick="goToPlanDetail('${g.planId || ''}')" style="cursor:pointer; font-size:11px; color:${c.fg}; white-space:nowrap;">계획 상세보기 →</span>
      </div>
      ${rows}
    </div>`;
  }).join('');
  if (!items.length) body = `<div class="small-muted">그날 기록이 없습니다.</div>`;

  document.getElementById('dayModalCard').innerHTML = `
    <div onclick="closeDayModal()" style="cursor:pointer; font-size:12px; color:var(--muted); margin-bottom:14px;">← 닫기</div>
    <div style="font-size:16px; margin-bottom:14px;">${dateStr}</div>
    ${body}`;

  document.getElementById('dayModalOverlay').classList.add('show');
  document.getElementById('page').classList.add('faded');
}

function closeDayModal() {
  document.getElementById('dayModalOverlay').classList.remove('show');
  document.getElementById('page').classList.remove('faded');
}

function closeDayModalIfBackground(evt) {
  if (evt.target.id === 'dayModalOverlay') closeDayModal();
}

// ---------- 범용 팝업 (브라우저 alert/confirm 대체) ----------
function pdsAlert(message) {
  document.getElementById('dayModalCard').innerHTML = `
    <div style="font-size:13px; margin-bottom:18px; white-space:pre-wrap;">${escapeHtml(message)}</div>
    <div class="row" style="justify-content:flex-end;">
      <button class="btn btn-dark" onclick="closeDayModal()">확인</button>
    </div>`;
  document.getElementById('dayModalOverlay').classList.add('show');
  document.getElementById('page').classList.add('faded');
}

let pdsConfirmCallback = null;
function pdsConfirm(message, onYes) {
  pdsConfirmCallback = onYes;
  document.getElementById('dayModalCard').innerHTML = `
    <div style="font-size:13px; margin-bottom:18px; white-space:pre-wrap;">${escapeHtml(message)}</div>
    <div class="row" style="justify-content:flex-end;">
      <button class="btn btn-ghost" onclick="closeDayModal()">취소</button>
      <button class="btn btn-dark" onclick="pdsConfirmYes()">확인</button>
    </div>`;
  document.getElementById('dayModalOverlay').classList.add('show');
  document.getElementById('page').classList.add('faded');
}
function pdsConfirmYes() {
  const cb = pdsConfirmCallback;
  pdsConfirmCallback = null;
  closeDayModal();
  if (cb) cb();
}

async function goToPlanDetail(planId) {
  closeDayModal();
  if (planId) state.currentPlanId = planId;
  await switchTab('plans');
}

// ---------- 계획 선택기 (계획/할일 탭 공용) ----------
function renderPlanSelector(showCreateBtn) {
  const selectOptions = state.plans.map(p => `<option value="${p.id}" ${p.id === state.currentPlanId ? 'selected' : ''}>${escapeHtml(p.title)}</option>`).join('');
  return `<div class="row" style="margin-bottom:12px;">
    <select class="grow" onchange="selectPlan(this.value)">${selectOptions}</select>
    ${showCreateBtn ? `<button class="btn btn-ghost" aria-label="새 계획 만들기" onclick="togglePlanForm(true)"><i class="ti ti-plus"></i></button>` : ''}
  </div>`;
}

// ---------- 계획 ----------
function renderPlans() {
  let formHtml = '';
  if (state.showPlanForm) formHtml = renderPlanForm();

  const todayStr = toDateStr(kstNow());
  const activePlans = state.plans.filter(p => !p.period_end || p.period_end >= todayStr);
  const endedPlans = state.plans.filter(p => p.period_end && p.period_end < todayStr);

  const activeCards = activePlans.map(plan => renderPlanCard(plan)).join('');
  const emptyMsg = (!state.plans.length && !state.showPlanForm)
    ? `<div class="small-muted" style="margin-top:4px;">아직 계획이 없어요. 주간/월간 반복 목표든, 한 번짜리 계획이든 위 버튼으로 먼저 만들어보세요.</div>`
    : '';
  const noActiveMsg = (state.plans.length && !activePlans.length && !state.showPlanForm)
    ? `<div class="small-muted" style="margin-top:4px;">진행 중인 계획이 없어요. 아래 "지난 계획"을 확인해보세요.</div>`
    : '';

  let endedHtml = '';
  if (endedPlans.length) {
    endedHtml = `<div onclick="toggleEndedPlans()" style="font-size:12px; color:var(--muted); cursor:pointer; margin:10px 0; border-top:1px solid var(--pill-bg); padding-top:14px;">
      <i class="ti ti-chevron-${state.showEndedPlans ? 'up' : 'down'}"></i> 지난 계획 보기 (${endedPlans.length}개)
    </div>`;
    if (state.showEndedPlans) {
      endedHtml += endedPlans.map(plan => renderPlanCard(plan)).join('');
    }
  }

  return `
    <button class="btn btn-dark" style="width:100%; justify-content:center; margin-bottom:16px;" onclick="togglePlanForm(true)">
      <i class="ti ti-plus"></i> 새 계획 만들기
    </button>
    ${formHtml}
    ${emptyMsg}
    ${noActiveMsg}
    ${activeCards}
    ${endedHtml}
  `;
}

function toggleEndedPlans() { state.showEndedPlans = !state.showEndedPlans; render(); }

function renderPlanCard(plan) {
  if (state.editingPlanId === plan.id) {
    return `<div style="margin-bottom:18px;">${renderPlanForm(plan)}</div>`;
  }
  const c = COLORS[plan.color] || COLORS.mint;
  const histOpen = state.historyOpenPlanId === plan.id;

  return `
    <div style="border-top:1px solid var(--pill-bg); padding-top:14px; margin-bottom:6px;">
      <div class="row" style="margin-bottom:10px;">
        <div class="plan-color-dot" style="background:${c.fg}"></div>
        <div style="font-size:16px;" class="grow">${escapeHtml(plan.title)}</div>
        <button class="icon-btn" aria-label="계획 수정" onclick="toggleEditPlan('${plan.id}')"><i class="ti ti-edit"></i></button>
        <button class="icon-btn danger" aria-label="계획 삭제" onclick="confirmDeletePlan('${plan.id}')"><i class="ti ti-trash"></i></button>
      </div>
      <div class="info-card">
        <div><span class="k">기간</span> &nbsp; ${plan.period_start} – ${plan.period_end || '무기한'}</div>
        <div><span class="k">우선순위</span> &nbsp; ${prioLabel(plan.priority)}</div>
        <div><span class="k">성공 기준</span> &nbsp; ${escapeHtml(plan.success_criteria)}</div>
        <div><span class="k">예상 시간</span> &nbsp; ${plan.estimated_hours}시간</div>
        <div><span class="k">주기</span> &nbsp; ${plan.cadence === 'range' ? '기간 전체(1회성)' : (plan.cadence === 'weekly' ? '매주' : '매달') + ' ' + plan.target_count + '회'}</div>
      </div>
      <div onclick="toggleHistory('${plan.id}')" style="font-size:11px; color:var(--muted); cursor:pointer; margin-bottom:8px;">
        <i class="ti ti-chevron-${histOpen ? 'up' : 'down'}"></i> 수정 이력 보기
      </div>
      ${histOpen ? renderHistoryFor(plan.id) : ''}
      ${plan.cadence !== 'range' ? `<div style="margin-bottom:4px;">
        <span class="btn btn-ghost" onclick="openAutoFillModal('${plan.id}')" style="font-size:12px;"><i class="ti ti-repeat"></i> ${plan.cadence === 'weekly' ? '이번 주' : '이번 달'} 할 일 자동 채우기</span>
      </div>` : ''}
      <div style="margin-bottom:4px;">
        <span class="btn btn-ghost" onclick="goToTodosForPlan('${plan.id}')" style="font-size:12px;">이 계획의 할 일 보러가기 →</span>
      </div>
    </div>`;
}

function goToTodosForPlan(planId) {
  state.currentPlanId = planId;
  switchTab('todos');
}

function confirmDeletePlan(planId) {
  const plan = state.plans.find(p => p.id === planId);
  if (!plan) return;
  pdsConfirm(`"${plan.title}" 계획을 지울까요?\n딸린 할 일과 실행 기록도 함께 지워지고, 되돌릴 수 없어요.`, async () => {
    const ok = await deletePlan(planId);
    if (!ok) return;
    if (state.currentPlanId === planId) state.currentPlanId = null;
    await loadPlans();
    await refreshAndRender();
  });
}

// ---------- 반복 할 일 자동 채우기 ----------
let pdsAutoFillPending = null;

async function openAutoFillModal(planId) {
  const plan = state.plans.find(p => p.id === planId);
  if (!plan || plan.cadence === 'range') return;

  const { start, end } = getPeriodRange(plan.cadence, kstNow());
  const startStr = toDateStr(start), endStr = toDateStr(end);

  pdsLoadingStart();
  const { data, error } = await sb.from('todos').select('id, due_date')
    .eq('plan_id', planId).gte('due_date', startStr).lte('due_date', endStr);
  pdsLoadingEnd();
  if (error) { pdsAlert('불러오기 실패: ' + error.message); return; }

  const usedDates = new Set((data || []).map(t => t.due_date));
  const remaining = Math.max(0, (plan.target_count || 0) - usedDates.size);
  const periodLabel = plan.cadence === 'weekly' ? '이번 주' : '이번 달';

  if (remaining <= 0) {
    pdsAlert(`${periodLabel}(${startStr}~${endStr})에 이미 목표(${plan.target_count}회)만큼 할 일이 있어요.`);
    return;
  }

  pdsAutoFillPending = { planId, start, end, remaining, usedDates };

  document.getElementById('dayModalCard').innerHTML = `
    <div style="font-size:15px; margin-bottom:10px;">${escapeHtml(plan.title)} 자동 채우기</div>
    <div class="small-muted" style="margin-bottom:14px;">${periodLabel}(${startStr}~${endStr}) · 목표 ${plan.target_count}회 중 ${usedDates.size}회는 이미 있어요. 남은 날짜에 ${remaining}개를 만들게요.</div>
    <div class="field-group"><label>할 일 제목</label><input id="af-title" value="${escapeAttr(plan.title)}"></div>
    <div class="row" style="justify-content:flex-end; margin-top:10px;">
      <button class="btn btn-ghost" onclick="closeDayModal()">취소</button>
      <button class="btn btn-dark" onclick="confirmAutoFill()">만들기</button>
    </div>`;
  document.getElementById('dayModalOverlay').classList.add('show');
  document.getElementById('page').classList.add('faded');
}

async function confirmAutoFill() {
  if (!pdsAutoFillPending) return;
  const title = document.getElementById('af-title').value.trim();
  if (!title) { pdsAlert('제목을 입력하세요.'); return; }

  const { planId, start, end, remaining, usedDates } = pdsAutoFillPending;
  const plan = state.plans.find(p => p.id === planId);

  // 오늘부터 기간 끝까지, 아직 안 쓴 날짜 후보를 모음
  const todayStr = toDateStr(kstNow());
  const rangeStartStr = toDateStr(start) > todayStr ? toDateStr(start) : todayStr;
  const candidates = [];
  const cursor = new Date(rangeStartStr + 'T00:00:00');
  const endDate = new Date(toDateStr(end) + 'T00:00:00');
  while (cursor <= endDate) {
    const ds = toDateStr(cursor);
    if (!usedDates.has(ds)) candidates.push(ds);
    cursor.setDate(cursor.getDate() + 1);
  }

  if (!candidates.length) {
    pdsAlert('할 일을 넣을 수 있는 날짜가 남아있지 않아요. (이미 지난 기간이거나 매일 다른 할 일로 꽉 찼어요)');
    return;
  }

  // remaining개를 후보 날짜에서 균등 간격으로 골라냄
  const n = Math.min(remaining, candidates.length);
  const picks = [];
  for (let i = 0; i < n; i++) {
    picks.push(candidates[Math.floor(i * candidates.length / n)]);
  }

  const perItemHours = plan.estimated_hours || null;

  for (const dateStr of picks) {
    await sb.from('todos').insert({
      plan_id: planId, title, due_date: dateStr,
      priority: plan.priority, tags: [], estimated_hours: perItemHours,
    });
  }

  pdsAutoFillPending = null;
  closeDayModal();
  state.currentPlanId = planId;
  await refreshAndRender();
  pdsAlert(`${n}개의 할 일을 만들었어요.`);
}

function prioLabel(p) { return p === 'high' ? '높음' : p === 'medium' ? '중간' : '낮음'; }

function renderPlanForm(existing) {
  const p = existing || {};
  const title = 'planFormFields';
  return `<div class="info-card" id="${title}" style="margin-bottom:16px;">
    <div class="field-group"><label>제목</label><input id="pf-title" value="${escapeAttr(p.title || '')}"></div>
    <div class="row">
      <div class="field-group grow"><label>시작일</label><input id="pf-start" type="date" value="${p.period_start || ''}"></div>
      <div class="field-group grow">
        <label>종료일</label>
        <input id="pf-end" type="date" value="${p.period_end || ''}" ${p.period_end === null && p.id ? 'disabled' : ''}>
      </div>
    </div>
    <div class="field-group" style="display:flex; align-items:center; gap:6px;">
      <input type="checkbox" id="pf-indefinite" style="width:auto; border-radius:4px;" ${(!p.period_end && p.id) ? 'checked' : ''} onchange="pdsToggleIndefinite(this.checked)">
      <label style="margin:0; font-size:12px; color:var(--muted);" for="pf-indefinite">무기한 (종료일 없음)</label>
    </div>
    <div class="field-group"><label>우선순위</label>
      <select id="pf-priority">
        <option value="high" ${p.priority === 'high' ? 'selected' : ''}>높음</option>
        <option value="medium" ${p.priority === 'medium' ? 'selected' : ''}>중간</option>
        <option value="low" ${p.priority === 'low' ? 'selected' : ''}>낮음</option>
      </select>
    </div>
    <div class="field-group"><label>성공 기준</label><input id="pf-criteria" value="${escapeAttr(p.success_criteria || '')}"></div>
    <div class="field-group"><label>예상 시간(시간)</label><input id="pf-hours" type="number" step="0.5" value="${p.estimated_hours || ''}"></div>
    <div class="row">
      <div class="field-group grow"><label>주기</label>
        <select id="pf-cadence">
          <option value="range" ${p.cadence === 'range' || !p.cadence ? 'selected' : ''}>기간 전체(1회성)</option>
          <option value="weekly" ${p.cadence === 'weekly' ? 'selected' : ''}>매주 N회</option>
          <option value="monthly" ${p.cadence === 'monthly' ? 'selected' : ''}>매달 N회</option>
        </select>
      </div>
      <div class="field-group grow"><label>목표 횟수</label><input id="pf-target" type="number" value="${p.target_count || ''}"></div>
    </div>
    <div class="field-group"><label>색</label>
      <select id="pf-color">
        <option value="mint" ${p.color === 'mint' || !p.color ? 'selected' : ''}>민트</option>
        <option value="lavender" ${p.color === 'lavender' ? 'selected' : ''}>라벤더</option>
        <option value="peach" ${p.color === 'peach' ? 'selected' : ''}>피치</option>
        <option value="butter" ${p.color === 'butter' ? 'selected' : ''}>버터</option>
        <option value="sky" ${p.color === 'sky' ? 'selected' : ''}>스카이</option>
        <option value="rose" ${p.color === 'rose' ? 'selected' : ''}>로즈</option>
      </select>
    </div>
    <div class="row">
      <button class="btn btn-dark" onclick="submitPlanForm('${existing ? existing.id : ''}', this)">저장</button>
      <button class="btn btn-ghost" onclick="cancelPlanForm()">취소</button>
    </div>
  </div>`;
}

function togglePlanForm(v) { state.showPlanForm = v; render(); }
function cancelPlanForm() { state.showPlanForm = false; state.editingPlanId = null; render(); }
function toggleEditPlan(planId) { state.editingPlanId = state.editingPlanId === planId ? null : planId; render(); }
function pdsToggleIndefinite(checked) {
  const end = document.getElementById('pf-end');
  end.disabled = checked;
  if (checked) end.value = '';
}

async function submitPlanForm(existingId, btn) {
  if (btn) { if (btn.disabled) return; btn.disabled = true; }
  const indefinite = document.getElementById('pf-indefinite').checked;
  const payload = {
    title: document.getElementById('pf-title').value.trim(),
    period_start: document.getElementById('pf-start').value,
    period_end: indefinite ? null : document.getElementById('pf-end').value,
    priority: document.getElementById('pf-priority').value,
    success_criteria: document.getElementById('pf-criteria').value.trim(),
    estimated_hours: Number(document.getElementById('pf-hours').value) || 0,
    cadence: document.getElementById('pf-cadence').value,
    target_count: Number(document.getElementById('pf-target').value) || null,
    color: document.getElementById('pf-color').value,
  };
  if (!payload.title || !payload.period_start || (!indefinite && !payload.period_end)) {
    pdsAlert('제목/시작일은 필수이고, 무기한이 아니면 종료일도 입력해야 해요.');
    if (btn) btn.disabled = false;
    return;
  }
  if (payload.cadence === 'range') payload.target_count = null;

  if (state.lastReviewId && !existingId) {
    payload.carried_from_review_id = state.lastReviewId;
    state.lastReviewId = null;
  }

  if (existingId) {
    const ok = await updatePlan(existingId, payload);
    if (!ok) { if (btn) btn.disabled = false; return; }
    delete state.historyCache[existingId]; // 방금 수정했으니 이력 캐시 무효화
  } else {
    const created = await createPlan(payload);
    if (!created) { if (btn) btn.disabled = false; return; }
    state.currentPlanId = created.id;
  }
  state.showPlanForm = false;
  state.editingPlanId = null;
  await loadPlans();
  await refreshAndRender();
}

function selectPlan(id) { state.currentPlanId = id; refreshAndRender(); }

async function toggleHistory(planId) {
  state.historyOpenPlanId = state.historyOpenPlanId === planId ? null : planId;
  if (state.historyOpenPlanId && !state.historyCache[planId]) {
    const { data, error } = await sb.from('plan_history').select('*').eq('plan_id', planId).order('recorded_at', { ascending: false });
    if (!error) state.historyCache[planId] = data || [];
  }
  render();
}

function renderHistoryFor(planId) {
  const history = state.historyCache[planId] || [];
  if (!history.length) return `<div class="small-muted" style="margin-bottom:12px;">아직 수정 이력이 없어요.</div>`;
  const items = history.map(h => `<div class="small-muted" style="margin-bottom:4px;">
    <span style="text-decoration:line-through;">${escapeHtml(h.title)} · ${h.period_start}~${h.period_end || '무기한'} · ${escapeHtml(h.success_criteria)}</span>
    <div>${new Date(h.recorded_at).toLocaleString('ko-KR')} 이전 값</div>
  </div>`).join('');
  return `<div style="border-left:2px solid var(--pill-bg); padding-left:10px; margin-bottom:12px;">${items}</div>`;
}

// ---------- 완료 스트릭 / 히트맵 ----------
function computeStreakAndCounts(logs) {
  const countMap = {};
  logs.forEach(l => {
    const d = toDateStr(new Date(l.ended_at));
    countMap[d] = (countMap[d] || 0) + 1;
  });
  let streak = 0;
  const cursor = kstNow();
  while (countMap[toDateStr(cursor)]) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { countMap, streak };
}

function renderHeatmapGrid(countMap, dueByDate) {
  const weeks = 8;
  const cellHeight = 26;
  const today = kstNow();
  const todayMonday = startOfWeekMonday(today);
  const startMonday = new Date(todayMonday);
  startMonday.setDate(startMonday.getDate() - (weeks - 1) * 7);

  let cells = '';
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const day = new Date(startMonday);
      day.setDate(startMonday.getDate() + w * 7 + d);
      const ds = toDateStr(day);
      const count = countMap[ds] || 0;
      const isFuture = day > today;
      const dueThatDay = (dueByDate && dueByDate[ds]) || [];
      const missed = dueThatDay.length > 0 && !dueThatDay.every(t => t.status === 'done');

      let bg = 'var(--pill-bg)';
      let label = `${ds} · 완료 ${count}건`;
      if (!isFuture) {
        if (missed) {
          bg = 'var(--peach-bg)';
          label += ` · 마감 할일 중 미완료 있음`;
        } else if (count >= 3) bg = 'var(--mint-fg)';
        else if (count === 2) bg = '#8FC79E';
        else if (count === 1) bg = 'var(--mint-bg)';
      }
      cells += `<div title="${label}" style="height:${cellHeight}px; border-radius:5px; background:${bg};"></div>`;
    }
  }
  return `<div style="display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:5px;">${cells}</div>
    <div class="row" style="gap:12px; margin-top:8px;">
      <span class="small-muted"><span style="display:inline-block; width:10px; height:10px; border-radius:3px; background:var(--mint-fg); vertical-align:-1px; margin-right:4px;"></span>완료</span>
      <span class="small-muted"><span style="display:inline-block; width:10px; height:10px; border-radius:3px; background:var(--peach-bg); vertical-align:-1px; margin-right:4px;"></span>미완료 있음</span>
    </div>`;
}

function renderStreakPanel(logs, dueByDate) {
  const { countMap, streak } = computeStreakAndCounts(logs);
  return `<div class="info-card" style="margin-bottom:14px;">
    <div style="font-size:20px; margin-bottom:10px;">${streak}<span style="font-size:12px; color:var(--muted);"> 일 연속 완료</span></div>
    ${renderHeatmapGrid(countMap, dueByDate)}
    <div class="small-muted" style="margin-top:8px;">최근 8주</div>
  </div>`;
}

// ---------- 기록 (전체 실행기록 모아보기) ----------
function renderLogs() {
  const planOptions = state.plans.map(p => `<option value="${p.id}" ${state.logsPlanFilter === p.id ? 'selected' : ''}>${escapeHtml(p.title)}</option>`).join('');

  let logs = state.allLogs.slice();
  if (state.logsPlanFilter !== 'all') {
    logs = logs.filter(l => l.todos && l.todos.plan_id === state.logsPlanFilter);
  }

  const filterHtml = `
    <div class="row" style="margin-bottom:14px;">
      <select onchange="onLogsFilterChange(this.value)">
        <option value="all" ${state.logsPlanFilter === 'all' ? 'selected' : ''}>전체 계획</option>
        ${planOptions}
      </select>
    </div>`;

  let dueTodos = (state.allTodosForMonth || []).filter(t => t.due_date);
  if (state.logsPlanFilter !== 'all') dueTodos = dueTodos.filter(t => t.plan_id === state.logsPlanFilter);
  const dueByDate = {};
  dueTodos.forEach(t => { (dueByDate[t.due_date] = dueByDate[t.due_date] || []).push(t); });

  const streakHtml = renderStreakPanel(logs, dueByDate);

  if (!logs.length) {
    return filterHtml + streakHtml + `<div class="small-muted">아직 완료 기록이 없어요. 할일 탭에서 완료 처리를 하면 여기 쌓여요.</div>`;
  }

  const groups = {};
  logs.forEach(l => {
    const dateKey = toDateStr(new Date(l.ended_at));
    (groups[dateKey] = groups[dateKey] || []).push(l);
  });
  const orderedDates = Object.keys(groups).sort((a, b) => a < b ? 1 : -1);

  const body = orderedDates.map(dateKey => {
    const dayTotalMin = groups[dateKey].reduce((s, l) => s + (l.actual_minutes || 0), 0);
    const items = groups[dateKey].map(l => {
      const todo = l.todos || {};
      const plan = todo.plans || {};
      const c = COLORS[plan.color] || COLORS.mint;
      const timeStr = new Date(l.ended_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      const hoursStr = (l.actual_minutes / 60).toFixed(1).replace(/\.0$/, '');
      return `<div class="row" style="align-items:flex-start; margin-bottom:8px;">
        <span class="small-muted" style="width:44px; flex-shrink:0;">${timeStr}</span>
        <div class="grow">
          <div style="font-size:13px;">${escapeHtml(todo.title || '(지워진 할 일)')}</div>
          <div class="small-muted">
            <span style="color:${c.fg};">${escapeHtml(plan.title || '')}</span> · ${hoursStr}시간
            ${l.blocker_reason ? ` · 막힘: ${escapeHtml(l.blocker_reason)}` : ''}
          </div>
        </div>
        <button class="icon-btn" aria-label="실행 기록 수정" onclick="openEditLogModal('${l.id}')"><i class="ti ti-edit"></i></button>
      </div>`;
    }).join('');
    return `<div style="margin-bottom:16px;">
      <div class="row" style="margin-bottom:8px; border-bottom:1px solid var(--pill-bg); padding-bottom:4px;">
        <span style="font-size:12px; color:var(--muted);" class="grow">${dateKey}</span>
        <span style="font-size:12px; color:var(--muted);">그날 합계 ${dayTotalMin}분</span>
      </div>
      ${items}
    </div>`;
  }).join('');

  const grandTotalMin = logs.reduce((s, l) => s + (l.actual_minutes || 0), 0);
  const dayCount = orderedDates.length;
  const avgMin = dayCount ? Math.round((grandTotalMin / dayCount) * 10) / 10 : 0;
  const summaryHtml = `<div class="info-card" style="margin-bottom:14px;">
    <div class="small-muted" style="margin-bottom:4px;">지금 이 목록(위 필터 기준) 전체</div>
    <div style="font-size:14px;">총 ${grandTotalMin}분 · 기록 있는 날 ${dayCount}일 · 하루 평균 ${avgMin}분</div>
  </div>`;

  return filterHtml + streakHtml + summaryHtml + body;
}

function onLogsFilterChange(v) { state.logsPlanFilter = v; render(); }

function openEditLogModal(logId) {
  const log = state.allLogs.find(l => l.id === logId);
  if (!log) return;
  document.getElementById('dayModalCard').innerHTML = `
    <div style="font-size:15px; margin-bottom:14px;">실행 기록 수정</div>
    <div class="field-group"><label>실제로 걸린 시간(분)</label><input id="el-minutes" type="number" value="${log.actual_minutes}"></div>
    <div class="field-group"><label>막힌 점 (선택)</label><textarea id="el-blocker" rows="3" placeholder="없으면 비워두세요">${escapeHtml(log.blocker_reason || '')}</textarea></div>
    <div class="row" style="justify-content:flex-end; margin-top:10px;">
      <button class="btn btn-ghost" onclick="closeDayModal()">취소</button>
      <button class="btn btn-dark" onclick="confirmEditLog('${logId}')">저장</button>
    </div>`;
  document.getElementById('dayModalOverlay').classList.add('show');
  document.getElementById('page').classList.add('faded');
}

async function confirmEditLog(logId) {
  const minutes = Number(document.getElementById('el-minutes').value) || 0;
  const blocker = document.getElementById('el-blocker').value.trim() || null;
  const { error } = await sb.from('execution_logs').update({ actual_minutes: minutes, blocker_reason: blocker }).eq('id', logId);
  if (error) { pdsAlert('수정 실패: ' + error.message); return; }
  closeDayModal();
  await refreshAndRender();
}

function renderTodos() {
  const plan = state.plans.find(p => p.id === state.currentPlanId);
  if (!plan) {
    return `<div class="small-muted" style="margin-bottom:10px;">먼저 계획을 만들어야 할 일을 추가할 수 있어요.</div>
      <span class="btn btn-ghost" onclick="switchTab('plans')" style="font-size:12px;">계획 탭으로 가기 →</span>`;
  }

  let list = state.todos.slice();
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter(t => t.title.toLowerCase().includes(q));
  }
  if (state.statusFilter !== 'all') list = list.filter(t => t.status === state.statusFilter);
  if (state.reviewFilter === 'done') list = list.filter(t => t.status === 'done');
  if (state.reviewFilter === 'delayed') {
    const todayStr = toDateStr(kstNow());
    list = list.filter(t => t.status !== 'done' && t.due_date && t.due_date < todayStr);
  }
  state.reviewFilter = null; // 1회성 드릴다운

  list.sort((a, b) => {
    const ad = a.due_date || '9999-99-99', bd = b.due_date || '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;
    const pr = prioRank(a.priority) - prioRank(b.priority);
    if (pr !== 0) return pr;
    return a.id < b.id ? -1 : 1;
  });

  const c = COLORS[plan.color] || COLORS.mint;

  const rows = list.map(t => `
    <div class="todo-row">
      <span class="todo-check" style="background:${t.status === 'done' ? c.bg : 'var(--pill-bg)'}"
        onclick="toggleComplete('${t.id}')">
        ${t.status === 'done' ? `<i class="ti ti-check" style="font-size:12px;color:${c.fg}"></i>` : ''}
      </span>
      <div class="grow">
        <div style="font-size:13px; ${t.status === 'done' ? 'text-decoration:line-through;color:var(--faint);' : ''}">${escapeHtml(t.title)}</div>
        <div class="small-muted">${t.due_date || '마감 없음'} · ${prioLabel(t.priority)} ${(t.tags || []).map(tag => `· ${escapeHtml(tag)}`).join(' ')}</div>
      </div>
      <button class="icon-btn" aria-label="할 일 수정" onclick="openEditTodoModal('${t.id}')"><i class="ti ti-edit"></i></button>
      <button class="icon-btn danger" aria-label="할 일 삭제" onclick="removeTodo('${t.id}')"><i class="ti ti-trash"></i></button>
    </div>
  `).join('');

  return `
    ${renderPlanSelector(false)}
    <div class="row" style="margin-bottom:6px;">
      <div class="plan-color-dot" style="background:${c.fg}"></div>
      <div style="font-size:13px;" class="small-muted grow">${escapeHtml(plan.title)}의 할 일</div>
    </div>
    <div style="margin-top:10px;">
      <div class="row" style="margin-bottom:8px;">
        <input class="grow" placeholder="할 일 검색" value="${escapeAttr(state.search)}" oninput="onSearchInput(this.value)">
        <select onchange="onFilterChange(this.value)">
          <option value="all">전체</option>
          <option value="in_progress">진행중</option>
          <option value="done">완료</option>
        </select>
        <button class="btn btn-ghost" aria-label="할 일 추가" onclick="toggleTodoForm(true)"><i class="ti ti-plus"></i></button>
      </div>
      <div class="small-muted" style="margin-bottom:10px;">정렬 기준: 마감일 → 우선순위 → 등록순</div>
      ${state.showTodoForm ? renderTodoForm() : ''}
      ${rows || '<div class="small-muted">할 일이 없어요. 마감일을 정해서 추가하면 달력에도 표시돼요.</div>'}
    </div>`;
}

function onSearchInput(v) { state.search = v; render(); }
function onFilterChange(v) { state.statusFilter = v; render(); }
function toggleTodoForm(v) { state.showTodoForm = v; render(); }

function renderTodoForm() {
  const planOptions = state.plans.map(p => `<option value="${p.id}" ${p.id === state.currentPlanId ? 'selected' : ''}>${escapeHtml(p.title)}</option>`).join('');
  return `<div class="info-card">
    <div class="field-group"><label>계획</label><select id="tf-plan">${planOptions}</select></div>
    <div class="field-group"><label>제목</label><input id="tf-title"></div>
    <div class="row">
      <div class="field-group grow"><label>마감일</label><input id="tf-due" type="date"></div>
      <div class="field-group grow"><label>우선순위</label>
        <select id="tf-priority"><option value="high">높음</option><option value="medium" selected>중간</option><option value="low">낮음</option></select>
      </div>
    </div>
    <div class="row">
      <div class="field-group grow"><label>태그(쉼표로 구분)</label><input id="tf-tags"></div>
      <div class="field-group grow"><label>예상 시간(시간)</label><input id="tf-hours" type="number" step="0.25"></div>
    </div>
    <div class="row">
      <button class="btn btn-dark" onclick="submitTodoForm(this)">추가</button>
      <button class="btn btn-ghost" onclick="toggleTodoForm(false)">취소</button>
    </div>
  </div>`;
}

async function submitTodoForm(btn) {
  if (btn) { if (btn.disabled) return; btn.disabled = true; }
  const title = document.getElementById('tf-title').value.trim();
  if (!title) { pdsAlert('제목을 입력하세요.'); if (btn) btn.disabled = false; return; }
  const selectedPlanId = document.getElementById('tf-plan').value;
  const payload = {
    plan_id: selectedPlanId,
    title,
    due_date: document.getElementById('tf-due').value || null,
    priority: document.getElementById('tf-priority').value,
    tags: document.getElementById('tf-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    estimated_hours: Number(document.getElementById('tf-hours').value) || null,
  };
  const ok = await createTodo(payload);
  if (!ok) { if (btn) btn.disabled = false; return; }
  state.showTodoForm = false;
  state.currentPlanId = selectedPlanId; // 방금 추가한 할 일이 속한 계획으로 전환해서 바로 보여줌
  await refreshAndRender();
}

function findTodoAnywhere(id) {
  return state.todos.find(x => x.id === id) || (state.allTodosForMonth || []).find(x => x.id === id);
}

async function toggleComplete(id) {
  const t = findTodoAnywhere(id);
  if (!t) return;
  if (t.status === 'done') {
    await uncompleteTodo(t);
    await refreshAndRender();
    return;
  }
  openCompleteModal(id);
}

function openCompleteModal(todoId) {
  const t = findTodoAnywhere(todoId);
  if (!t) return;
  const defaultMinutes = t.estimated_hours ? Math.round(t.estimated_hours * 60) : 30;
  document.getElementById('dayModalCard').innerHTML = `
    <div style="font-size:15px; margin-bottom:14px;">${escapeHtml(t.title)} 완료</div>
    <div class="field-group"><label>실제로 걸린 시간(분)</label><input id="cm-minutes" type="number" value="${defaultMinutes}"></div>
    <div class="field-group"><label>막힌 점이 있었다면 (선택)</label><textarea id="cm-blocker" rows="3" placeholder="없으면 비워두세요"></textarea></div>
    <div class="row" style="margin-top:10px; justify-content:flex-end;">
      <button class="btn btn-ghost" onclick="closeDayModal()">취소</button>
      <button class="btn btn-dark" onclick="confirmCompleteModal('${todoId}')">완료로 표시</button>
    </div>`;
  document.getElementById('dayModalOverlay').classList.add('show');
  document.getElementById('page').classList.add('faded');
}

async function confirmCompleteModal(todoId) {
  const t = findTodoAnywhere(todoId);
  if (!t) return;
  const minutes = Number(document.getElementById('cm-minutes').value) || 0;
  const blocker = document.getElementById('cm-blocker').value.trim() || null;
  const ok = await performComplete(t, minutes, blocker);
  if (!ok) return; // 실패 시 에러 팝업이 그대로 떠 있게 둠
  closeDayModal();
  await refreshAndRender();
}

function openEditTodoModal(id) {
  const t = state.todos.find(x => x.id === id);
  if (!t) return;
  document.getElementById('dayModalCard').innerHTML = `
    <div style="font-size:15px; margin-bottom:14px;">할 일 수정</div>
    <div class="field-group"><label>제목</label><input id="et-title" value="${escapeAttr(t.title)}"></div>
    <div class="row">
      <div class="field-group grow"><label>마감일</label><input id="et-due" type="date" value="${t.due_date || ''}"></div>
      <div class="field-group grow"><label>우선순위</label>
        <select id="et-priority">
          <option value="high" ${t.priority === 'high' ? 'selected' : ''}>높음</option>
          <option value="medium" ${t.priority === 'medium' ? 'selected' : ''}>중간</option>
          <option value="low" ${t.priority === 'low' ? 'selected' : ''}>낮음</option>
        </select>
      </div>
    </div>
    <div class="row">
      <div class="field-group grow"><label>태그(쉼표로 구분)</label><input id="et-tags" value="${escapeAttr((t.tags || []).join(', '))}"></div>
      <div class="field-group grow"><label>예상 시간(시간)</label><input id="et-hours" type="number" step="0.25" value="${t.estimated_hours || ''}"></div>
    </div>
    <div class="row" style="justify-content:flex-end; margin-top:10px;">
      <button class="btn btn-ghost" onclick="closeDayModal()">취소</button>
      <button class="btn btn-dark" onclick="confirmEditTodo('${id}')">저장</button>
    </div>`;
  document.getElementById('dayModalOverlay').classList.add('show');
  document.getElementById('page').classList.add('faded');
}

async function confirmEditTodo(id) {
  const title = document.getElementById('et-title').value.trim();
  if (!title) { pdsAlert('제목을 입력하세요.'); return; }
  const payload = {
    title,
    due_date: document.getElementById('et-due').value || null,
    priority: document.getElementById('et-priority').value,
    tags: document.getElementById('et-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    estimated_hours: Number(document.getElementById('et-hours').value) || null,
  };
  const ok = await updateTodo(id, payload);
  if (!ok) return; // 실패 시 에러 팝업이 그대로 떠 있게 둠
  closeDayModal();
  await refreshAndRender();
}

function removeTodo(id) {
  pdsConfirm('이 할 일을 지울까요?', async () => {
    await deleteTodo(id);
    await refreshAndRender();
  });
}

// ---------- 돌아보기 ----------
function renderPeriodReviewSection() {
  const { start, end } = getPeriodRange(state.reviewPeriodType, state.reviewPeriodAnchor);
  const label = state.reviewPeriodType === 'weekly'
    ? `${toDateStr(start)} ~ ${toDateStr(end)}`
    : `${start.getFullYear()}년 ${start.getMonth() + 1}월`;

  const groups = state.periodGroups.map(g => {
    const c = COLORS[(g.plan && g.plan.color) || 'mint'];
    const items = g.items.slice().sort((a, b) => (a.due_date || '').localeCompare(b.due_date || '')).map(t => {
      const icon = t.status === 'done'
        ? `<i class="ti ti-check" style="color:${c.fg}"></i>`
        : `<i class="ti ti-x" style="color:var(--faint)"></i>`;
      return `<div class="row" style="margin-bottom:4px;">${icon}<span style="font-size:13px; ${t.status === 'done' ? 'text-decoration:line-through;color:var(--faint);' : ''}">${escapeHtml(t.title)}</span>
        <span class="small-muted" style="margin-left:auto;">${t.due_date || ''}</span></div>`;
    }).join('');
    return `<div style="margin-bottom:14px;">
      <div style="display:inline-block; background:${c.bg}; color:${c.fg}; font-size:11px; padding:3px 10px; border-radius:6px; margin-bottom:8px;">${escapeHtml((g.plan && g.plan.title) || '삭제된 계획')}</div>
      ${items}
    </div>`;
  }).join('');

  return `
    <div class="row" style="margin-bottom:10px;">
      <div class="tab ${state.reviewPeriodType === 'weekly' ? 'active' : ''}" style="font-size:12px; padding:6px 14px;" onclick="setReviewPeriodType('weekly')">주간</div>
      <div class="tab ${state.reviewPeriodType === 'monthly' ? 'active' : ''}" style="font-size:12px; padding:6px 14px;" onclick="setReviewPeriodType('monthly')">월간</div>
      <span class="grow"></span>
      <button class="btn btn-ghost" aria-label="이전 기간" onclick="shiftReviewPeriod(-1)"><i class="ti ti-chevron-left"></i></button>
      <button class="btn btn-ghost" aria-label="다음 기간" onclick="shiftReviewPeriod(1)"><i class="ti ti-chevron-right"></i></button>
    </div>
    <div style="font-size:14px; margin-bottom:12px;">${label}</div>
    ${groups || `<div class="small-muted" style="margin-bottom:12px;">이 기간에 마감일이 있는 할 일이 없어요.</div>`}
    <div class="small-muted" style="margin-bottom:6px;">${state.reviewPeriodType === 'weekly' ? '이번 주' : '이번 달'} 리뷰</div>
    <textarea id="periodReviewNote" rows="4" style="width:100%; margin-bottom:8px;" placeholder="자유롭게 소감을 적어보세요">${escapeHtml(state.periodReviewNote)}</textarea>
    <button class="btn btn-dark" onclick="savePeriodReview()">저장</button>
  `;
}

function setReviewPeriodType(type) {
  state.reviewPeriodType = type;
  refreshReviewPeriod();
}
function shiftReviewPeriod(delta) {
  const d = new Date(state.reviewPeriodAnchor);
  if (state.reviewPeriodType === 'weekly') d.setDate(d.getDate() + delta * 7);
  else d.setMonth(d.getMonth() + delta);
  state.reviewPeriodAnchor = d;
  refreshReviewPeriod();
}
async function refreshReviewPeriod() {
  await loadPeriodReviewData();
  render();
}

async function savePeriodReview() {
  const note = document.getElementById('periodReviewNote').value.trim();
  if (!note) { pdsAlert('내용을 적어주세요.'); return; }
  const { start, end } = getPeriodRange(state.reviewPeriodType, state.reviewPeriodAnchor);
  const payload = {
    period_type: state.reviewPeriodType,
    period_start: toDateStr(start),
    period_end: toDateStr(end),
    note,
    updated_at: new Date().toISOString(),
  };
  if (state.periodReviewId) {
    const { error } = await sb.from('period_reviews').update(payload).eq('id', state.periodReviewId);
    if (error) { pdsAlert('저장 실패: ' + error.message); return; }
  } else {
    const { data, error } = await sb.from('period_reviews').insert(payload).select().single();
    if (error) { pdsAlert('저장 실패: ' + error.message); return; }
    state.periodReviewId = data.id;
  }
  render();
}

function renderReview() {
  const subToggle = `
    <div class="row" style="margin-bottom:14px;">
      <div class="tab ${state.reviewSubView === 'period' ? 'active' : ''}" style="font-size:12px; padding:6px 14px;" onclick="setReviewSubView('period')">기간 리뷰</div>
      <div class="tab ${state.reviewSubView === 'logs' ? 'active' : ''}" style="font-size:12px; padding:6px 14px;" onclick="setReviewSubView('logs')">전체 기록</div>
    </div>`;

  if (state.reviewSubView === 'logs') {
    return subToggle + renderLogs();
  }

  const plan = state.plans.find(p => p.id === state.currentPlanId);
  const periodSection = renderPeriodReviewSection();
  const planPickerHtml = state.plans.length ? renderPlanSelector(false) : '';

  if (!plan) return subToggle + `<div class="small-muted" style="margin-bottom:16px;">계획별 돌아보기를 보려면 계획을 먼저 만들어주세요.</div>` + planPickerHtml + periodSection;
  const s = state.reviewStats || { planCount: 0, doneCount: 0, delayedCount: 0, blockedCount: 0, estimatedTotal: 0, actualTotal: 0, diff: 0 };
  const { planCount, doneCount, delayedCount, blockedCount, estimatedTotal, actualTotal, diff } = s;

  return subToggle + `
    <div style="font-size:15px; margin-bottom:10px;">계획별 돌아보기</div>
    ${planPickerHtml}
    <div class="review-stats">
      <div class="review-stat" style="background:#FAF7F0;" onclick="drillDown('all')"><div class="num">${planCount}</div><div class="lbl small-muted">계획수</div></div>
      <div class="review-stat" style="background:var(--mint-bg);" onclick="drillDown('done')"><div class="num" style="color:var(--mint-fg)">${doneCount}</div><div class="lbl" style="color:var(--mint-fg)">완료</div></div>
      <div class="review-stat" style="background:var(--peach-bg);" onclick="drillDown('delayed')"><div class="num" style="color:var(--peach-fg)">${delayedCount}</div><div class="lbl" style="color:var(--peach-fg)">지연</div></div>
      <div class="review-stat" style="background:var(--butter-bg);" onclick="drillDown('blocked')"><div class="num" style="color:var(--butter-fg)">${blockedCount}</div><div class="lbl" style="color:var(--butter-fg)">막힘</div></div>
    </div>
    <div class="small-muted" style="margin-bottom:16px;">예상 ${estimatedTotal.toFixed(1)}h · 실제 ${actualTotal.toFixed(1)}h · 차이 ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}h</div>
    <div class="small-muted" style="margin-bottom:6px;">고칠 점 한 줄</div>
    <input id="reviewNote" class="grow" style="width:100%; margin-bottom:10px;" placeholder="다음 계획에 넘길 한 줄">
    <button class="btn btn-dark" onclick="submitReview()">다음 계획으로 넘기기</button>
    <div style="border-top:1px solid var(--pill-bg); margin:20px 0;"></div>
    ${periodSection}
  `;
}

function setReviewSubView(v) { state.reviewSubView = v; render(); }

async function drillDown(kind) {
  state.reviewFilter = kind === 'all' ? null : kind;
  await switchTab('todos');
}

async function submitReview() {
  const note = document.getElementById('reviewNote').value.trim();
  if (!note) { pdsAlert('고칠 점을 한 줄 적어주세요.'); return; }
  const plan = state.plans.find(p => p.id === state.currentPlanId);
  const created = await createReview({
    plan_id: plan.id, period_start: plan.period_start, period_end: plan.period_end, improvement_note: note,
  });
  if (created) {
    state.lastReviewId = created.id;
    state.showPlanForm = true;
    pdsAlert('고칠 점을 저장했어요. 이어서 다음 계획을 만들어보세요 — 계획 탭에 새 계획 입력창을 열어둘게요.');
    await switchTab('plans');
  }
}

// ---------- 설정 ----------
function renderSettings() {
  return `
    <div style="font-size:15px; margin-bottom:12px;">설정</div>
    <div class="info-card" style="margin-bottom:14px;">
      <div><span class="k">로그인 계정</span> &nbsp; ${escapeHtml(currentUser ? currentUser.email : '')}</div>
    </div>
    <div style="margin-bottom:16px;">
      <button class="btn btn-dark" onclick="exportAllData()"><i class="ti ti-download"></i> 내 자료 내보내기</button>
    </div>
    <div style="border-top:1px solid var(--pill-bg); padding-top:14px;">
      <div class="small-muted" style="margin-bottom:8px;">계정을 지우면 계획·할일·실행기록 등 내 자료가 전부 삭제됩니다(되돌릴 수 없음). 로그인 정보(이메일/비밀번호) 자체는 별도 요청 없이는 남아있어요 — 이건 관리자 권한이 필요한 작업이라 이 화면에서는 처리하지 않습니다.</div>
      <button class="icon-btn danger" style="width:auto; padding:8px 16px; gap:6px;" onclick="confirmDeleteAccountData()"><i class="ti ti-trash"></i> 내 자료 전체 삭제</button>
    </div>
  `;
}

function confirmDeleteAccountData() {
  pdsConfirm('정말로 내 자료(계획·할일·실행기록·리뷰 등)를 전부 지울까요? 되돌릴 수 없어요.', async () => {
    pdsLoadingStart();
    const tables = ['execution_logs', 'plan_history', 'todos', 'reviews', 'period_reviews', 'plans'];
    let hadError = false;
    for (const t of tables) {
      const { error } = await sb.from(t).delete().eq('user_id', currentUser.id);
      if (error) { hadError = true; console.error(t, error); }
    }
    pdsLoadingEnd();
    if (hadError) {
      pdsAlert('일부 자료 삭제 중 오류가 있었어요. 콘솔을 확인해주세요.');
    } else {
      pdsAlert('내 자료가 모두 삭제됐어요. 로그아웃할게요.');
      await sb.auth.signOut();
    }
  });
}

async function exportAllData() {
  if (!sb) { pdsAlert('Supabase 설정이 필요해요.'); return; }
  pdsLoadingStart();
  const [plans, planHistory, todos, logs, reviews] = await Promise.all([
    sb.from('plans').select('*'),
    sb.from('plan_history').select('*'),
    sb.from('todos').select('*'),
    sb.from('execution_logs').select('*'),
    sb.from('reviews').select('*'),
  ]);
  pdsLoadingEnd();
  const exportData = {
    exported_at: new Date().toISOString(),
    plans: plans.data, plan_history: planHistory.data, todos: todos.data,
    execution_logs: logs.data, reviews: reviews.data,
  };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pds-export-${toDateStr(kstNow())}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- 유틸 ----------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------- 시작 ----------
(async function boot() {
  document.getElementById('tab-calendar').classList.add('active');
  const ok = initSupabase();
  if (!ok) {
    document.getElementById('page').innerHTML = '<div class="small-muted">Supabase 설정 후 새로고침 해주세요.</div>';
    return;
  }

  sb.auth.onAuthStateChange(async (event, session) => {
    const wasLoggedIn = !!currentUser;
    currentUser = session ? session.user : null;
    updateAuthUI();
    if (currentUser && !wasLoggedIn) {
      // 방금 로그인/가입 확인됨 → 내 데이터 불러오기 시작
      await loadPlans();
      await refreshAndRender();
    }
    if (!currentUser && wasLoggedIn) {
      // 로그아웃 → 캐시 비우기
      state.plans = [];
      state.todos = [];
      state.allTodosForMonth = [];
      state.allLogs = [];
      state.currentPlanId = null;
    }
  });

  const { data: { session } } = await sb.auth.getSession();
  currentUser = session ? session.user : null;
  updateAuthUI();
  if (currentUser) {
    await loadPlans();
    await refreshAndRender();
  }
})();
