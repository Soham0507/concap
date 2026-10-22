// Shared list of industry types used across Scan / Companies / Contacts.
// Edit this list in one place — every Industry dropdown picks it up.
window.INDUSTRIES = [
  "Information Technology",
  "Software / SaaS",
  "Manufacturing",
  "Healthcare",
  "Pharmaceuticals",
  "Finance & Banking",
  "Insurance",
  "Retail",
  "E-commerce",
  "Education",
  "Real Estate",
  "Construction",
  "Hospitality",
  "Food & Beverage",
  "Logistics & Transportation",
  "Automotive",
  "Energy & Utilities",
  "Agriculture",
  "Media & Entertainment",
  "Marketing & Advertising",
  "Consulting",
  "Legal",
  "Government",
  "Non-profit",
  "Telecommunications",
];

/**
 * Wire an industry <select> + an "Other" text input so they behave as one
 * field. If the existing value is in the list, the select is set; otherwise
 * "Other" is selected and the text input gets the custom value.
 *
 *   <select id="x-industry"></select>
 *   <input  id="x-industry-other" class="hidden" />
 *   wireIndustrySelect("x-industry", "x-industry-other", "Software / SaaS");
 *
 * Use `readIndustryValue(selectId, otherId)` to get the effective value back.
 */
window.wireIndustrySelect = function (selectId, otherId, currentValue) {
  const sel = document.getElementById(selectId);
  const other = document.getElementById(otherId);
  if (!sel) return;

  // Build options once.
  if (!sel.dataset.populated) {
    sel.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "— Select industry —";
    sel.appendChild(blank);
    for (const name of window.INDUSTRIES) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      sel.appendChild(o);
    }
    const o = document.createElement("option");
    o.value = "__other__";
    o.textContent = "Other (specify)";
    sel.appendChild(o);
    sel.dataset.populated = "1";

    sel.addEventListener("change", () => {
      if (!other) return;
      if (sel.value === "__other__") {
        other.classList.remove("hidden");
        other.focus();
      } else {
        other.classList.add("hidden");
        other.value = "";
      }
    });
  }

  // Apply currentValue.
  const v = (currentValue || "").trim();
  if (!v) {
    sel.value = "";
    if (other) { other.value = ""; other.classList.add("hidden"); }
    return;
  }
  if (window.INDUSTRIES.includes(v)) {
    sel.value = v;
    if (other) { other.value = ""; other.classList.add("hidden"); }
  } else {
    sel.value = "__other__";
    if (other) { other.value = v; other.classList.remove("hidden"); }
  }
};

window.readIndustryValue = function (selectId, otherId) {
  const sel = document.getElementById(selectId);
  const other = document.getElementById(otherId);
  if (!sel) return null;
  if (sel.value === "__other__") return (other?.value || "").trim() || null;
  return sel.value || null;
};
