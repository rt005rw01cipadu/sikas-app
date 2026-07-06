/* ═══════════════════════════════════════════════
   SiKAS — app.js
   Mendukung 4 jenis iuran: Kas, RMD, Konsumsi, Dana 17n
═══════════════════════════════════════════════ */

const API_URL = "https://script.google.com/macros/s/AKfycbxWbojVa6ypkWE434tjiX5qjXS13ZOTheFKGp-d2frKtKp9VZk18W8r3OMVf_wRdN4n/exec";

const BULAN_LIST = ["Januari","Februari","Maret","April","Mei","Juni",
                    "Juli","Agustus","September","Oktober","November","Desember"];
const BULAN_INI  = BULAN_LIST[new Date().getMonth()];
const TAHUN_INI  = new Date().getFullYear();

// ── CACHE ────────────────────────────────────────────────────────────────
const CACHE_KEY    = "sikas_cache";
const CACHE_EXPIRY = 60 * 60 * 1000;
let logoutTimer    = null;

function setCache(key, data) {
  try { localStorage.setItem(`${CACHE_KEY}_${key}`, JSON.stringify({ timestamp: Date.now(), data })); } catch(e) {}
}
function getCache(key) {
  try {
    const cached = localStorage.getItem(`${CACHE_KEY}_${key}`);
    if (!cached) return null;
    const cache = JSON.parse(cached);
    if (Date.now() - cache.timestamp > CACHE_EXPIRY) { localStorage.removeItem(`${CACHE_KEY}_${key}`); return null; }
    return cache.data;
  } catch(e) { return null; }
}
function clearCache() {
  try { Object.keys(localStorage).forEach(k => { if (k.startsWith(CACHE_KEY)) localStorage.removeItem(k); }); } catch(e) {}
}

// ── STATE ────────────────────────────────────────────────────────────────
let session          = JSON.parse(sessionStorage.getItem("sikas_session") || "null");
let allAnggota       = [];
let currentAnggota   = null;
let currentTunggakan = null;
let fromPage         = "cari";
let cariData         = [];
let laporanPeriodeAktif = "";

const PAGE_SIZE = 5;
const pgState = {
  dashboard: { page: 1, data: [] },
  cari:      { page: 1, data: [] },
  bayar:     { page: 1, data: [] },
  laporan:   { page: 1, data: [] },
};

function hasIuranWajib(a) {
  return !!(a && (a.ikut_kas || a.ikut_rmd || a.ikut_konsumsi || a.ikut_dana_17n));
}
function matchAnggotaKeyword(a, kw) {
  const key = String(kw || "").toLowerCase().trim();
  if (!key) return true;
  return String(a.no_rumah || "").toLowerCase().includes(key) ||
         String(a.nama || "").toLowerCase().includes(key);
}
function statusWargaLabel(a) {
  return Number(a?.aktif) === 1 ? "Aktif" : "Nonaktif";
}
function normalizeRole(role) {
  return String(role || "petugas").toLowerCase().trim();
}
function isViewer() {
  return normalizeRole(session?.role) === "viewer";
}
function roleLabel() {
  const r = normalizeRole(session?.role);
  if (r === "admin") return "Admin";
  if (r === "viewer") return "Viewer";
  return "Petugas";
}
function canOpenPage(page) {
  return !isViewer() || page === "cari";
}
function applyRoleAccess() {
  const viewer = isViewer();
  document.body.classList.toggle("role-viewer", viewer);

  document.querySelectorAll(".bottom-nav .nav-item").forEach(btn => {
    const target = btn.getAttribute("onclick") || "";
    btn.style.display = viewer && !target.includes("goPage('cari')") ? "none" : "";
  });

  const btnExport = document.getElementById("btn-export-cari");
  if (btnExport) {
    btnExport.style.display = viewer ? "none" : "";
    if (viewer) btnExport.disabled = true;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  AUTO LOGOUT
// ════════════════════════════════════════════════════════════════════════
function startLogoutTimer() {
  if (logoutTimer) clearTimeout(logoutTimer);
  logoutTimer = setTimeout(() => {
    if (session?.token) { showToast("⏰ Sesi berakhir, silakan login ulang", "error"); doLogout(); }
  }, 5 * 60 * 60 * 1000);
}
function resetLogoutTimer() { if (logoutTimer) { clearTimeout(logoutTimer); startLogoutTimer(); } }

// ════════════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════════════
window.onload = () => {
  if (session?.token) {
    showApp();
    startLogoutTimer();
    ["click","keydown","touchstart","scroll"].forEach(ev =>
      document.addEventListener(ev, () => { if (session?.token) resetLogoutTimer(); }));
  } else {
    showPage("pg-login");
  }
  document.getElementById("inp-password")?.addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
};

// ════════════════════════════════════════════════════════════════════════
//  API JSONP
// ════════════════════════════════════════════════════════════════════════
function api(body) {
  return new Promise((resolve, reject) => {
    const cb    = "cb_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const url   = API_URL + "?data=" + encodeURIComponent(JSON.stringify(body)) + "&callback=" + cb;
    const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 60000);
    function cleanup() { clearTimeout(timer); delete window[cb]; document.getElementById("jsonp-" + cb)?.remove(); }
    window[cb] = (res) => { cleanup(); resolve(res); };
    const script = document.createElement("script");
    script.id = "jsonp-" + cb;
    script.src = url;
    script.onerror = () => { cleanup(); reject(new Error("network")); };
    document.body.appendChild(script);
  });
}

// ════════════════════════════════════════════════════════════════════════
//  LOGIN / LOGOUT
// ════════════════════════════════════════════════════════════════════════
async function doLogin() {
  const username = document.getElementById("inp-username")?.value.trim();
  const password = document.getElementById("inp-password")?.value;
  const btn      = document.getElementById("btn-login");
  if (!username || !password) { showErr("Isi username & password"); return; }
  if (btn) { btn.disabled = true; btn.textContent = "Memverifikasi..."; }
  try {
    const res = await api({ action: "login", username, password });
    if (res.status !== "ok") { showErr(res.message || "Login gagal"); return; }
    document.getElementById("login-err").style.display = "none";
    session = { token: res.token, nama: res.nama, role: res.role, username: res.username };
    sessionStorage.setItem("sikas_session", JSON.stringify(session));
    clearCache();
    startLogoutTimer();
    showApp();
    if (!isViewer()) prefetchAnggota().catch(console.error);
  } catch(err) { showErr("Gagal terhubung: " + err.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "Masuk"; } }
}
function showErr(msg) {
  const el = document.getElementById("login-err");
  el.textContent = msg; el.style.display = "block";
}
function doLogout() {
  if (logoutTimer) clearTimeout(logoutTimer);
  sessionStorage.removeItem("sikas_session");
  session = null; allAnggota = [];
  Object.keys(pgState).forEach(k => { pgState[k].page = 1; pgState[k].data = []; });
  showPage("pg-login");
  const u = document.getElementById("inp-username"); if (u) u.value = "";
  const p = document.getElementById("inp-password"); if (p) p.value = "";
  const e = document.getElementById("login-err"); if (e) e.style.display = "none";
  showToast("Anda telah logout");
}

// ════════════════════════════════════════════════════════════════════════
//  NAVIGATION
// ════════════════════════════════════════════════════════════════════════
function showPage(id) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const el = document.getElementById(id);
  if (!el) { console.error("Halaman tidak ditemukan:", id); return; }
  el.classList.add("active");
  window.scrollTo(0, 0);
}
function showApp() {
  if (!session?.token) { showPage("pg-login"); return; }
  applyRoleAccess();
  const h = new Date().getHours();
  const greeting = h < 12 ? "Selamat pagi" : h < 15 ? "Selamat siang" : h < 18 ? "Selamat sore" : "Selamat malam";
  const greetEl  = document.getElementById("dash-greeting");
  const namaEl   = document.getElementById("dash-nama");
  if (greetEl) greetEl.textContent = greeting + ", " + roleLabel();
  if (namaEl)  namaEl.textContent  = session?.nama || session?.username || "Pengguna";

  if (isViewer()) {
    showPage("pg-cari");
    initCariPage();
    return;
  }

  showPage("pg-dashboard");
  loadDashboard();
}
function goPage(page) {
  if (!canOpenPage(page)) {
    showToast("Role viewer hanya dapat membuka menu Cari", "error");
    page = "cari";
  }
  const map = { dashboard: "pg-dashboard", cari: "pg-cari", bayar: "pg-bayar", laporan: "pg-laporan" };
  showPage(map[page]);
  applyRoleAccess();
  if (page === "dashboard") loadDashboard();
  if (page === "laporan")   { initFilterLaporan(); loadLaporan(); }
  if (page === "cari")      initCariPage();
  if (page === "bayar")     resetBayarForm();
}
function goBack() { showPage(fromPage === "bayar" ? "pg-bayar" : "pg-cari"); }
function goPageCari(statusFilter) { showPage("pg-cari"); applyRoleAccess(); initCariPage(statusFilter); }

// ════════════════════════════════════════════════════════════════════════
//  PREFETCH
// ════════════════════════════════════════════════════════════════════════
async function prefetchAnggota() {
  if (allAnggota.length) return;
  const cached = getCache("anggota");
  if (cached) { allAnggota = cached; return; }
  try {
    const res = await api({ action: "getAnggota", token: session?.token });
    if (res.status === "ok") { allAnggota = res.data; setCache("anggota", allAnggota); }
  } catch(e) { console.error(e); }
}

// ════════════════════════════════════════════════════════════════════════
//  DASHBOARD
// ════════════════════════════════════════════════════════════════════════
async function loadDashboard() {
  if (isViewer()) return;
  ["s-total","s-lunas","s-belum","s-nominal"].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = "…";
  });
  try {
    const periode = `${BULAN_INI} ${TAHUN_INI}`;
    const res     = await api({ action: "getDashboardStats", token: session?.token, periode });
    if (res.status !== "ok") throw new Error(res.message);
    const s = res.stats;
    document.getElementById("s-total").textContent   = s.total_anggota;
    document.getElementById("s-lunas").textContent   = s.sudah_bayar;
    document.getElementById("s-belum").textContent   = s.belum_bayar;
    document.getElementById("s-nominal").textContent = rp(s.grand_total);
    const pct = s.total_anggota ? Math.round(s.sudah_bayar / s.total_anggota * 100) : 0;
    document.getElementById("s-progress").style.width = pct + "%";
    document.getElementById("s-pct").textContent      = pct + "% lunas";
  } catch(err) {
    ["s-total","s-lunas","s-belum","s-nominal"].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = "!";
    });
    showToast("Gagal memuat dashboard", "error");
  }
}

// ════════════════════════════════════════════════════════════════════════
//  CARI ANGGOTA
// ════════════════════════════════════════════════════════════════════════
function initCariPage(presetStatus) {
  applyRoleAccess();
  const selBulan = document.getElementById("cari-filter-bulan");
  const selTahun = document.getElementById("cari-filter-tahun");
  if (selBulan) selBulan.value = BULAN_INI;
  if (selTahun) {
    if (!selTahun.options.length) {
      for (let y = TAHUN_INI; y >= TAHUN_INI - 3; y--) {
        const opt = document.createElement("option"); opt.value = y; opt.textContent = y; selTahun.appendChild(opt);
      }
    }
    selTahun.value = TAHUN_INI;
  }
  if (presetStatus) {
    const selStatus = document.getElementById("cari-filter-status");
    if (selStatus) selStatus.value = presetStatus;
    doCariFilter();
  } else {
    document.getElementById("cari-results").innerHTML = "";
    const infoEl = document.getElementById("cari-info");
    if (infoEl) infoEl.style.display = "none";
    const btnExport = document.getElementById("btn-export-cari");
    if (btnExport) {
      btnExport.disabled = true;
      btnExport.style.display = isViewer() ? "none" : "";
    }
    cariData = [];
  }
}

async function doCariFilter() {
  const keyword = document.getElementById("cari-keyword")?.value.trim() || "";
  const filter  = document.getElementById("cari-filter-status")?.value || "semua";
  const bulan   = document.getElementById("cari-filter-bulan")?.value  || BULAN_INI;
  const tahun   = document.getElementById("cari-filter-tahun")?.value  || TAHUN_INI;
  const periode = `${bulan} ${tahun}`;

  const resultsEl = document.getElementById("cari-results");
  const infoEl    = document.getElementById("cari-info");
  const btnExport = document.getElementById("btn-export-cari");

  if (resultsEl) resultsEl.innerHTML = `<div class="loading">⏳ Mencari data…</div>`;
  if (infoEl)    infoEl.style.display = "none";
  if (btnExport) btnExport.disabled = true;

  try {
    const res = await api({ action: "cariAnggotaFilter", token: session?.token, keyword, filter, periode });
    if (res.status !== "ok") throw new Error(res.message);

    cariData = res.data || [];
    pgState.cari.data = cariData;
    pgState.cari.page = 1;

    if (infoEl) {
      const filterLabel = { semua: "Semua", belum: "Belum Bayar", lunas: "Sudah Bayar" }[filter] || filter;
      infoEl.textContent = `${res.total} anggota ditemukan · Filter: ${filterLabel} · Periode: ${periode}`;
      infoEl.style.display = "block";
    }
    if (btnExport) {
      btnExport.disabled = isViewer() || cariData.length === 0;
      btnExport.style.display = isViewer() ? "none" : "";
    }
    renderCariResults();
  } catch(err) {
    if (resultsEl) resultsEl.innerHTML = `<div class="empty"><p>Gagal: ${err.message}</p></div>`;
    showToast("Gagal mencari data", "error");
  }
}

function renderCariResults() {
  const el = document.getElementById("cari-results");
  if (!el) return;
  const { data, page } = pgState.cari;
  if (!data.length) { el.innerHTML = `<div class="empty"><p>Tidak ada data ditemukan</p></div>`; return; }
  const pg = paginate(data, page);
  pgState.cari.page = pg.curPage;
  el.innerHTML = `<div class="card"><div class="card-body" style="padding:0 16px;">
    ${pg.items.map(a => {
      const totalBln = Number(a.bulan_tunggak_kas || 0) + Number(a.bulan_tunggak_rmd || 0) + Number(a.bulan_tunggak_konsumsi || 0) + Number(a.bulan_tunggak_dana_17n || 0);
      const iuranLabel = [
        a.ikut_kas      ? "Kas"     : "",
        a.ikut_rmd      ? "RMD"     : "",
        a.ikut_konsumsi ? "Konsumsi": "",
        a.ikut_dana_17n ? "17n"     : "",
      ].filter(Boolean).join("+");

      return `
        <div class="pel-item ${isViewer() ? "viewer-result" : ""}" onclick="openDetail('${esc(a.id_anggota)}','cari')">
          <div class="avatar">${initials(a.nama)}</div>
          <div class="pel-info">
            <div class="pel-name">${escHtml(a.nama)}</div>
            <div class="pel-sub">No ${escHtml(a.no_rumah)} · ${iuranLabel || "Iuran"} · ${
              a.total_tunggakan > 0
                ? `<span style="color:var(--c-red)">Tunggakan ${rp(a.total_tunggakan)}</span>`
                : `<span style="color:var(--c-green)">Lunas</span>`
            }</div>
          </div>
          ${a.total_tunggakan > 0
            ? `<span class="badge badge-red">${totalBln} bln</span>`
            : `<span class="badge badge-green">✓</span>`}
        </div>`;
    }).join("")}
    ${renderPagination("cari", pg.curPage, pg.totalPages, data.length, pg.start, pg.end)}
  </div></div>`;
}

async function exportCariExcel() {
  if (isViewer()) { showToast("Role viewer tidak memiliki akses export", "error"); return; }
  if (!cariData.length) { showToast("Tidak ada data untuk diexport", "error"); return; }
  if (typeof XLSX === "undefined") { showToast("Library Excel belum dimuat", "error"); return; }

  const keyword = document.getElementById("cari-keyword")?.value.trim() || "";
  const bulan   = document.getElementById("cari-filter-bulan")?.value || BULAN_INI;
  const tahun   = document.getElementById("cari-filter-tahun")?.value || TAHUN_INI;
  const filter  = document.getElementById("cari-filter-status")?.value || "semua";
  const periode = `${bulan} ${tahun}`;

  const btn = document.getElementById("btn-export-cari");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Menyiapkan..."; }

  try {
    const res = await api({
      action: "getExportCariData",
      token: session?.token,
      keyword,
      filter,
      periode,
    });
    if (res.status !== "ok") throw new Error(res.message || "Gagal mengambil data export");

    const sudahRows = addTotalRow(res.sudah_bayar || [], "Bulan Dibayar");
    const belumRows = addTotalRow(res.belum_bayar || [], "Bulan Tunggakan");

    if (filter === "lunas") {
      if (!sudahRows.length) { showToast("Tidak ada data sudah bayar untuk diexport", "error"); return; }
      exportToXlsx(sudahRows, `Sudah_Bayar_${safeFileName(periode)}.xlsx`, "Sudah Bayar");
      showToast("File Excel sudah bayar berhasil dibuat", "success");
      return;
    }

    if (filter === "belum") {
      if (!belumRows.length) { showToast("Tidak ada data belum bayar untuk diexport", "error"); return; }
      exportToXlsx(belumRows, `Belum_Bayar_${safeFileName(periode)}.xlsx`, "Belum Bayar");
      showToast("File Excel belum bayar berhasil dibuat", "success");
      return;
    }

    const sheets = [
      { name: "Sudah Bayar", rows: sudahRows.length ? sudahRows : makeEmptySheetRows("Tidak ada data sudah bayar") },
      { name: "Belum Bayar", rows: belumRows.length ? belumRows : makeEmptySheetRows("Tidak ada data belum bayar") },
    ];
    exportToXlsxMulti(sheets, `Semua_Status_Bayar_${safeFileName(periode)}.xlsx`);
    showToast("File Excel semua status berhasil dibuat", "success");
  } catch(e) { showToast("Gagal export: " + e.message, "error"); }
  finally { if (btn) { btn.disabled = cariData.length === 0; btn.textContent = "⬇️ Export Excel"; } }
}

// ════════════════════════════════════════════════════════════════════════
//  DETAIL ANGGOTA
// ════════════════════════════════════════════════════════════════════════
async function openDetail(id, from = "cari") {
  fromPage = from;

  // Petugas/admin memakai cache MasterAnggota. Viewer tidak boleh getAnggota,
  // jadi viewer memakai data hasil pencarian Cari sebagai sumber identitas warga.
  if (!allAnggota.length && !isViewer()) await prefetchAnggota();
  const anggota = allAnggota.find(a => String(a.id_anggota) === String(id)) ||
                  cariData.find(a => String(a.id_anggota) === String(id));
  if (!anggota) return;

  currentAnggota = anggota;
  document.getElementById("detail-nama").textContent    = "Detail Tunggakan";
  document.getElementById("detail-norumah").textContent = anggota.nama;
  const detailEl = document.getElementById("detail-riwayat");
  if (detailEl) detailEl.innerHTML = "<div class='loading'>⏳ Memuat tunggakan...</div>";
  showPage("pg-detail");
  applyRoleAccess();

  try {
    const res = await api({ action: "getTunggakan", token: session?.token, id_anggota: id });
    if (res.status !== "ok" || !res.data) { detailEl.innerHTML = `<div class="empty">Gagal memuat</div>`; return; }
    const d = res.data;
    const totalTunggakan = d.grand_total || 0;

    let html = `
      <div class="info-row"><span class="lbl">Anggota</span><span class="val">${escHtml(anggota.nama)}</span></div>
      <div class="info-row"><span class="lbl">No Rumah</span><span class="val mono">${escHtml(anggota.no_rumah)}</span></div>
      <div class="info-row"><span class="lbl">Iuran/Bulan</span><span class="val">${rp(anggota.iuran_per_bulan)}</span></div>
      <div class="divider"></div>`;

    html += renderTunggakanBlock("💰 Kas",             d.kas,      d.iuran_kas,      d.ikut_kas);
    html += renderTunggakanBlock("🏦 Piranti RMD",     d.rmd,      d.iuran_rmd,      d.ikut_rmd);
    html += renderTunggakanBlock("🍽️ Konsumsi",        d.konsumsi, d.iuran_konsumsi, d.ikut_konsumsi);
    html += renderTunggakanBlock("🎉 Dana 17n",         d.dana_17n, d.iuran_dana_17n, d.ikut_dana_17n);

    html += `
      <div class="total-box">
        <div class="info-row"><span class="lbl" style="font-weight:700;">Total Tunggakan</span><span class="val total">${rp(totalTunggakan)}</span></div>
      </div>`;

    if (!isViewer()) {
      html += `<button class="btn btn-green" style="margin-top:12px;" onclick="openBayarDariDetail('${esc(anggota.id_anggota)}')">💰 Bayar Sekarang</button>`;
    }

    detailEl.innerHTML = html;
  } catch(e) { detailEl.innerHTML = `<div class="empty">Error: ${e.message}</div>`; }
}

function renderTunggakanBlock(label, list, nominal, ikut) {
  if (!ikut) return "";
  let html = `<div class="tunggakan-container">`;
  if (!list || list.length === 0) {
    html += `<div class="empty small">✅ Tidak ada tunggakan ${label.replace(/^[^\s]+\s/,"")}</div>`;
  } else {
    html += `<div class="section-label">${label} (${rp(nominal)}/bulan)</div>`;
    html += list.map(t => `<div class="tunggakan-item">📅 ${escHtml(t.bulan)} ${escHtml(String(t.tahun))} — ${rp(t.nominal)} ❌</div>`).join("");
  }
  return html + `</div>`;
}

async function openBayarDariDetail(id) {
  if (isViewer()) { showToast("Role viewer tidak dapat membuka pembayaran", "error"); return; }
  goPage("bayar");
  await pilihAnggotaBayar(id);
}

// ════════════════════════════════════════════════════════════════════════
//  FORM BAYAR
// ════════════════════════════════════════════════════════════════════════
let bayarAnggota = null, bayarSearchTimer;

function resetBayarForm() {
  if (isViewer()) return;
  bayarAnggota = null; currentTunggakan = null;
  pgState.bayar.data = []; pgState.bayar.page = 1;

  const fields = ["bayar-search","bayar-nama","bayar-norumah",
                  "tunggakan-kas","tunggakan-rmd","tunggakan-konsumsi","tunggakan-dana17n",
                  "bayar-total","bayar-grand","bayar-jml-kas","bayar-jml-rmd",
                  "bayar-jml-konsumsi","bayar-jml-dana17n","bayar-search-results"];
  fields.forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    if (el.tagName === "INPUT") el.value = "";
    else el.innerHTML = "";
    if (["bayar-nama","bayar-norumah"].includes(id)) el.textContent = "—";
    if (["bayar-total","bayar-grand"].includes(id))  el.textContent = "Rp 0";
  });

  document.getElementById("bayar-form-card")?.style && (document.getElementById("bayar-form-card").style.display = "none");
  // Sembunyikan semua grup iuran opsional
  ["bayar-kas-group","bayar-rmd-group","bayar-konsumsi-group","bayar-dana17n-group"].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = "none";
  });
}

function doBayarSearch(val) {
  if (isViewer()) { showToast("Role viewer tidak dapat membuka pembayaran", "error"); return; }
  clearTimeout(bayarSearchTimer);
  const resultsEl = document.getElementById("bayar-search-results");
  if (!resultsEl) return;
  if (!val.trim()) { resultsEl.innerHTML = ""; pgState.bayar.data = []; return; }
  bayarSearchTimer = setTimeout(async () => {
    try {
      let results;
      if (allAnggota.length) {
        const kw = val.toLowerCase();
        results = allAnggota.filter(p => hasIuranWajib(p) && matchAnggotaKeyword(p, kw));
      } else {
        const res = await api({ action: "searchAnggota", token: session?.token, keyword: val });
        results = res.status === "ok" ? res.data : [];
      }
      pgState.bayar.data = results; pgState.bayar.page = 1;
      renderBayarSearchResults(results);
    } catch(e) { console.error(e); showToast("Gagal mencari", "error"); }
  }, 300);
}

function renderBayarSearchResults(list) {
  const el = document.getElementById("bayar-search-results"); if (!el) return;
  if (!list.length) { el.innerHTML = `<p style="color:var(--c-text3);padding:8px 0;">Tidak ditemukan.</p>`; return; }
  const pg = paginate(list, pgState.bayar.page); pgState.bayar.page = pg.curPage;
  el.innerHTML = pg.items.map(p => `
    <div class="pel-item" onclick="pilihAnggotaBayar('${esc(p.id_anggota)}')">
      <div class="avatar">${initials(p.nama)}</div>
      <div class="pel-info"><div class="pel-name">${escHtml(p.nama)}</div>
        <div class="pel-sub">No ${escHtml(p.no_rumah || "-")} · ${rp(p.iuran_per_bulan || 0)}/bln · ${statusWargaLabel(p)}</div></div>
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2"/></svg>
    </div>
  `).join("") + renderPagination("bayar", pg.curPage, pg.totalPages, list.length, pg.start, pg.end);
}

async function pilihAnggotaBayar(id) {
  if (isViewer()) { showToast("Role viewer tidak dapat membuka pembayaran", "error"); return; }
  showToast("Memuat data anggota...", "");
  if (!allAnggota.length) await prefetchAnggota();
  bayarAnggota = allAnggota.find(a => String(a.id_anggota) == String(id));
  if (!bayarAnggota) { showToast("Anggota tidak ditemukan", "error"); return; }
  document.getElementById("bayar-nama").textContent    = `${bayarAnggota.nama} (${rp(bayarAnggota.iuran_per_bulan || 0)}/bln)`;
  document.getElementById("bayar-norumah").textContent = bayarAnggota.no_rumah;
  document.getElementById("bayar-search").value        = bayarAnggota.nama;
  document.getElementById("bayar-search-results").innerHTML = "";
  document.getElementById("bayar-form-card").style.display  = "block";
  await loadTunggakan(bayarAnggota.id_anggota);
}

async function loadTunggakan(id) {
  const kasEl   = document.getElementById("tunggakan-kas");
  const rmdEl   = document.getElementById("tunggakan-rmd");
  const konEl   = document.getElementById("tunggakan-konsumsi");
  const d17El   = document.getElementById("tunggakan-dana17n");
  const totalEl = document.getElementById("bayar-total");
  if (kasEl) kasEl.innerHTML = "<div class='loading'>⏳ Memuat tunggakan...</div>";
  [rmdEl, konEl, d17El].forEach(el => { if (el) el.innerHTML = ""; });

  function renderBayarBlock(containerEl, groupId, ikut, list, label, nominal, maxBayar, extraNote = "") {
    const groupEl = document.getElementById(groupId);
    const maxVal = Number(maxBayar || 0);
    if (!ikut || maxVal <= 0) {
      if (groupEl) groupEl.style.display = "none";
      if (containerEl) containerEl.innerHTML = "";
      return;
    }

    if (groupEl) groupEl.style.display = "block";
    if (!containerEl) return;

    if (list && list.length > 0) {
      containerEl.innerHTML = `<div class="section-label">${label} (${rp(nominal)}/bulan)</div>` +
        list.map(t => `<div class="tunggakan-item">📅 ${escHtml(t.bulan)} ${escHtml(String(t.tahun))} — ${rp(t.nominal)} ❌</div>`).join("") +
        (extraNote ? `<div class="empty small">${extraNote}</div>` : "");
    } else {
      containerEl.innerHTML = `<div class="empty small">✅ Tidak ada tunggakan ${label.replace(/^[^\s]+\s/, "")}. Bisa input pembayaran deposit.</div>` +
        (extraNote ? `<div class="empty small">${extraNote}</div>` : "");
    }
  }

  try {
    const res = await api({ action: "getTunggakan", token: session?.token, id_anggota: id });
    if (res.status === "ok" && res.data) {
      currentTunggakan = res.data;
      const d = res.data;

      const maxKas = Number(d.max_bayar_kas ?? d.kas?.length ?? 0);
      const maxRmd = Number(d.max_bayar_rmd ?? d.rmd?.length ?? 0);
      const maxKon = Number(d.max_bayar_konsumsi ?? d.konsumsi?.length ?? 0);
      const maxD17 = Number(d.max_bayar_dana_17n ?? d.dana_17n?.length ?? 0);

      renderBayarBlock(kasEl, "bayar-kas-group", d.ikut_kas, d.kas, "💰 Kas", d.iuran_kas, maxKas,
        maxKas > (d.kas?.length || 0) ? `Bisa deposit sampai ${d.max_deposit_months || 120} bulan ke depan.` : "");

      renderBayarBlock(rmdEl, "bayar-rmd-group", d.ikut_rmd, d.rmd, "🏦 Piranti RMD", d.iuran_rmd, maxRmd,
        maxRmd > (d.rmd?.length || 0) ? `Bisa deposit sampai ${d.max_deposit_months || 120} bulan ke depan.` : "");

      renderBayarBlock(konEl, "bayar-konsumsi-group", d.ikut_konsumsi, d.konsumsi, "🍽️ Konsumsi", d.iuran_konsumsi, maxKon,
        maxKon > (d.konsumsi?.length || 0) ? `Bisa deposit sampai ${d.max_deposit_months || 120} bulan ke depan.` : "");

      renderBayarBlock(d17El, "bayar-dana17n-group", d.ikut_dana_17n, d.dana_17n, "🎉 Dana 17n", d.iuran_dana_17n, maxD17,
        d.dana_17n_range_label ? `Siklus aktif: ${escHtml(d.dana_17n_range_label)}. Maksimal input ${maxD17} bulan.` : "");

      if (totalEl) totalEl.textContent = rp(d.grand_total || 0);

      setInputMax("bayar-jml-kas",      maxKas);
      setInputMax("bayar-jml-rmd",      maxRmd);
      setInputMax("bayar-jml-konsumsi", maxKon);
      setInputMax("bayar-jml-dana17n",  maxD17);

      updateTotalBayar();
      const totalBln = (d.kas?.length||0) + (d.rmd?.length||0) + (d.konsumsi?.length||0) + (d.dana_17n?.length||0);
      showToast(`Tunggakan: ${totalBln} bulan`, "success");
    } else {
      if (kasEl) kasEl.innerHTML = `<div class="empty">Gagal: ${res.message || "Unknown"}</div>`;
      showToast(res.message || "Gagal memuat tunggakan", "error");
    }
  } catch(e) {
    console.error(e);
    if (kasEl) kasEl.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
    showToast("Error: " + e.message, "error");
  }
}

function setInputMax(id, max) {
  const el = document.getElementById(id); if (el) { el.max = max; el.value = ""; }
}

function updateTotalBayar() {
  if (!currentTunggakan) return;
  const d   = currentTunggakan;
  const kas = parseInt(document.getElementById("bayar-jml-kas")?.value      || 0);
  const rmd = parseInt(document.getElementById("bayar-jml-rmd")?.value      || 0);
  const kon = parseInt(document.getElementById("bayar-jml-konsumsi")?.value || 0);
  const d17 = parseInt(document.getElementById("bayar-jml-dana17n")?.value  || 0);
  const total = (kas * (d.iuran_kas||0)) + (rmd * (d.iuran_rmd||0)) +
                (kon * (d.iuran_konsumsi||0)) + (d17 * (d.iuran_dana_17n||0));
  const grandEl = document.getElementById("bayar-grand");
  if (grandEl) grandEl.textContent = rp(total);
}

async function simpanPembayaran() {
  if (isViewer()) { showToast("Role viewer tidak memiliki akses menyimpan pembayaran", "error"); return; }
  if (!bayarAnggota) { showToast("Pilih anggota terlebih dahulu", "error"); return; }
  const jml_kas      = parseInt(document.getElementById("bayar-jml-kas")?.value      || 0);
  const jml_rmd      = parseInt(document.getElementById("bayar-jml-rmd")?.value      || 0);
  const jml_konsumsi = parseInt(document.getElementById("bayar-jml-konsumsi")?.value || 0);
  const jml_dana_17n = parseInt(document.getElementById("bayar-jml-dana17n")?.value  || 0);
  if (jml_kas + jml_rmd + jml_konsumsi + jml_dana_17n === 0) {
    showToast("Pilih minimal 1 bulan untuk dibayar", "error"); return;
  }

  const maxKas = Number(currentTunggakan?.max_bayar_kas || 0);
  const maxRmd = Number(currentTunggakan?.max_bayar_rmd || 0);
  const maxKon = Number(currentTunggakan?.max_bayar_konsumsi || 0);
  const maxD17 = Number(currentTunggakan?.max_bayar_dana_17n || 0);
  if (jml_kas > maxKas) { showToast(`Pembayaran Kas maksimal ${maxKas} bulan`, "error"); return; }
  if (jml_rmd > maxRmd) { showToast(`Pembayaran RMD maksimal ${maxRmd} bulan`, "error"); return; }
  if (jml_konsumsi > maxKon) { showToast(`Pembayaran Konsumsi maksimal ${maxKon} bulan`, "error"); return; }
  if (jml_dana_17n > maxD17) {
    const range = currentTunggakan?.dana_17n_range_label ? ` (${currentTunggakan.dana_17n_range_label})` : "";
    showToast(`Pembayaran Dana 17n maksimal ${maxD17} bulan${range}`, "error"); return;
  }

  const btn = document.getElementById("btn-simpan-bayar");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Menyimpan..."; }
  try {
    const res = await api({
      action: "simpanPembayaran", token: session?.token,
      data: {
        id_anggota:      bayarAnggota.id_anggota,
        periode_tagihan: `${BULAN_INI} ${TAHUN_INI}`,
        jml_bulan: { kas: jml_kas, rmd: jml_rmd, konsumsi: jml_konsumsi, dana_17n: jml_dana_17n },
        petugas: session?.nama || session?.username,
      }
    });
    if (res.status === "ok") {
      showToast(res.message, "success");
      clearCache(); resetBayarForm(); loadDashboard();
    } else {
      showToast(res.message || "Gagal menyimpan", "error");
      if (res.message?.includes("Sesi tidak valid")) doLogout();
    }
  } catch(e) { showToast("Error: " + e.message, "error"); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "💾 Simpan Pembayaran"; } }
}

// ════════════════════════════════════════════════════════════════════════
//  LAPORAN
// ════════════════════════════════════════════════════════════════════════
function initFilterLaporan() {
  const selBulan = document.getElementById("lap-filter-bulan");
  if (selBulan) selBulan.value = BULAN_INI;
  const selTahun = document.getElementById("lap-filter-tahun");
  if (selTahun && !selTahun.options.length) {
    for (let y = TAHUN_INI; y >= TAHUN_INI - 3; y--) {
      const opt = document.createElement("option"); opt.value = y; opt.textContent = y; selTahun.appendChild(opt);
    }
    selTahun.value = TAHUN_INI;
  }
}
function terapkanFilterLaporan() { pgState.laporan.page = 1; loadLaporan(); }

async function loadLaporan() {
  if (isViewer()) return;
  const bulan   = document.getElementById("lap-filter-bulan")?.value || BULAN_INI;
  const tahun   = document.getElementById("lap-filter-tahun")?.value || TAHUN_INI;
  const periode = `${bulan} ${tahun}`;
  document.getElementById("lap-periode").textContent = periode;
  ["lap-total","lap-lunas","lap-belum","lap-total-kas","lap-total-rmd",
   "lap-total-konsumsi","lap-total-dana17n","lap-grand-total"].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = "…";
  });
  try {
    const res = await api({ action: "getLaporanPeriode", token: session?.token, periode });
    if (res.status !== "ok") throw new Error(res.message);
    const { laporan } = res;
    document.getElementById("lap-total").textContent         = laporan.total_anggota;
    document.getElementById("lap-lunas").textContent         = laporan.sudah_bayar;
    document.getElementById("lap-belum").textContent         = laporan.belum_bayar;
    document.getElementById("lap-total-kas").textContent     = rp(laporan.total_kas       || 0);
    document.getElementById("lap-total-rmd").textContent     = rp(laporan.total_rmd       || 0);
    document.getElementById("lap-total-konsumsi").textContent= rp(laporan.total_konsumsi  || 0);
    document.getElementById("lap-total-dana17n").textContent = rp(laporan.total_dana_17n  || 0);
    document.getElementById("lap-grand-total").textContent   = rp(laporan.grand_total     || 0);
    laporanPeriodeAktif = periode;
  } catch(err) {
    showToast("Gagal memuat laporan", "error");
  }
}

// ════════════════════════════════════════════════════════════════════════
//  PAGINATION
// ════════════════════════════════════════════════════════════════════════
function paginate(data, page) {
  const total      = data.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const curPage    = Math.min(Math.max(1, page), totalPages);
  const start      = (curPage - 1) * PAGE_SIZE;
  const end        = Math.min(start + PAGE_SIZE, total);
  return { items: data.slice(start, end), totalPages, start: start + 1, end, curPage };
}
function renderPagination(section, page, totalPages, total, start, end) {
  if (totalPages <= 1) return "";
  return `<div class="pagination"><span class="pagination-info">${start}–${end} dari ${total}</span>
    <div class="pagination-btns">
      <button class="pg-btn" onclick="changePage('${section}',-1)" ${page<=1?"disabled":""}>←</button>
      <button class="pg-btn" onclick="changePage('${section}',1)"  ${page>=totalPages?"disabled":""}>→</button>
    </div></div>`;
}
function changePage(section, dir) {
  pgState[section].page += dir;
  if (section === "cari")  renderCariResults();
  if (section === "bayar") renderBayarSearchResults(pgState.bayar.data);
}

// ════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════════════════════════════════════
function rp(n)          { return "Rp " + Number(n || 0).toLocaleString("id-ID"); }
function initials(nama) { return (nama || "").split(" ").slice(0,2).map(w => w[0] || "").join("").toUpperCase(); }
function esc(str)       { return String(str || "").replace(/'/g, "\\'"); }
function escHtml(str)   { return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function safeFileName(s){ return String(s||"laporan").replace(/\s+/g,"_").replace(/[^\w\-]/g,""); }

function makeExportRow(no, a, jenis, t) {
  return { "No": no, "Nama": a.nama, "No Rumah": a.no_rumah,
           "Jenis": jenis, "Bulan Tunggakan": `${t.bulan} ${t.tahun}`,
           "Nominal": t.nominal, "Status": "Belum Bayar" };
}
function addTotalRow(rows, periodeColumn) {
  if (!rows.length) return rows;
  const total = rows.reduce((s, r) => s + Number(r["Nominal"] || 0), 0);
  const totalRow = {};
  Object.keys(rows[0]).forEach(k => totalRow[k] = "");
  totalRow[periodeColumn || "Keterangan"] = "TOTAL";
  totalRow["Nominal"] = total;
  return [...rows, totalRow];
}
function makeEmptySheetRows(message) {
  return [{ "Keterangan": message }];
}
function autosizeWorksheet(ws, rows) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  ws["!cols"] = headers.map(h => {
    const maxLen = rows.reduce((m, r) => Math.max(m, String(r[h] ?? "").length), String(h).length);
    return { wch: Math.min(Math.max(maxLen + 2, 10), 35) };
  });
}
function exportToXlsx(rows, filename, sheetName) {
  const ws = XLSX.utils.json_to_sheet(rows);
  autosizeWorksheet(ws, rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}
function exportToXlsxMulti(sheets, filename) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(sheet => {
    const rows = sheet.rows && sheet.rows.length ? sheet.rows : makeEmptySheetRows("Tidak ada data");
    const ws = XLSX.utils.json_to_sheet(rows);
    autosizeWorksheet(ws, rows);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  });
  XLSX.writeFile(wb, filename);
}

let toastTimer;
function showToast(msg, type = "") {
  const el = document.getElementById("toast"); if (!el) return;
  el.textContent = msg;
  el.className = "toast show" + (type ? " " + type : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, 2800);
}
