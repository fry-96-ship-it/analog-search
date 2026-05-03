// Палитра цветов для подсветки групп аналогов.
// Используется и на фронтенде (Tailwind-подобные классы), и в Excel-экспорте (HEX заливки).
// Цвета подобраны мягкими, чтобы текст оставался читаемым.

export interface GroupColor {
  // CSS цвет фона строки в таблице (полупрозрачный)
  bgClass: string;
  // CSS цвет цветной точки/индикатора группы
  dotClass: string;
  // HEX без # для заливки в Excel (мягкая пастель)
  excelFill: string;
  // HEX без # для границы / акцентной линии
  excelBorder: string;
}

export const GROUP_COLORS: GroupColor[] = [
  { bgClass: "bg-blue-100/60 dark:bg-blue-500/15", dotClass: "bg-blue-500", excelFill: "DBEAFE", excelBorder: "3B82F6" },
  { bgClass: "bg-emerald-100/60 dark:bg-emerald-500/15", dotClass: "bg-emerald-500", excelFill: "D1FAE5", excelBorder: "10B981" },
  { bgClass: "bg-amber-100/60 dark:bg-amber-500/15", dotClass: "bg-amber-500", excelFill: "FEF3C7", excelBorder: "F59E0B" },
  { bgClass: "bg-violet-100/60 dark:bg-violet-500/15", dotClass: "bg-violet-500", excelFill: "EDE9FE", excelBorder: "8B5CF6" },
  { bgClass: "bg-rose-100/60 dark:bg-rose-500/15", dotClass: "bg-rose-500", excelFill: "FFE4E6", excelBorder: "F43F5E" },
  { bgClass: "bg-cyan-100/60 dark:bg-cyan-500/15", dotClass: "bg-cyan-500", excelFill: "CFFAFE", excelBorder: "06B6D4" },
  { bgClass: "bg-lime-100/60 dark:bg-lime-500/15", dotClass: "bg-lime-500", excelFill: "ECFCCB", excelBorder: "84CC16" },
  { bgClass: "bg-orange-100/60 dark:bg-orange-500/15", dotClass: "bg-orange-500", excelFill: "FFEDD5", excelBorder: "F97316" },
  { bgClass: "bg-pink-100/60 dark:bg-pink-500/15", dotClass: "bg-pink-500", excelFill: "FCE7F3", excelBorder: "EC4899" },
  { bgClass: "bg-teal-100/60 dark:bg-teal-500/15", dotClass: "bg-teal-500", excelFill: "CCFBF1", excelBorder: "14B8A6" },
  { bgClass: "bg-indigo-100/60 dark:bg-indigo-500/15", dotClass: "bg-indigo-500", excelFill: "E0E7FF", excelBorder: "6366F1" },
  { bgClass: "bg-fuchsia-100/60 dark:bg-fuchsia-500/15", dotClass: "bg-fuchsia-500", excelFill: "FAE8FF", excelBorder: "D946EF" },
];

export function getGroupColor(index: number): GroupColor {
  if (index < 0) {
    return {
      bgClass: "",
      dotClass: "bg-muted-foreground/40",
      excelFill: "FFFFFF",
      excelBorder: "E5E7EB",
    };
  }
  return GROUP_COLORS[index % GROUP_COLORS.length];
}
