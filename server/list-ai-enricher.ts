import type { MaterialInput, SimilarityPair } from "@shared/schema";
import { gigachatComplete, extractJson } from "./analog-engine";

// =============================================
// AI-обогащение результатов быстрого алгоритма
// =============================================
// Берём пары, найденные быстрым алгоритмом, и просим GigaChat
// подтвердить или отклонить аналогию + объяснить причину.
// Это «гибридный» подход: быстрый алгоритм отбирает кандидатов,
// AI оценивает их более тонко.

interface AiVerdict {
  aId: string;
  bId: string;
  isAnalog: boolean;
  // Уверенность модели от 0 до 1
  confidence: number;
  reason: string;
}

const BATCH_SIZE = 8;

function buildPrompt(
  pairs: { aId: string; bId: string; aName: string; bName: string }[]
): string {
  const list = pairs
    .map(
      (p, i) =>
        `${i + 1}. A="${p.aName}" | B="${p.bName}" (aId=${p.aId}, bId=${p.bId})`
    )
    .join("\n");

  return `Ты — эксперт по закупкам и снабжению. Тебе даны пары наименований из номенклатурного списка предприятия. Для каждой пары определи, являются ли A и B одним и тем же товаром или взаимозаменяемыми аналогами.

Учитывай:
- Одинаковый товар, записанный по-разному (опечатки, сокращения, разный порядок слов) → isAnalog=true, confidence высокая.
- Один товар-разные размеры/типы (подшипник 6204 vs 6205, болт М10 vs М12) → isAnalog=false (это РАЗНЫЕ позиции).
- Взаимозаменяемые аналоги (одинаковые характеристики, разные производители) → isAnalog=true.
- Разные товары → isAnalog=false.

ПАРЫ:
${list}

Верни СТРОГО JSON без markdown:
{
  "verdicts": [
    {"aId": "...", "bId": "...", "isAnalog": true, "confidence": 0.9, "reason": "краткое объяснение"}
  ]
}`;
}

export async function enrichPairsWithAI(
  items: MaterialInput[],
  pairs: SimilarityPair[]
): Promise<SimilarityPair[]> {
  if (pairs.length === 0) return pairs;
  const nameById = new Map(items.map((it) => [it.id, it.name]));

  // Ограничим количество пар для AI, чтобы не сжечь лимит токенов
  const MAX_PAIRS = 80;
  const toCheck = pairs.slice(0, MAX_PAIRS);
  const verdicts = new Map<string, AiVerdict>();

  for (let i = 0; i < toCheck.length; i += BATCH_SIZE) {
    const batch = toCheck.slice(i, i + BATCH_SIZE).map((p) => ({
      aId: p.aId,
      bId: p.bId,
      aName: nameById.get(p.aId) || "",
      bName: nameById.get(p.bId) || "",
    }));
    try {
      const prompt = buildPrompt(batch);
      const text = await gigachatComplete(prompt);
      const parsed = extractJson<{ verdicts: AiVerdict[] }>(text);
      for (const v of parsed.verdicts || []) {
        verdicts.set(`${v.aId}__${v.bId}`, v);
      }
    } catch (err) {
      console.error("AI batch error:", err);
      // продолжаем со следующей партией
    }
  }

  // Применяем вердикты к парам
  const result: SimilarityPair[] = [];
  for (const p of pairs) {
    const v = verdicts.get(`${p.aId}__${p.bId}`);
    if (!v) {
      // AI не оценил — оставляем как есть, без reason
      result.push(p);
      continue;
    }
    if (!v.isAnalog) {
      // AI отклонил — отбрасываем пару
      continue;
    }
    // AI подтвердил — обновляем уровень и добавляем обоснование
    let matchLevel: "duplicate" | "likely" | "possible" = p.matchLevel;
    if (v.confidence >= 0.9) matchLevel = "duplicate";
    else if (v.confidence >= 0.7) matchLevel = "likely";
    else matchLevel = "possible";
    result.push({
      ...p,
      matchLevel,
      reason: v.reason,
      similarity: Math.max(p.similarity, v.confidence),
    });
  }
  return result;
}

// Чистый AI-режим: даём модели весь список и просим самой найти группы.
// Применим только когда позиций мало (≤ 60), иначе → fallback на гибрид.
export async function analyzeListAI(
  items: MaterialInput[]
): Promise<SimilarityPair[]> {
  if (items.length > 60) {
    throw new Error(
      "Чистый AI-режим поддерживает до 60 позиций. Для больших списков используйте гибридный режим."
    );
  }
  const list = items
    .map((it) => `${it.id}: "${it.name}"${it.code ? ` [${it.code}]` : ""}`)
    .join("\n");

  const prompt = `Ты — эксперт по закупкам. Проанализируй список номенклатурных позиций и найди среди них дубликаты и взаимозаменяемые аналоги.

ПРАВИЛА:
- Дубликат — один и тот же товар, записанный по-разному (опечатки, сокращения, перестановка слов).
- Аналог — взаимозаменяемый товар (одинаковые характеристики, разные производители).
- Разные размеры/типоразмеры — НЕ аналоги.

СПИСОК (формат: id: "наименование"):
${list}

Найди все пары похожих позиций. Верни СТРОГО JSON:
{
  "pairs": [
    {"aId": "...", "bId": "...", "matchLevel": "duplicate", "confidence": 0.95, "reason": "..."}
  ]
}
matchLevel: "duplicate" (тот же товар), "likely" (точный аналог), "possible" (заменитель).`;

  const text = await gigachatComplete(prompt);
  const parsed = extractJson<{
    pairs: {
      aId: string;
      bId: string;
      matchLevel: "duplicate" | "likely" | "possible";
      confidence: number;
      reason: string;
    }[];
  }>(text);
  return (parsed.pairs || []).map((p) => ({
    aId: p.aId,
    bId: p.bId,
    similarity: p.confidence,
    matchLevel: p.matchLevel,
    reason: p.reason,
  }));
}
