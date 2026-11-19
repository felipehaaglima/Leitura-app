export const tones = {
  yellow: "Amarelo",
  green: "Verde",
  pink: "Rosa",
};

export function normalizePalette(colors) {
  return [...new Set((colors ?? [])
    .filter((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))
    .map((color) => color.toLowerCase()))];
}

export function colorLabel(color) {
  return Object.hasOwn(tones, color) ? tones[color] : `Cor ${color.toUpperCase()}`;
}

export function applyReaderColor(element, color) {
  if (Object.hasOwn(tones, color)) {
    element.dataset.color = color;
    return;
  }
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) return;
  element.dataset.color = color.toLowerCase();
  element.style.setProperty("--lr-highlight", color);
  const channels = [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16) / 255);
  const [red, green, blue] = channels.map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  const luminance = .2126 * red + .7152 * green + .0722 * blue;
  element.style.setProperty("--lr-mark-ink", luminance > .179 ? "#000" : "#fff");
}
