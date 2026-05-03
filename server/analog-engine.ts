import https from "node:https";
import { randomUUID } from "node:crypto";
import type { MaterialInput, ProductInfo, Analog, AnalysisResult } from "@shared/schema";

// ===== GigaChat client =====
// Документация: https://developers.sber.ru/docs/ru/gigachat/api/reference/rest

const AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const CHAT_URL = "https://gigachat.devices.sberbank.ru/api/v1/chat/completions";

// Сбер использует свой корневой сертификат (Минцифры), которого нет в Node CA-bundle.
// На сервере поднимем агент с rejectUnauthorized=false. Это безопасно — мы стучимся
// только в домены sberbank.ru, и других путей нет.
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const AUTH_KEY = process.env.GIGACHAT_AUTH_KEY || "";
const SCOPE = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS";
// Возможные модели: GigaChat, GigaChat-Pro, GigaChat-Max
const MODEL = process.env.GIGACHAT_MODEL || "GigaChat";

let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (!AUTH_KEY) {
    throw new Error(
      "Не задан GIGACHAT_AUTH_KEY. Получите ключ авторизации в личном кабинете GigaChat (developers.sber.ru/gigachat) и пропишите его в переменные окружения."
    );
  }
  const now = Date.now();
  if (cachedToken && cachedToken.expires_at > now + 60_000) {
    return cachedToken.access_token;
  }

  const body = new URLSearchParams({ scope: SCOPE }).toString();
  const res = await rawHttpsRequest(
    "POST",
    AUTH_URL,
    {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      RqUID: randomUUID(),
      Authorization: `Basic ${AUTH_KEY}`,
    },
    body
  );

  if (res.status >= 400) {
    const text = await res.text();
    throw new Error(`Ошибка авторизации GigaChat: ${res.status} ${text}`);
  }
  const data: any = await res.json();
  cachedToken = {
    access_token: data.access_token,
    expires_at: data.expires_at * 1000,
  };
  return cachedToken.access_token;
}

// Резервный HTTPS-запрос через Node https-модуль (с отключённой проверкой сертификата)
function rawHttpsRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ status: number; json: () => Promise<any>; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method,
        host: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers,
        agent: httpsAgent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode || 0,
            json: async () => JSON.parse(text),
            text: async () => text,
          });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function rawHttpsRequestWith429Retry(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
  maxRetries = 4,
  baseDelayMs = 1500
): Promise<{ status: number; json: () => Promise<any>; text: () => Promise<string> }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await rawHttpsRequest(method, url, headers, body);

    if (res.status !== 429) {
      return res;
    }

    if (attempt === maxRetries) {
      return res;
    }

    const backoffMs = baseDelayMs * Math.pow(2, attempt);
    const jitterMs = Math.floor(Math.random() * 400);
    const delayMs = backoffMs + jitterMs;

    console.warn(`GigaChat 429. Retry ${attempt + 1}/${maxRetries} in ${delayMs} ms`);

    await sleep(delayMs);
  }

  throw new Error("Unexpected retry flow");
}

export async function gigachatComplete(prompt: string): Promise<string> {
  const token = await getAccessToken();
  const payload = JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: 4096,
  });

  const res = await rawHttpsRequestWith429Retry(
    "POST",
    CHAT_URL,
    {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    payload
  );

  if (res.status >= 400) {
    const text = await res.text();
    throw new Error(`GigaChat ${res.status}: ${text}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Пустой ответ GigaChat");
  return content as string;
}

// ===== Логика подбора аналогов =====

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.,%/×x-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function similarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

function findInternalMatches(
  analogName: string,
  catalog: { code?: string; name: string }[]
): { code?: string; name: string; similarity: number } | null {
  if (!catalog || catalog.length === 0) return null;
  let best: { code?: string; name: string; similarity: number } | null = null;
  for (const c of catalog) {
    const sim = similarity(analogName, c.name);
    if (!best || sim > best.similarity) {
      best = { code: c.code, name: c.name, similarity: sim };
    }
  }
  if (best && best.similarity >= 0.35) return best;
  return null;
}

export function extractJson<T>(text: string): T {
  // GigaChat иногда оборачивает JSON в ```json ... ``` блок
  const cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Модель не вернула JSON");
  return JSON.parse(match[0]) as T;
}

export async function analyzeMaterial(
  item: MaterialInput,
  catalog: { code?: string; name: string }[] = []
): Promise<AnalysisResult> {
  try {
    const catalogHint =
      catalog.length > 0
        ? `\n\nВНУТРЕННИЙ СПРАВОЧНИК НОМЕНКЛАТУРЫ (${catalog.length} позиций, показаны первые 100):\n${catalog
            .slice(0, 100)
            .map((c, i) => `${i + 1}. ${c.code ? `[${c.code}] ` : ""}${c.name}`)
            .join("\n")}\n`
        : "";

    const prompt = `Ты — эксперт по закупкам и снабжению. Тебе дана позиция из номенклатурного списка.

ПОЗИЦИЯ:
Наименование: "${item.name}"${item.code ? `\nКод/артикул: ${item.code}` : ""}

ЗАДАЧА:
1. Определи что это за товар (категория, назначение).
2. Укажи типовые технические характеристики.
3. Назови вероятных производителей и бренды на российском рынке и СНГ.
4. Оцени примерный ценовой диапазон в рублях.
5. Предложи 4-6 аналогов от других производителей. Для каждого укажи:
   - "full" — полностью взаимозаменяемый,
   - "partial" — с незначительными отличиями,
   - "substitute" — заменитель для той же задачи.${catalogHint}

ВЕРНИ СТРОГО JSON без markdown, без пояснений вне JSON. Формат:
{
  "info": {
    "title": "нормализованное название",
    "description": "описание и назначение (2-4 предложения)",
    "manufacturer": "наиболее вероятный производитель или null",
    "brand": "бренд или null",
    "specs": [{"label": "Параметр", "value": "Значение"}],
    "priceRange": "например 'от 1 200 до 2 400 ₽' или null",
    "suppliers": [{"name": "Поставщик", "url": null, "price": "ориентировочно"}],
    "sources": []
  },
  "analogs": [
    {
      "name": "полное наименование аналога",
      "manufacturer": "производитель",
      "brand": "бренд или null",
      "reason": "почему это аналог",
      "matchLevel": "full",
      "price": "ориентировочная цена или null",
      "supplierUrl": null
    }
  ]
}`;

    const text = await gigachatComplete(prompt);
    const parsed = extractJson<{ info: ProductInfo; analogs: Analog[] }>(text);

    const analogs = (parsed.analogs || []).map((a) => ({
      ...a,
      internalMatch: findInternalMatches(a.name, catalog),
    }));

    return {
      input: item,
      status: "done",
      error: null,
      info: parsed.info,
      analogs,
    };
  } catch (err: any) {
    return {
      input: item,
      status: "error",
      error: err?.message || "Ошибка обработки",
      info: null,
      analogs: [],
    };
  }
}
