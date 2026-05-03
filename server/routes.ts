import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import multer from "multer";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import { GROUP_COLORS, getGroupColor } from "@shared/group-colors";
import {
  analyzeRequestSchema,
  listAnalysisRequestSchema,
  materialInputSchema,
} from "@shared/schema";
import type {
  AnalysisResult,
  ListAnalysisResult,
  MaterialInput,
} from "@shared/schema";
import { analyzeMaterial } from "./analog-engine";
import {
  analyzeListFast,
  findAnalogsForItem,
  buildGroupsFromPairs,
} from "./list-grouper";
import { enrichPairsWithAI, analyzeListAI } from "./list-ai-enricher";
import { z } from "zod";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// Парсим Excel/CSV и пытаемся найти колонки "наименование" и "код"
function parseNomenclatureFile(
  buffer: Buffer
): { code?: string; name: string }[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });
  if (rows.length === 0) return [];

  // Ищем строку заголовков (первая строка c текстом)
  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const cells = rows[i].map((c: any) => String(c ?? "").toLowerCase());
    if (cells.some((c: string) => /наим|матери|товар|позиц|description|name/i.test(c))) {
      headerIdx = i;
      break;
    }
  }

  const header = rows[headerIdx].map((c: any) => String(c ?? "").toLowerCase());
  let nameCol = header.findIndex((c: string) =>
    /наимен|назван|материал|товар|позиц|product|name|description/i.test(c)
  );
  let codeCol = header.findIndex((c: string) =>
    /код|артикул|номенк|sku|code|number|№/i.test(c)
  );

  // Если не нашли — берём первую колонку как наименование, вторую как код (если есть)
  const single =
    header.filter((c: string) => c.trim()).length === 0 ||
    (nameCol === -1 && codeCol === -1);
  if (single) {
    nameCol = 0;
    codeCol = rows[headerIdx].length > 1 ? 1 : -1;
    headerIdx = -1; // данные начинаются с 0
  }

  const out: { code?: string; name: string }[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const name = String(row[nameCol] ?? "").trim();
    if (!name) continue;
    const code = codeCol >= 0 ? String(row[codeCol] ?? "").trim() : "";
    out.push(code ? { code, name } : { name });
  }
  return out;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // ---- Загрузка файла со списком материалов ----
  app.post(
    "/api/parse-file",
    upload.single("file"),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) {
          return res.status(400).json({ message: "Файл не загружен" });
        }
        const items = parseNomenclatureFile(req.file.buffer);
        if (items.length === 0) {
          return res
            .status(400)
            .json({ message: "Не удалось распознать позиции в файле" });
        }
        return res.json({ items });
      } catch (err: any) {
        console.error("parse-file error", err);
        return res
          .status(500)
          .json({ message: err?.message || "Ошибка разбора файла" });
      }
    }
  );

  // ---- Стриминг анализа: SSE, чтобы показывать прогресс по мере готовности ----
  app.post("/api/analyze-stream", async (req: Request, res: Response) => {
    const parsed = analyzeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: "Неверный формат запроса", details: parsed.error });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const send = (event: string, data: any) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const { items, catalog = [] } = parsed.data;
    send("start", { total: items.length });

    // Обрабатываем параллельно небольшими пачками
    const concurrency = 3;
    let idx = 0;
    const results: AnalysisResult[] = [];
    async function worker() {
      while (idx < items.length) {
        const my = idx++;
        const item = items[my];
        send("progress", { id: item.id, status: "searching" });
        const result = await analyzeMaterial(item, catalog);
        results[my] = result;
        send("result", result);
      }
    }
    try {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, () =>
          worker()
        )
      );
      send("done", { count: results.length });
    } catch (err: any) {
      send("error", { message: err?.message || "Ошибка анализа" });
    } finally {
      res.end();
    }
  });

  // ---- Экспорт результатов в Excel ----
  app.post("/api/export", async (req: Request, res: Response) => {
    try {
      const results: AnalysisResult[] = req.body?.results || [];
      if (!Array.isArray(results) || results.length === 0) {
        return res.status(400).json({ message: "Нет данных для экспорта" });
      }

      // Лист 1: сводная таблица (позиция + найденные аналоги)
      const flatRows: any[] = [];
      for (const r of results) {
        if (!r.analogs || r.analogs.length === 0) {
          flatRows.push({
            "Исходный код": r.input.code || "",
            "Исходное наименование": r.input.name,
            "Распознано как": r.info?.title || "",
            "Производитель": r.info?.manufacturer || "",
            "Ценовой диапазон": r.info?.priceRange || "",
            "Аналог": "",
            "Производитель аналога": "",
            "Уровень соответствия": "",
            "Обоснование": "",
            "Цена аналога": "",
            "Совпадение со справочником": "",
            "Код из справочника": "",
            "Статус": r.status === "error" ? `Ошибка: ${r.error}` : "Аналоги не найдены",
          });
          continue;
        }
        for (const a of r.analogs) {
          flatRows.push({
            "Исходный код": r.input.code || "",
            "Исходное наименование": r.input.name,
            "Распознано как": r.info?.title || "",
            "Производитель": r.info?.manufacturer || "",
            "Ценовой диапазон": r.info?.priceRange || "",
            "Аналог": a.name,
            "Производитель аналога": a.manufacturer || "",
            "Уровень соответствия":
              a.matchLevel === "full"
                ? "Полный"
                : a.matchLevel === "partial"
                  ? "Частичный"
                  : "Заменитель",
            "Обоснование": a.reason,
            "Цена аналога": a.price || "",
            "Совпадение со справочником": a.internalMatch
              ? `${a.internalMatch.name} (${Math.round(a.internalMatch.similarity * 100)}%)`
              : "",
            "Код из справочника": a.internalMatch?.code || "",
            "Статус": "OK",
          });
        }
      }

      const wb = XLSX.utils.book_new();
      const ws1 = XLSX.utils.json_to_sheet(flatRows);
      ws1["!cols"] = Object.keys(flatRows[0] || {}).map(() => ({ wch: 28 }));
      XLSX.utils.book_append_sheet(wb, ws1, "Аналоги");

      // Лист 2: характеристики исходных позиций
      const specRows: any[] = [];
      for (const r of results) {
        if (!r.info) continue;
        for (const s of r.info.specs) {
          specRows.push({
            "Исходное наименование": r.input.name,
            "Характеристика": s.label,
            "Значение": s.value,
          });
        }
      }
      if (specRows.length > 0) {
        const ws2 = XLSX.utils.json_to_sheet(specRows);
        ws2["!cols"] = [{ wch: 50 }, { wch: 30 }, { wch: 30 }];
        XLSX.utils.book_append_sheet(wb, ws2, "Характеристики");
      }

      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="analogs-${Date.now()}.xlsx"`
      );
      res.send(buf);
    } catch (err: any) {
      console.error("export error", err);
      res.status(500).json({ message: err?.message || "Ошибка экспорта" });
    }
  });

  // ==========================================================
  // Поиск аналогов внутри списка номенклатуры
  // ==========================================================

  // ---- Анализ всего списка: дубликаты и группы взаимозаменяемых ----
  app.post("/api/analyze-list", async (req: Request, res: Response) => {
    const parsed = listAnalysisRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: "Неверный формат запроса", details: parsed.error });
    }
    const { items, mode, threshold } = parsed.data;
    try {
      // Быстрый алгоритм всегда первый — он отбирает кандидатов
      const fastResult = analyzeListFast(items, threshold);

      if (mode === "fast") {
        return res.json(fastResult);
      }

      if (mode === "hybrid") {
        // Просим AI оценить пары, найденные быстрым алгоритмом
        const enrichedPairs = await enrichPairsWithAI(items, fastResult.pairs);
        const result = buildGroupsFromPairs(items, enrichedPairs);
        return res.json(result);
      }

      if (mode === "ai") {
        // Чистый AI: сам анализирует список (только для небольших списков)
        if (items.length > 60) {
          // Большой список — fallback на гибрид
          const enrichedPairs = await enrichPairsWithAI(items, fastResult.pairs);
          const result = buildGroupsFromPairs(items, enrichedPairs);
          return res.json(result);
        }
        const aiPairs = await analyzeListAI(items);
        const result = buildGroupsFromPairs(items, aiPairs);
        return res.json(result);
      }

      return res.json(fastResult);
    } catch (err: any) {
      console.error("analyze-list error", err);
      return res
        .status(500)
        .json({ message: err?.message || "Ошибка анализа списка" });
    }
  });

  // ---- Поиск аналогов одной конкретной позиции среди остальных ----
  const findAnalogsRequestSchema = z.object({
    items: z.array(materialInputSchema).min(2),
    targetId: z.string(),
    threshold: z.number().min(0).max(1).default(0.4),
    limit: z.number().min(1).max(100).default(20),
  });

  app.post("/api/find-analogs-in-list", async (req: Request, res: Response) => {
    const parsed = findAnalogsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: "Неверный формат запроса", details: parsed.error });
    }
    const { items, targetId, threshold, limit } = parsed.data;
    try {
      const pairs = findAnalogsForItem(targetId, items, threshold, limit);
      return res.json({ pairs });
    } catch (err: any) {
      console.error("find-analogs-in-list error", err);
      return res
        .status(500)
        .json({ message: err?.message || "Ошибка поиска" });
    }
  });

  // ---- Экспорт результатов анализа списка в Excel ----
  app.post("/api/export-list", async (req: Request, res: Response) => {
    try {
      const { items, result } = req.body as {
        items: MaterialInput[];
        result: ListAnalysisResult;
      };
      if (!Array.isArray(items) || !result) {
        return res.status(400).json({ message: "Нет данных для экспорта" });
      }

      const itemById = new Map(items.map((it) => [it.id, it]));
      const groupByItemId = new Map<string, string>();
      const groupNumberById = new Map<string, number>();
      result.groups.forEach((g, idx) => {
        const num = idx + 1;
        groupNumberById.set(g.id, num);
        for (const id of g.itemIds) {
          groupByItemId.set(id, g.id);
        }
      });

      const levelLabel = (l: string) =>
        l === "duplicate"
          ? "Дубликат"
          : l === "likely"
            ? "Аналог"
            : "Заменитель";

      // Индекс группы по id для выбора цвета (порядковый номер — 0..n)
      const groupIndexById = new Map<string, number>();
      result.groups.forEach((g, idx) => groupIndexById.set(g.id, idx));

      const wb = new ExcelJS.Workbook();
      wb.creator = "Поиск аналогов";
      wb.created = new Date();

      // Лист 1: все позиции списка — подсвечены цветом группы
      const ws1 = wb.addWorksheet("Список с группами", {
        views: [{ state: "frozen", ySplit: 1 }],
      });
      ws1.columns = [
        { header: "№", key: "num", width: 6 },
        { header: "Код", key: "code", width: 18 },
        { header: "Наименование", key: "name", width: 55 },
        { header: "Группа", key: "group", width: 12 },
        { header: "Тип", key: "type", width: 14 },
        { header: "Представитель группы", key: "rep", width: 50 },
        { header: "Средняя схожесть", key: "sim", width: 18 },
      ];

      // Стиль заголовка
      ws1.getRow(1).font = { bold: true };
      ws1.getRow(1).alignment = { vertical: "middle" };
      ws1.getRow(1).height = 22;
      ws1.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF1F5F9" },
      };

      items.forEach((it, idx) => {
        const groupId = groupByItemId.get(it.id);
        const group = groupId
          ? result.groups.find((g) => g.id === groupId)
          : null;
        const groupIdx = group ? groupIndexById.get(group.id)! : -1;
        const row = ws1.addRow({
          num: idx + 1,
          code: it.code || "",
          name: it.name,
          group: group ? `Группа ${groupNumberById.get(group.id)}` : "",
          type: group ? levelLabel(group.matchLevel) : "",
          rep: group?.representative || "",
          sim: group ? `${Math.round(group.avgSimilarity * 100)}%` : "",
        });
        row.alignment = { vertical: "top", wrapText: true };
        if (group) {
          const color = getGroupColor(groupIdx);
          row.eachCell({ includeEmpty: true }, (cell) => {
            cell.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FF" + color.excelFill },
            };
            cell.border = {
              bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
            };
          });
          // Левая разметка — цветная граница для быстрого ориентирования
          const firstCell = row.getCell(1);
          firstCell.border = {
            ...firstCell.border,
            left: { style: "thick", color: { argb: "FF" + color.excelBorder } },
          };
        }
      });
      ws1.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: 7 },
      };

      // Лист 2: только группы (по одной строке на позицию), отсортированы по номеру группы
      if (result.groups.length > 0) {
        const ws2 = wb.addWorksheet("Группы", {
          views: [{ state: "frozen", ySplit: 1 }],
        });
        ws2.columns = [
          { header: "Группа", key: "group", width: 12 },
          { header: "Тип", key: "type", width: 14 },
          { header: "Код", key: "code", width: 18 },
          { header: "Наименование", key: "name", width: 55 },
          { header: "Размер группы", key: "size", width: 14 },
          { header: "Средняя схожесть", key: "sim", width: 18 },
        ];
        ws2.getRow(1).font = { bold: true };
        ws2.getRow(1).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF1F5F9" },
        };
        result.groups.forEach((g, gIdx) => {
          const num = groupNumberById.get(g.id);
          const color = getGroupColor(gIdx);
          for (const id of g.itemIds) {
            const it = itemById.get(id);
            if (!it) continue;
            const row = ws2.addRow({
              group: `Группа ${num}`,
              type: levelLabel(g.matchLevel),
              code: it.code || "",
              name: it.name,
              size: g.itemIds.length,
              sim: `${Math.round(g.avgSimilarity * 100)}%`,
            });
            row.alignment = { vertical: "top", wrapText: true };
            row.eachCell({ includeEmpty: true }, (cell) => {
              cell.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FF" + color.excelFill },
              };
              cell.border = {
                bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
              };
            });
            const firstCell = row.getCell(1);
            firstCell.border = {
              ...firstCell.border,
              left: { style: "thick", color: { argb: "FF" + color.excelBorder } },
            };
          }
        });
        ws2.autoFilter = {
          from: { row: 1, column: 1 },
          to: { row: 1, column: 6 },
        };
      }

      // Лист 3: все пары похожих позиций
      if (result.pairs.length > 0) {
        const ws3 = wb.addWorksheet("Пары", {
          views: [{ state: "frozen", ySplit: 1 }],
        });
        ws3.columns = [
          { header: "A — код", key: "aCode", width: 18 },
          { header: "A — наименование", key: "aName", width: 50 },
          { header: "B — код", key: "bCode", width: 18 },
          { header: "B — наименование", key: "bName", width: 50 },
          { header: "Схожесть", key: "sim", width: 12 },
          { header: "Тип", key: "type", width: 14 },
          { header: "Обоснование", key: "reason", width: 50 },
        ];
        ws3.getRow(1).font = { bold: true };
        ws3.getRow(1).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF1F5F9" },
        };
        for (const p of result.pairs) {
          const row = ws3.addRow({
            aCode: itemById.get(p.aId)?.code || "",
            aName: itemById.get(p.aId)?.name || p.aId,
            bCode: itemById.get(p.bId)?.code || "",
            bName: itemById.get(p.bId)?.name || p.bId,
            sim: `${Math.round(p.similarity * 100)}%`,
            type: levelLabel(p.matchLevel),
            reason: p.reason || "",
          });
          row.alignment = { vertical: "top", wrapText: true };
        }
        ws3.autoFilter = {
          from: { row: 1, column: 1 },
          to: { row: 1, column: 7 },
        };
      }

      // Лист 4: Легенда цветов
      if (result.groups.length > 0) {
        const ws4 = wb.addWorksheet("Легенда");
        ws4.columns = [
          { header: "Цвет", key: "swatch", width: 14 },
          { header: "Группа", key: "group", width: 12 },
          { header: "Тип", key: "type", width: 14 },
          { header: "Представитель", key: "rep", width: 55 },
          { header: "Позиций", key: "size", width: 12 },
        ];
        ws4.getRow(1).font = { bold: true };
        result.groups.forEach((g, gIdx) => {
          const num = groupNumberById.get(g.id);
          const color = getGroupColor(gIdx);
          const row = ws4.addRow({
            swatch: "",
            group: `Группа ${num}`,
            type: levelLabel(g.matchLevel),
            rep: g.representative,
            size: g.itemIds.length,
          });
          row.getCell(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF" + color.excelFill },
          };
          row.getCell(1).border = {
            left: { style: "thick", color: { argb: "FF" + color.excelBorder } },
            right: { style: "thin", color: { argb: "FFE5E7EB" } },
            top: { style: "thin", color: { argb: "FFE5E7EB" } },
            bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
          };
        });
      }

      const buf = (await wb.xlsx.writeBuffer()) as Buffer;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="list-analysis-${Date.now()}.xlsx"`
      );
      res.send(Buffer.from(buf));
    } catch (err: any) {
      console.error("export-list error", err);
      res.status(500).json({ message: err?.message || "Ошибка экспорта" });
    }
  });

  return httpServer;
}
