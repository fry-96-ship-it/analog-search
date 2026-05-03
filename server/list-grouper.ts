import type {
  MaterialInput,
  SimilarityPair,
  AnalogGroup,
  ListAnalysisResult,
} from "@shared/schema";

// =============================================
// Быстрый алгоритм поиска аналогов внутри списка
// =============================================
// Стратегия:
// 1. Нормализация текста (нижний регистр, унификация единиц)
// 2. Извлечение токенов и числовых параметров
// 3. Парное сравнение через комбинацию:
//    - Sørensen-Dice по словам (общая семантика)
//    - Sørensen-Dice по n-граммам (опечатки и сокращения)
//    - Совпадение числовых параметров (размеры, артикулы)
// 4. Формирование групп через Union-Find

// ---- Нормализация ----

const STOP_WORDS = new Set([
  "и", "в", "для", "из", "от", "с", "по", "на", "под", "над", "к", "о",
  "тип", "вид", "марка", "модель", "артикул", "арт",
  "шт", "штук", "кг", "г", "л", "мл", "м", "см", "мм", "пара", "уп",
]);

const UNIT_REPLACEMENTS: [RegExp, string][] = [
  [/(\d)\s*кг\b/gi, "$1 кг"],
  [/(\d)\s*гр?\b/gi, "$1 г"],
  [/(\d)\s*мл\b/gi, "$1 мл"],
  [/(\d)\s*л\b/gi, "$1 л"],
  [/(\d)\s*мм\b/gi, "$1 мм"],
  [/(\d)\s*см\b/gi, "$1 см"],
  [/(\d)\s*м\b/gi, "$1 м"],
  [/(\d)[xх*×](\d)/gi, "$1x$2"],
  // Артикулы/маркировки вида 5w-40 → 5w40, 6204-2rs → 62042rs
  [/(\d)([a-zа-я])-?(\d)/gi, "$1$2$3"],
  [/(\d)-(\d)/g, "$1$2"],
];

function normalize(s: string): string {
  let n = s.toLowerCase();
  // Заменим разные тире и кавычки на стандартные
  n = n.replace(/[—–−]/g, "-").replace(/[«»""]/g, '"');
  // Унификация единиц
  for (const [re, rep] of UNIT_REPLACEMENTS) {
    n = n.replace(re, rep);
  }
  // Удаляем нестандартные знаки, кроме букв, цифр, пробелов и нескольких символов
  n = n.replace(/[^\p{L}\p{N}\s.,/x×*-]/gu, " ");
  n = n.replace(/\s+/g, " ").trim();
  return n;
}

function tokenize(s: string): string[] {
  return normalize(s)
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

// Извлекаем "параметры": числа, артикулы вида A12-30, ГОСТы и т.п.
function extractParams(s: string): Set<string> {
  const out = new Set<string>();
  const text = normalize(s);
  // Числа с возможной единицей: 6204, 5w40, 100шт, 50x100
  // И смешанные коды: 6204rs, m10, ф5
  const re = /\b\d+(?:[.,]\d+)?(?:\s?(?:кг|г|мл|л|мм|см|м|шт|вт|в|а|гц|об|мин))?(?:[a-zа-я]+\d*)?\b|\b[a-zа-я]+\d+[\w-]*\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[0].replace(/\s+/g, ""));
  }
  return out;
}

// Извлекаем только чистые числа/размеры. Если числа различаются — это разные позиции
// (подшипник 6204 vs 6205, болт М10 vs М12).
// Отфильтровываем общие суффиксы вроде "2rs", "4z", "zz" чтобы они не давали ложные совпадения.
const COMMON_SUFFIXES = new Set([
  "2rs", "rs", "zz", "z", "2z", "4z", "n", "nr", "k", "m", "em",
  "xl", "xxl", "xs", "s", "l", "m",
]);
function extractNumbers(s: string): Set<string> {
  const out = new Set<string>();
  const text = normalize(s);
  // Чистые числа (ОТ 2 цифр), размеры вида 10x40, и коды вида ф5, М12, 5w40
  const patterns = [
    /\b\d{2,}\b/g, // чистые числа от 2 цифр: 6204, 40, 100
    /\b\d+x\d+\b/g, // размеры: 10x40, 50x100
    /\b[a-zа-я]\d{1,3}\b/gi, // М10, ф5, m12
    /\b\d{1,2}[a-zа-я]+\d+\b/gi, // 5w40
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const tok = m[0].toLowerCase();
      if (COMMON_SUFFIXES.has(tok)) continue;
      out.add(tok);
    }
  }
  return out;
}

// n-граммы по символам (для опечаток и схожих слов)
function ngrams(s: string, n = 3): Set<string> {
  const norm = normalize(s).replace(/\s+/g, "");
  const out = new Set<string>();
  if (norm.length < n) {
    out.add(norm);
    return out;
  }
  for (let i = 0; i <= norm.length - n; i++) {
    out.add(norm.slice(i, i + n));
  }
  return out;
}

// Sørensen-Dice: 2|A∩B| / (|A|+|B|)
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

// Совпадение параметров: какая доля параметров одной позиции есть во второй
function paramOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

// ---- Подготовка фичей для каждой позиции ----

interface ItemFeatures {
  id: string;
  name: string;
  tokens: Set<string>;
  ngrams: Set<string>;
  params: Set<string>;
  numbers: Set<string>;
  normalized: string;
}

function buildFeatures(items: MaterialInput[]): ItemFeatures[] {
  return items.map((it) => ({
    id: it.id,
    name: it.name,
    tokens: new Set(tokenize(it.name)),
    ngrams: ngrams(it.name, 3),
    params: extractParams(it.name),
    numbers: extractNumbers(it.name),
    normalized: normalize(it.name),
  }));
}

// ---- Парное сходство ----

function pairSimilarity(a: ItemFeatures, b: ItemFeatures): number {
  // Полное совпадение нормализованных строк → дубликат
  if (a.normalized === b.normalized) return 1.0;

  const wordSim = dice(a.tokens, b.tokens);
  const charSim = dice(a.ngrams, b.ngrams);
  const paramSim = paramOverlap(a.params, b.params);

  let combined = 0.55 * wordSim + 0.30 * charSim + 0.15 * paramSim;

  // Бонус если есть пересечение параметров (артикулы и размеры)
  if (a.params.size > 0 && b.params.size > 0 && paramSim >= 0.5) {
    combined = Math.min(1, combined + 0.10);
  }
  // Штраф за полное несовпадение параметров при наличии чисел в обеих
  if (a.params.size > 0 && b.params.size > 0 && paramSim === 0) {
    combined *= 0.6;
  }

  // Жёсткий штраф: если в обеих позициях есть значимые числа (размеры/коды)
  // и они ПОЛНОСТЬЮ различны — это разные позиции (6204 vs 6205, М10 vs М12)
  if (a.numbers.size > 0 && b.numbers.size > 0) {
    let intersect = 0;
    for (const n of a.numbers) if (b.numbers.has(n)) intersect++;
    if (intersect === 0) {
      combined *= 0.45;
    }
  }

  return combined;
}

function classifyMatch(sim: number): "duplicate" | "likely" | "possible" {
  if (sim >= 0.92) return "duplicate";
  if (sim >= 0.72) return "likely";
  return "possible";
}

// ---- Union-Find для построения групп ----

class UnionFind {
  parent: Map<string, string> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      return x;
    }
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Сжатие путей
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// ---- Основная функция ----

export function analyzeListFast(
  items: MaterialInput[],
  threshold = 0.55
): ListAnalysisResult {
  const features = buildFeatures(items);
  const pairs: SimilarityPair[] = [];
  const uf = new UnionFind();

  // Все попарные сравнения. Для 1000 позиций это ~500к сравнений — секунды.
  for (let i = 0; i < features.length; i++) {
    for (let j = i + 1; j < features.length; j++) {
      const a = features[i];
      const b = features[j];
      const sim = pairSimilarity(a, b);
      if (sim >= threshold) {
        const matchLevel = classifyMatch(sim);
        pairs.push({
          aId: a.id,
          bId: b.id,
          similarity: Math.round(sim * 1000) / 1000,
          matchLevel,
        });
        // Объединяем в группу только если уверенность достаточная
        if (sim >= 0.65) {
          uf.union(a.id, b.id);
        }
      }
    }
  }

  // Собираем группы из Union-Find
  const groupMap = new Map<string, string[]>();
  for (const f of features) {
    const root = uf.find(f.id);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root)!.push(f.id);
  }

  const groups: AnalogGroup[] = [];
  let groupCounter = 1;
  for (const [, itemIds] of groupMap) {
    if (itemIds.length < 2) continue; // одиночные позиции — не группа
    // Средняя схожесть в группе
    const groupPairs = pairs.filter(
      (p) => itemIds.includes(p.aId) && itemIds.includes(p.bId)
    );
    const avgSim =
      groupPairs.length > 0
        ? groupPairs.reduce((s, p) => s + p.similarity, 0) / groupPairs.length
        : 0;
    // Уровень группы — худший из пар (чтобы не вводить в заблуждение)
    let level: "duplicate" | "likely" | "possible" = "duplicate";
    for (const p of groupPairs) {
      if (p.matchLevel === "possible") level = "possible";
      else if (p.matchLevel === "likely" && level !== "possible") level = "likely";
    }
    // Представитель — самое короткое наименование (обычно самое чистое)
    const rep = itemIds
      .map((id) => features.find((f) => f.id === id)!.name)
      .sort((a, b) => a.length - b.length)[0];

    groups.push({
      id: `g${groupCounter++}`,
      itemIds,
      representative: rep,
      matchLevel: level,
      avgSimilarity: Math.round(avgSim * 1000) / 1000,
    });
  }

  // Сортируем группы по уровню совпадения и размеру
  const levelRank = { duplicate: 0, likely: 1, possible: 2 };
  groups.sort((a, b) => {
    const r = levelRank[a.matchLevel] - levelRank[b.matchLevel];
    if (r !== 0) return r;
    return b.itemIds.length - a.itemIds.length;
  });

  const groupedIds = new Set(groups.flatMap((g) => g.itemIds));
  const ungroupedIds = items.filter((it) => !groupedIds.has(it.id)).map((it) => it.id);

  return {
    groups,
    pairs: pairs.sort((a, b) => b.similarity - a.similarity),
    ungroupedIds,
    stats: {
      total: items.length,
      grouped: groupedIds.size,
      duplicates: groups.filter((g) => g.matchLevel === "duplicate").length,
      likely: groups.filter((g) => g.matchLevel === "likely").length,
      possible: groups.filter((g) => g.matchLevel === "possible").length,
    },
  };
}

// ---- Перестроение групп из заранее заданного набора пар ----
// Используется после AI-фильтрации, когда часть пар была отвергнута.

export function buildGroupsFromPairs(
  items: MaterialInput[],
  pairs: SimilarityPair[]
): ListAnalysisResult {
  const uf = new UnionFind();
  for (const p of pairs) {
    if (p.similarity >= 0.55) {
      uf.union(p.aId, p.bId);
    }
  }
  const itemById = new Map(items.map((it) => [it.id, it]));
  const groupMap = new Map<string, string[]>();
  for (const it of items) {
    const root = uf.find(it.id);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root)!.push(it.id);
  }
  const groups: AnalogGroup[] = [];
  let groupCounter = 1;
  for (const [, itemIds] of groupMap) {
    if (itemIds.length < 2) continue;
    const groupPairs = pairs.filter(
      (p) => itemIds.includes(p.aId) && itemIds.includes(p.bId)
    );
    const avgSim =
      groupPairs.length > 0
        ? groupPairs.reduce((s, p) => s + p.similarity, 0) / groupPairs.length
        : 0;
    let level: "duplicate" | "likely" | "possible" = "duplicate";
    for (const p of groupPairs) {
      if (p.matchLevel === "possible") level = "possible";
      else if (p.matchLevel === "likely" && level !== "possible") level = "likely";
    }
    const rep = itemIds
      .map((id) => itemById.get(id)?.name || "")
      .sort((a, b) => a.length - b.length)[0];
    groups.push({
      id: `g${groupCounter++}`,
      itemIds,
      representative: rep,
      matchLevel: level,
      avgSimilarity: Math.round(avgSim * 1000) / 1000,
    });
  }
  const levelRank = { duplicate: 0, likely: 1, possible: 2 };
  groups.sort((a, b) => {
    const r = levelRank[a.matchLevel] - levelRank[b.matchLevel];
    if (r !== 0) return r;
    return b.itemIds.length - a.itemIds.length;
  });
  const groupedIds = new Set(groups.flatMap((g) => g.itemIds));
  const ungroupedIds = items.filter((it) => !groupedIds.has(it.id)).map((it) => it.id);
  return {
    groups,
    pairs: pairs.sort((a, b) => b.similarity - a.similarity),
    ungroupedIds,
    stats: {
      total: items.length,
      grouped: groupedIds.size,
      duplicates: groups.filter((g) => g.matchLevel === "duplicate").length,
      likely: groups.filter((g) => g.matchLevel === "likely").length,
      possible: groups.filter((g) => g.matchLevel === "possible").length,
    },
  };
}

// ---- Поиск аналогов одной позиции в списке ----

export function findAnalogsForItem(
  targetId: string,
  items: MaterialInput[],
  threshold = 0.4,
  limit = 20
): SimilarityPair[] {
  const features = buildFeatures(items);
  const target = features.find((f) => f.id === targetId);
  if (!target) return [];

  const pairs: SimilarityPair[] = [];
  for (const f of features) {
    if (f.id === target.id) continue;
    const sim = pairSimilarity(target, f);
    if (sim >= threshold) {
      pairs.push({
        aId: target.id,
        bId: f.id,
        similarity: Math.round(sim * 1000) / 1000,
        matchLevel: classifyMatch(sim),
      });
    }
  }
  return pairs.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}
