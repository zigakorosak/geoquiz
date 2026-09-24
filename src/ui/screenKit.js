// Shared full-screen "pick one of these" component, used by the home
// screen and every step of the games wizard. Keeping this in one place
// means every choice screen in the app looks and behaves the same way —
// title, optional subtitle, a grid of option buttons, an optional Back
// button — without each screen reimplementing it.

export function renderChoiceScreen(
  container,
  { title, subtitle, options, labelFn, descFn, disabledFn, onPick, onBack, backLabel = "Back" }
) {
  container.innerHTML = "";

  const root = document.createElement("div");
  root.className = "menu-screen wizard-screen";

  if (onBack) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "wizard-back";
    back.textContent = `← ${backLabel}`;
    back.addEventListener("click", onBack);
    root.appendChild(back);
  }

  const heading = document.createElement("h1");
  heading.textContent = title;
  root.appendChild(heading);

  if (subtitle) {
    const sub = document.createElement("p");
    sub.className = "wizard-subtitle";
    sub.textContent = subtitle;
    root.appendChild(sub);
  }

  const list = document.createElement("div");
  list.className = "menu-options wizard-options";

  for (const option of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-option wizard-option";
    const disabled = disabledFn?.(option) ?? false;
    btn.disabled = disabled;

    const label = document.createElement("span");
    label.textContent = labelFn(option);
    btn.appendChild(label);

    const desc = descFn?.(option);
    if (desc) {
      const descEl = document.createElement("span");
      descEl.className = "wizard-option-desc";
      descEl.textContent = desc;
      btn.appendChild(descEl);
    }

    if (!disabled) btn.addEventListener("click", () => onPick(option));
    list.appendChild(btn);
  }

  root.appendChild(list);
  container.appendChild(root);
}
