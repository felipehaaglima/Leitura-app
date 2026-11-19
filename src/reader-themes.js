export const READER_THEMES = [
  { id: "classic", label: "Branco", background: "#ffffff", foreground: "#555555" },
  { id: "sepia", label: "Sépia", background: "#f1dfbd", foreground: "#503c29" },
  { id: "sand", label: "Areia", background: "#eee7dc", foreground: "#53483d" },
  { id: "sage", label: "Sálvia", background: "#e4ebdf", foreground: "#35463d" },
  { id: "dusk", label: "Crepúsculo", background: "#293346", foreground: "#dbe1ef" },
  { id: "night", label: "Noturno", background: "#1b1d20", foreground: "#d3d6dc" },
];

export function normalizeReaderTheme(id) {
  return READER_THEMES.some((theme) => theme.id === id) ? id : "classic";
}
