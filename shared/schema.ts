import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Пользователи (оставлены для совместимости с шаблоном)
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// ========= Типы для поиска аналогов =========

// Один исходный материал из списка (то, что вводит/загружает пользователь)
export const materialInputSchema = z.object({
  id: z.string(), // локальный id (uuid/индекс)
  name: z.string().min(1),
  code: z.string().optional(), // артикул/код из SAP, необязательный
});
export type MaterialInput = z.infer<typeof materialInputSchema>;

// Информация о товаре, найденная в интернете
export const productInfoSchema = z.object({
  title: z.string(), // нормализованное название
  description: z.string(), // описание/назначение
  manufacturer: z.string().nullable(), // производитель
  brand: z.string().nullable(), // бренд
  specs: z.array(z.object({
    label: z.string(),
    value: z.string(),
  })), // технические характеристики (пары)
  priceRange: z.string().nullable(), // например "от 1 200 ₽ до 2 400 ₽"
  suppliers: z.array(z.object({
    name: z.string(),
    url: z.string().nullable(),
    price: z.string().nullable(),
  })),
  sources: z.array(z.object({
    title: z.string(),
    url: z.string(),
  })),
});
export type ProductInfo = z.infer<typeof productInfoSchema>;

// Аналог
export const analogSchema = z.object({
  name: z.string(), // наименование аналога
  manufacturer: z.string().nullable(),
  brand: z.string().nullable(),
  reason: z.string(), // почему это аналог (обоснование сопоставимости)
  matchLevel: z.enum(["full", "partial", "substitute"]), // полный / частичный / заменитель
  price: z.string().nullable(),
  supplierUrl: z.string().nullable(),
  // Совпадение с внутренним справочником, если есть
  internalMatch: z.object({
    code: z.string().optional(),
    name: z.string(),
    similarity: z.number(), // 0..1
  }).nullable(),
});
export type Analog = z.infer<typeof analogSchema>;

// Итог анализа одной позиции
export const analysisResultSchema = z.object({
  input: materialInputSchema,
  status: z.enum(["pending", "searching", "done", "error"]),
  error: z.string().nullable(),
  info: productInfoSchema.nullable(),
  analogs: z.array(analogSchema),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

// Запросы API
export const analyzeRequestSchema = z.object({
  items: z.array(materialInputSchema).min(1),
  catalog: z.array(z.object({
    code: z.string().optional(),
    name: z.string(),
  })).optional(), // внутренний справочник номенклатуры
});
export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;

// ========= Типы для поиска аналогов внутри списка =========

// Пара «похожих» позиций внутри списка
export const similarityPairSchema = z.object({
  aId: z.string(),
  bId: z.string(),
  similarity: z.number(),
  matchLevel: z.enum(["duplicate", "likely", "possible"]),
  reason: z.string().optional(),
});
export type SimilarityPair = z.infer<typeof similarityPairSchema>;

// Группа взаимозаменяемых позиций
export const analogGroupSchema = z.object({
  id: z.string(),
  itemIds: z.array(z.string()),
  representative: z.string(),
  matchLevel: z.enum(["duplicate", "likely", "possible"]),
  avgSimilarity: z.number(),
});
export type AnalogGroup = z.infer<typeof analogGroupSchema>;

// Режим анализа
export const listAnalysisModeSchema = z.enum(["fast", "ai", "hybrid"]);
export type ListAnalysisMode = z.infer<typeof listAnalysisModeSchema>;

// Запрос на анализ списка
export const listAnalysisRequestSchema = z.object({
  items: z.array(materialInputSchema).min(2),
  mode: listAnalysisModeSchema.default("fast"),
  threshold: z.number().min(0).max(1).default(0.55),
});
export type ListAnalysisRequest = z.infer<typeof listAnalysisRequestSchema>;

// Результат анализа списка
export const listAnalysisResultSchema = z.object({
  groups: z.array(analogGroupSchema),
  pairs: z.array(similarityPairSchema),
  ungroupedIds: z.array(z.string()),
  stats: z.object({
    total: z.number(),
    grouped: z.number(),
    duplicates: z.number(),
    likely: z.number(),
    possible: z.number(),
  }),
});
export type ListAnalysisResult = z.infer<typeof listAnalysisResultSchema>;
