// The ☰ header menu shared by the game screen and the map explore screen.
// Rare, deliberate actions (Restart / Back / Home) live behind it rather
// than as always-visible header buttons — they crowded the header,
// especially on tablets and phones.
//
// `buttons` are ready-made <button> elements (callers wire their own
// click handlers). The dropdown is plain show/hide, closed by picking an
// action, tapping the toggle again, or tapping anywhere else inside
// `root` — that listener lives on the screen's own root element, so it's
// torn down with the screen; no document-level listener to leak.
export function createHamburgerMenu(root, buttons, { label = "Menu" } = {}) {
  const menuWrap = document.createElement("div");
  menuWrap.className = "game-menu";
  const menuToggle = document.createElement("button");
  menuToggle.type = "button";
  menuToggle.className = "exit-button game-menu-toggle";
  menuToggle.setAttribute("aria-label", label);
  menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.textContent = "☰";
  const menuDropdown = document.createElement("div");
  menuDropdown.className = "game-menu-dropdown";
  menuDropdown.hidden = true;
  const setMenuOpen = (open) => {
    menuDropdown.hidden = !open;
    menuToggle.setAttribute("aria-expanded", String(open));
  };
  menuToggle.addEventListener("click", (event) => {
    // Keep the toggle's own click away from screen-wide click listeners
    // (the game's "click anywhere to advance", the outside-click closer
    // below, which would immediately undo the open).
    event.stopPropagation();
    setMenuOpen(menuDropdown.hidden);
  });
  menuDropdown.append(...buttons);
  menuWrap.append(menuToggle, menuDropdown);
  root.addEventListener("click", (event) => {
    if (!menuWrap.contains(event.target)) setMenuOpen(false);
  });
  return menuWrap;
}
