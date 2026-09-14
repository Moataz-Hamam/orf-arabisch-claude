const state = {
  items: [],
  activeCategory: "all",
};

const grid = document.getElementById("news-grid");
const statusEl = document.getElementById("status");
const filtersEl = document.getElementById("category-filters");
const updatedAtEl = document.getElementById("updated-at");

function setStatus(message) {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString("ar-AT", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function buildCategoryList(items) {
  const seen = new Map();
  for (const item of items) {
    if (!seen.has(item.category_de)) {
      seen.set(item.category_de, item.category_ar || "عام");
    }
  }
  return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], "ar"));
}

function renderFilters(items) {
  const categories = buildCategoryList(items);
  filtersEl.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = "chip" + (state.activeCategory === "all" ? " active" : "");
  allBtn.dataset.category = "all";
  allBtn.textContent = "الكل";
  filtersEl.appendChild(allBtn);

  for (const [de, ar] of categories) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (state.activeCategory === de ? " active" : "");
    btn.dataset.category = de;
    btn.textContent = ar;
    filtersEl.appendChild(btn);
  }

  filtersEl.addEventListener("click", (event) => {
    const btn = event.target.closest(".chip");
    if (!btn) return;
    state.activeCategory = btn.dataset.category;
    renderFilters(state.items);
    renderGrid();
  });
}

function renderGrid() {
  const items =
    state.activeCategory === "all"
      ? state.items
      : state.items.filter((item) => item.category_de === state.activeCategory);

  grid.innerHTML = "";

  if (!items.length) {
    setStatus("لا توجد أخبار في هذا التصنيف حالياً.");
    return;
  }
  setStatus(null);

  for (const item of items) {
    const li = document.createElement("li");
    li.className = "card";
    li.innerHTML = `
      <div class="card-top">
        <span class="category-tag">${item.category_ar || "عام"}</span>
        <span class="card-date">${formatDate(item.pubDate)}</span>
      </div>
      <p class="title-ar">${item.title_ar}</p>
      <p class="title-de">${item.title_de}</p>
      <a class="card-link" href="${item.link}" target="_blank" rel="noopener">قراءة الخبر الأصلي على ORF ←</a>
    `;
    grid.appendChild(li);
  }
}

async function init() {
  setStatus("جارٍ تحميل الأخبار…");
  try {
    const res = await fetch("data/news.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.items = data.items || [];

    if (data.generatedAt) {
      updatedAtEl.textContent = `آخر تحديث: ${formatDate(data.generatedAt)}`;
    }

    if (!state.items.length) {
      setStatus("لا توجد أخبار متاحة بعد. ستظهر هنا بعد أول تشغيل للأتمتة.");
      renderFilters([]);
      return;
    }

    renderFilters(state.items);
    renderGrid();
  } catch (err) {
    console.error(err);
    setStatus("تعذر تحميل الأخبار حالياً. حاول تحديث الصفحة لاحقاً.");
  }
}

init();
