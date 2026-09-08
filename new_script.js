<script>
let team = [];
let expectations = [];
let signals = [];

let selectedPersonId = null;
let currentPeriod = "30";
let detailTab = "signals";
let toastTimer;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const personById = id => team.find(person => person.id === id);
const expectationById = id => expectations.find(expectation => expectation.id === id);
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));

function periodSignals() {
  if (currentPeriod === "all") return signals;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Number(currentPeriod));
  return signals.filter(signal => new Date(signal.date) >= cutoff);
}

function formatDate(date, withTime = false) {
  const value = new Date(date);
  const options = withTime
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric" };
  return new Intl.DateTimeFormat("en", options).format(value);
}

function relativeDate(date) {
  const diff = Math.max(0, Date.now() - new Date(date).getTime());
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return formatDate(date);
}

function sourceIcon(source) {
  return source === "jira" ? "jira" : source === "slack" ? "slack" : "note";
}

function sourceName(source) {
  return source === "jira" ? "Jira" : source === "slack" ? "Slack" : "Manual";
}

function groupedSignals(list, keyFn) {
  return list.reduce((groups, signal) => {
    const key = keyFn(signal);
    (groups[key] ||= []).push(signal);
    return groups;
  }, {});
}

function avatar(person, mini = false) {
  if (!person) return mini ? `<span class="mini-avatar" title="Unknown">?</span>` : `<span class="avatar">?</span>`;
  if (mini) return `<span class="mini-avatar ${person.color}" title="${escapeHtml(person.name)}">${person.initials}</span>`;
  return `<span class="avatar ${person.color}">${person.initials}</span>`;
}

function renderSummary() {
  const visible = periodSignals();
  const open = visible.filter(signal => signal.status === "open");
  const affectedPeople = new Set(open.map(signal => signal.personId)).size;
  const groups = groupedSignals(visible, signal => `${signal.personId}:${signal.expectationId}`);
  const repeats = Object.values(groups).filter(group => group.length >= 2).length;
  const latestWeek = visible.filter(signal => Date.now() - new Date(signal.date).getTime() <= 7 * 86400000).length;
  const priorWeek = visible.filter(signal => {
    const age = Date.now() - new Date(signal.date).getTime();
    return age > 7 * 86400000 && age <= 14 * 86400000;
  }).length;
  const trend = latestWeek - priorWeek;
  $("#summaryGrid").innerHTML = `
    <article class="summary-card">
      <div class="summary-card-head"><p>People needing follow-up</p><span class="summary-icon violet"><svg><use href="#icon-users"></use></svg></span></div>
      <strong>${affectedPeople}</strong><div class="summary-meta">of ${team.length} current team members</div>
    </article>
    <article class="summary-card">
      <div class="summary-card-head"><p>Open signals</p><span class="summary-icon red"><svg><use href="#icon-activity"></use></svg></span></div>
      <strong>${open.length}</strong><div class="summary-meta">${trend >= 0 ? "+" : ""}${trend} compared with last week</div>
    </article>
    <article class="summary-card">
      <div class="summary-card-head"><p>Repeated patterns</p><span class="summary-icon amber"><svg><use href="#icon-activity"></use></svg></span></div>
      <strong>${repeats}</strong><div class="summary-meta">same person + expectation, 2× or more</div>
    </article>
    <article class="summary-card">
      <div class="summary-card-head"><p>No open signals</p><span class="summary-icon green"><svg><use href="#icon-check"></use></svg></span></div>
      <strong>${team.length - affectedPeople}</strong><div class="summary-meta">across the selected period</div>
    </article>`;
}

function renderPeople() {
  const query = $("#peopleSearch").value.trim().toLowerCase();
  const visible = periodSignals();
  const filteredTeam = team.filter(person => `${person.name} ${person.role}`.toLowerCase().includes(query));
  $("#peopleList").innerHTML = filteredTeam.map(person => {
    const openCount = visible.filter(signal => signal.personId === person.id && signal.status === "open").length;
    return `<button class="person-row ${person.id === selectedPersonId ? "active" : ""}" data-person="${person.id}">
      ${avatar(person)}
      <span class="person-copy"><strong>${escapeHtml(person.name)}</strong><span>${escapeHtml(person.role)}</span></span>
      <span class="signal-count ${openCount ? "has-signals" : ""}">${openCount}</span>
      <svg class="chevron"><use href="#icon-chevron"></use></svg>
    </button>`;
  }).join("") || `<div class="empty-state"><div><h3>No people found</h3><p>Try another name or role.</p></div></div>`;
  renderPersonDetail();
}

function renderPersonDetail() {
  const person = personById(selectedPersonId) || team[0];
  if (!person) {
    $("#personDetail").innerHTML = `<div class="empty-state"><div><h3>No signals recorded yet</h3><p>Flag a missed expectation in Jira or Slack, and it will show up here.</p></div></div>`;
    return;
  }
  const list = periodSignals().filter(signal => signal.personId === person.id).sort((a,b) => new Date(b.date) - new Date(a.date));
  const groups = Object.entries(groupedSignals(list, signal => signal.expectationId))
    .map(([expectationId, items]) => ({ expectation: expectationById(expectationId), items }))
    .sort((a,b) => b.items.length - a.items.length);
  const openCount = list.filter(signal => signal.status === "open").length;
  const content = detailTab === "activity"
    ? renderPersonActivity(list)
    : groups.length ? groups.map(group => renderExpectationGroup(group)).join("") : `
      <div class="empty-state"><div><span class="empty-state-icon"><svg><use href="#icon-check"></use></svg></span><h3>No signals in this period</h3><p>Nothing has been recorded against ${escapeHtml(person.name)} for the selected period.</p></div></div>`;

  $("#personDetail").innerHTML = `
    <div class="detail-header">
      <div class="detail-person">${avatar(person)}<div><h2>${escapeHtml(person.name)}</h2><p>${escapeHtml(person.role)}</p><span class="capacity-pill">${escapeHtml(person.capacity)}</span></div></div>
      <div class="detail-actions">
        <button class="button secondary" data-record-person="${person.id}"><svg><use href="#icon-plus"></use></svg> Add signal</button>
        ${openCount ? `<button class="button secondary" data-discuss-all="${person.id}"><svg><use href="#icon-check"></use></svg> Mark discussed</button>` : ""}
      </div>
    </div>
    <div class="detail-tabs">
      <button class="detail-tab ${detailTab === "signals" ? "active" : ""}" data-detail-tab="signals">Expectations ${groups.length ? `(${groups.length})` : ""}</button>
      <button class="detail-tab ${detailTab === "activity" ? "active" : ""}" data-detail-tab="activity">Activity (${list.length})</button>
    </div>
    <div class="expectation-list">${content}</div>`;
}

function renderExpectationGroup({ expectation, items }) {
  if (!expectation) return "";
  const open = items.filter(item => item.status === "open").length;
  const repeated = items.length >= 2;
  const latest = [...items].sort((a,b) => new Date(b.date) - new Date(a.date))[0];
  const sources = [...new Set(items.map(item => item.source))];
  return `<article class="expectation-item">
    <div class="expectation-top">
      <div class="expectation-title"><span class="status-bar ${repeated ? "repeated" : ""}"></span><div><h3>${escapeHtml(expectation.title)}</h3><p>${escapeHtml(expectation.category)} · Last recorded ${relativeDate(latest.date)}</p></div></div>
      <div class="expectation-count"><strong>${items.length}</strong><span>${items.length === 1 ? "signal" : "signals"}</span></div>
    </div>
    <div class="expectation-footer">
      ${sources.map(source => `<span class="source-chip ${source}"><svg><use href="#icon-${sourceIcon(source)}"></use></svg>${sourceName(source)}</span>`).join("")}
      ${repeated ? `<span class="status-chip repeated">Repeated pattern</span>` : ""}
      <span class="status-chip ${open ? "open" : "discussed"}">${open ? `${open} open` : "Discussed"}</span>
      <a class="expectation-link" href="${expectation.url}" target="_blank" rel="noreferrer">View expectation <svg><use href="#icon-external"></use></svg></a>
    </div>
  </article>`;
}

function renderPersonActivity(list) {
  if (!list.length) return `<div class="empty-state"><div><span class="empty-state-icon"><svg><use href="#icon-check"></use></svg></span><h3>No activity</h3><p>No expectation signals were recorded during this period.</p></div></div>`;
  return list.map(signal => {
    const expectation = expectationById(signal.expectationId);
    if (!expectation) return "";
    return `<article class="expectation-item">
      <div class="expectation-top"><div class="expectation-title"><span class="source-chip ${signal.source}"><svg><use href="#icon-${sourceIcon(signal.source)}"></use></svg>${sourceName(signal.source)}</span><div><h3>${escapeHtml(expectation.title)}</h3><p>${escapeHtml(signal.note || "No additional context")} · ${escapeHtml(signal.by)}</p></div></div><div class="expectation-count"><strong>${formatDate(signal.date)}</strong><span>${escapeHtml(signal.reference)}</span></div></div>
    </article>`;
  }).join("");
}

function renderExpectations() {
  const query = $("#expectationsSearch").value.trim().toLowerCase();
  const visible = periodSignals();
  const rows = expectations.map(expectation => {
    const list = visible.filter(signal => signal.expectationId === expectation.id);
    const people = [...new Set(list.map(signal => signal.personId))].map(personById).filter(Boolean);
    const repeats = Object.values(groupedSignals(list, signal => signal.personId)).filter(group => group.length >= 2).length;
    return { expectation, list, people, repeats };
  }).filter(row => row.list.length && `${row.expectation.title} ${row.expectation.category}`.toLowerCase().includes(query))
    .sort((a,b) => b.list.length - a.list.length);

  $("#expectationsTable").innerHTML = `
    <div class="table-row header"><span>Expectation</span><span>Signals</span><span>People</span><span>Repeated by</span><span>Trend</span><span></span></div>
    ${rows.map(row => {
      const latestWeek = row.list.filter(signal => Date.now() - new Date(signal.date).getTime() <= 7 * 86400000).length;
      const trendDown = latestWeek === 0;
      return `<div class="table-row" data-expectation-row="${row.expectation.id}" tabindex="0" role="button">
        <div class="expectation-cell"><strong>${escapeHtml(row.expectation.title)}</strong><span>${escapeHtml(row.expectation.category)}</span></div>
        <div class="metric-cell"><strong>${row.list.length}</strong><span>${row.list.filter(signal => signal.status === "open").length} open</span></div>
        <div class="people-stack">${row.people.slice(0,3).map(person => avatar(person,true)).join("")}${row.people.length > 3 ? `<span class="mini-avatar more">+${row.people.length - 3}</span>` : ""}</div>
        <div class="metric-cell"><strong>${row.repeats}</strong><span>${row.repeats === 1 ? "person" : "people"}</span></div>
        <span class="trend ${trendDown ? "down" : ""}">${trendDown ? "↓ Quiet" : `↑ ${latestWeek} new`}</span>
        <svg class="chevron"><use href="#icon-chevron"></use></svg>
      </div>`;
    }).join("") || `<div class="empty-state"><div><h3>No expectations found</h3><p>Try a different search.</p></div></div>`}`;
}

function renderActivity() {
  const query = $("#activitySearch").value.trim().toLowerCase();
  const list = [...periodSignals()].sort((a,b) => new Date(b.date) - new Date(a.date)).filter(signal => {
    const person = personById(signal.personId);
    const expectation = expectationById(signal.expectationId);
    if (!person || !expectation) return false;
    return `${person.name} ${expectation.title} ${sourceName(signal.source)} ${signal.reference}`.toLowerCase().includes(query);
  });
  $("#activityCount").textContent = `${list.length} ${list.length === 1 ? "record" : "records"}`;
  $("#activityList").innerHTML = list.map(signal => {
    const person = personById(signal.personId);
    const expectation = expectationById(signal.expectationId);
    if (!person || !expectation) return "";
    return `<div class="activity-row" data-activity="${signal.id}" tabindex="0" role="button">
      ${avatar(person)}
      <div class="activity-main"><strong>${escapeHtml(person.name)} was tagged</strong><p>${escapeHtml(signal.note || "No additional context")}</p></div>
      <div class="activity-expectation">${escapeHtml(expectation.short)}</div>
      <span class="source-chip ${signal.source}"><svg><use href="#icon-${sourceIcon(signal.source)}"></use></svg>${sourceName(signal.source)} · ${escapeHtml(signal.reference)}</span>
      <div class="activity-date">${formatDate(signal.date, true)}<br>by ${escapeHtml(signal.by)}</div>
      <svg class="chevron"><use href="#icon-chevron"></use></svg>
    </div>`;
  }).join("") || `<div class="empty-state"><div><h3>No activity found</h3><p>Try another search term.</p></div></div>`;
}

function renderAll() {
  renderSummary();
  renderPeople();
  renderExpectations();
  renderActivity();
}

function setView(view) {
  const titles = { people: "People", expectations: "Expectations", activity: "Activity" };
  $$(".view").forEach(element => element.classList.toggle("active", element.id === `${view}View`));
  $$(".nav-item[data-view]").forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    active ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
  });
  $("#viewTitle").textContent = titles[view];
}

function openModal(personId = selectedPersonId) {
  $("#feedbackPerson").value = personId;
  $("#feedbackModal").classList.add("open");
  $("#feedbackModal").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  setTimeout(() => $("#feedbackExpectation").focus(), 30);
}

function closeModal() {
  $("#feedbackModal").classList.remove("open");
  $("#feedbackModal").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function showToast(message) {
  clearTimeout(toastTimer);
  $("#toastText").textContent = message;
  $("#toast").classList.add("show");
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 2800);
}

async function markDiscussed(personId) {
  const openIds = signals.filter(signal => signal.personId === personId && signal.status === "open").map(signal => signal.id);
  signals = signals.map(signal => signal.personId === personId ? { ...signal, status: "discussed" } : signal);
  renderAll();
  showToast(`Open signals for ${personById(personId).name} marked as discussed`);
  try {
    await fetch("/api/signals/discuss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: openIds })
    });
  } catch (err) {
    console.error("Failed to persist discussed status", err);
  }
}

function exportCsv() {
  const rows = [["Date", "Person", "Expectation", "Source", "Reference", "Recorded by", "Status", "Context"]];
  [...signals].sort((a,b) => new Date(b.date) - new Date(a.date)).forEach(signal => {
    const person = personById(signal.personId);
    const expectation = expectationById(signal.expectationId);
    rows.push([
      signal.date,
      person ? person.name : signal.personId,
      expectation ? expectation.title : signal.expectationId,
      sourceName(signal.source),
      signal.reference,
      signal.by,
      signal.status,
      signal.note
    ]);
  });
  const csv = rows.map(row => row.map(value => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "expectation-signals.csv";
  link.click();
  URL.revokeObjectURL(url);
  showToast("CSV exported");
}

function initializeForm() {
  $("#feedbackPerson").innerHTML = team.map(person => `<option value="${person.id}">${escapeHtml(person.name)} — ${escapeHtml(person.role)}</option>`).join("");
  $("#feedbackExpectation").innerHTML = expectations.map(expectation => `<option value="${expectation.id}">${escapeHtml(expectation.title)}</option>`).join("");
}

document.addEventListener("click", event => {
  const nav = event.target.closest("[data-view]");
  if (nav) setView(nav.dataset.view);

  const personRow = event.target.closest("[data-person]");
  if (personRow) {
    selectedPersonId = personRow.dataset.person;
    detailTab = "signals";
    renderPeople();
  }

  const detailTabButton = event.target.closest("[data-detail-tab]");
  if (detailTabButton) {
    detailTab = detailTabButton.dataset.detailTab;
    renderPersonDetail();
  }

  const record = event.target.closest("[data-record-person]");
  if (record) openModal(record.dataset.recordPerson);

  const discuss = event.target.closest("[data-discuss-all]");
  if (discuss) markDiscussed(discuss.dataset.discussAll);

  const expectationRow = event.target.closest("[data-expectation-row]");
  if (expectationRow) {
    const expectation = expectationById(expectationRow.dataset.expectationRow);
    if (expectation) showToast(`${expectation.short}: aggregated across the team`);
  }

  const activityRow = event.target.closest("[data-activity]");
  if (activityRow) {
    const signal = signals.find(item => item.id === activityRow.dataset.activity);
    if (signal) showToast(`${sourceName(signal.source)} source: ${signal.reference}`);
  }
});

$("#addFeedbackButton").addEventListener("click", () => openModal());
$("#closeModalButton").addEventListener("click", closeModal);
$("#cancelModalButton").addEventListener("click", closeModal);
$("#feedbackModal").addEventListener("click", event => { if (event.target === $("#feedbackModal")) closeModal(); });
document.addEventListener("keydown", event => { if (event.key === "Escape") closeModal(); });
$("#peopleSearch").addEventListener("input", renderPeople);
$("#expectationsSearch").addEventListener("input", renderExpectations);
$("#activitySearch").addEventListener("input", renderActivity);
$("#exportButton").addEventListener("click", exportCsv);
$("#settingsButton").addEventListener("click", () => showToast("Integration settings would live here"));
$("#filterButton").addEventListener("click", () => showToast("Showing current team members only"));

$$('[data-period]').forEach(button => button.addEventListener("click", () => {
  currentPeriod = button.dataset.period;
  $$('[data-period]').forEach(item => item.classList.toggle("active", item === button));
  renderAll();
}));

$("#feedbackSource").addEventListener("change", event => {
  const source = event.target.value;
  const label = source === "jira" ? "The Jira bot will add a comment with a link to the handbook." : source === "slack" ? "This will be saved on the dashboard (Slack posting from here isn't wired up yet)." : "Manual notes are recorded only in this dashboard.";
  $("#notifyHelp").textContent = label;
  $("#feedbackNotify").disabled = source === "manual";
  $("#feedbackNotify").checked = source !== "manual";
});

$("#feedbackForm").addEventListener("submit", async event => {
  event.preventDefault();
  const personId = $("#feedbackPerson").value;
  const expectationId = $("#feedbackExpectation").value;
  const source = $("#feedbackSource").value;
  const reference = $("#feedbackReference").value.trim();
  const note = $("#feedbackNote").value.trim();
  const notify = $("#feedbackNotify").checked;

  const submitButton = event.target.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    const res = await fetch("/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personId, expectationId, source, reference, note, notify })
    });
    const data = await res.json();
    if (data.signal) signals.unshift(data.signal);
    selectedPersonId = personId;
    detailTab = "signals";
    event.target.reset();
    $("#feedbackNotify").checked = true;
    closeModal();
    setView("people");
    renderAll();
    const person = personById(personId);
    const expectation = expectationById(expectationId);
    showToast(`${person ? person.name : "Signal"} tagged: ${expectation ? expectation.short : ""}`);
  } catch (err) {
    console.error(err);
    showToast("Failed to save. Try again.");
  } finally {
    submitButton.disabled = false;
  }
});

async function bootstrap() {
  try {
    const res = await fetch("/api/data");
    const data = await res.json();
    team = data.team || [];
    expectations = data.expectations || [];
    signals = data.signals || [];
    selectedPersonId = team[0] ? team[0].id : null;
    initializeForm();
    renderAll();
  } catch (err) {
    console.error("Failed to load dashboard data", err);
    $("#peopleList").innerHTML = `<div class="empty-state"><div><h3>Could not load data</h3><p>Check that the server is running and Jira/Confluence credentials are set.</p></div></div>`;
  }
}

bootstrap();

  </script>
